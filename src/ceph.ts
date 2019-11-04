import {cfg, Deployment, Snapshot, Volume} from "./cfg";
import {spawn} from "child_process";
import q from 'q';
import {log} from "./log";
import dateFormat from 'dateformat';
import {report} from "./utils";
import {Semaphore} from 'await-semaphore';
import moment from 'moment';
import * as k8s from '@kubernetes/client-node';
import {V1Deployment, V1Pod, V1StatefulSet} from '@kubernetes/client-node';
import * as streamBuffers from 'stream-buffers';
import DurationConstructor = moment.unitOfTime.DurationConstructor;

interface INamespace {
  persistentVolumeClaims: k8s.V1PersistentVolumeClaim[],
  pods: V1Pod[],
  deployments: V1Deployment[],
  statefulSets: V1StatefulSet[],
}

export class Ceph {

  // k8s model by namespace
  model: Map<string,INamespace> = new Map<string, INamespace>();

  // name of the rook-ceph-tools pod
  toolbox : string;

  execSemaphore: Semaphore = new Semaphore(cfg.semaphore.exec);
  operatorSemaphore: Semaphore = new Semaphore(cfg.semaphore.operator);
  backupSemaphore: Semaphore = new Semaphore(cfg.semaphore.backup);

  k8sConfig: k8s.KubeConfig;
  k8sClient: k8s.CoreV1Api;
  k8sClientApps: k8s.AppsV1Api;
  k8sExec: k8s.Exec;


  constructor() {
    this.initializeKubernetesClient();
  }

  initializeKubernetesClient() {
    let config = new k8s.KubeConfig();
    config.loadFromFile(cfg.kubectl.config);

    let core = config.makeApiClient(k8s.CoreV1Api);
    let apps = config.makeApiClient(k8s.AppsV1Api);
    let exec = new k8s.Exec(config);

    this.k8sConfig = config;
    this.k8sClient = core;
    this.k8sClientApps = apps;
    this.k8sExec = exec;
  }


  async processAllDeployments(action: (d:Deployment)=>void) {
    await Promise.all([
      await this.resolveToolbox(),
      await Object.keys(cfg.deployments).forEachAsync(async (namespace) =>
        await this.loadNamespaceModel(namespace)),
    ]);
    await Object.keys(cfg.deployments).forEachAsync(async (namespace) =>
      await Object.keys(cfg.deployments[namespace]).forEachAsync(async (deployment) => {
        await action(new Deployment(deployment, namespace));
      }));
  }

  async processAllVolumes(action: (vol: Volume) => void) {
    await this.processAllDeployments(async (deployment) => {
      await this.resolveVolumes(deployment);
      await deployment.volumes.forEachAsync(async (x) =>
        await action(x)
      )
    });
  }

  async createSnapshotAll() {
    await this.processAllVolumes(async (vol) =>
      await this.createSnapshot(vol));
  }

  async createSnapshot(vol: Volume) {
    let now = new Date(Date.now());
    let date = dateFormat(now, 'yyyymmdd-HHMM');
    let snap = `${date}-k8s-live`;
    let deployment = vol.deployment;
    log.debug('Creating snapshot %s for image %s (namespace=%s, deployment=%s, pvc=%s)',
      snap, vol.pv, deployment.namespace, deployment.name, vol.pvc);
    await this.invokeToolbox(`rbd snap create -p ${cfg.backup.pool} --image=${vol.pv} --snap=${snap}`);
  }

  async backupVolumeAll() {
    await this.processAllVolumes(async (vol) =>
      await this.backupVolume(vol));
    await this.report();
  }

  async backupVolume(vol: Volume) {
    let dir = vol.getDirectory();
    let actions = new Array<()=>void>();
    let previous: string;
    vol.snapshots.forEach(x => {
      let from = previous;
      actions.push(async () => await this.backupSnapshot(vol.pv, from, x.name, dir).catch(report));
      previous = x.name;
    });
    await actions.forEachAsync(async action => await action());
  }

  async consolidateAll() {
    await this.processAllVolumes(async (vol) =>
      await this.consolidate(vol));
    await this.report();
  }

  async consolidate(vol: Volume) {

    let snaps = vol.snapshots;
    let consolidated = this.consolidateSnapshots(snaps);
    let evicted = snaps.filter(x => !consolidated.contains(x));

    let evictedFiles = evicted.map(x => x.getFileName());
    let outdatedFiles= consolidated
      .filter(x => consolidated.previous(x) != snaps.previous(x))
      .map(x => x.getFileName());

    let dir = vol.getDirectory();
    let deletedFiles = evictedFiles.concat(outdatedFiles);

    await Promise.all([
      // remove evicted snapshots
      this.removeSnapshots(vol, evicted),

      // delete backup files for evicted and outdated snapshots
      this.invokeToolbox(`cd ${dir} && rm -fv ${deletedFiles.join(' ')}`),
    ]);

    // commit consolidated list & launch backup
    vol.snapshots = consolidated;

    await this.backupVolume(vol);
  }

  consolidateSnapshots(snaps: Snapshot[]) : Snapshot[] {
    if (snaps.length == 0) return snaps; // nothing to do here

    let first = snaps.first();

    let daily = this.electDailySnapshots(snaps);
    let weekly = this.electWeeklySnapshots(snaps, daily);
    let monthly = this.electMonthlySnapshots(snaps, weekly);

    let isFirstSnapshotEvicted = !daily.contains(first) && !weekly.contains(first) && !monthly.contains(first);
    let isMonthlyBaselineElected = monthly.length > 0;

    // do not drop existing baseline if there is no successor (new monthly baseline)
    if (!isMonthlyBaselineElected && isFirstSnapshotEvicted) monthly.push(first);

    let result = monthly.concat(weekly).concat(daily);

    return result;
  }

  electDailySnapshots(snaps: Snapshot[]) : Snapshot[] {
    let idx = new Map();
    snaps.forEach(x => idx.set(dateFormat(x.timestamp, 'yyyymmdd'), x));
    let candidates = Array.from(idx.values());
    candidates = snaps.filter(x => candidates.contains(x));
    let result = this.electSnapshots(candidates, "day", cfg.backup.daily);
    return result;
  }

  electWeeklySnapshots(snaps: Snapshot[], daily: Snapshot[]) : Snapshot[] {
    let max = (daily.first() || snaps.first()).timestamp;
    let candidates = snaps.filter(x => x.timestamp.getDay() == 0 && x.timestamp.getTime() < max.getTime());
    return this.electSnapshots(candidates, "week", cfg.backup.weekly);
  }

  electMonthlySnapshots(snaps: Snapshot[], weekly: Snapshot[]) : Snapshot[] {
    let max = (weekly.first() || snaps.first()).timestamp;
    let candidates = snaps.filter(x => x.timestamp.getDate() == 1 && x.timestamp.getTime() < max.getTime());
    return this.electSnapshots(candidates, "month", cfg.backup.monthly);
  }

  electSnapshots(snaps: Snapshot[], duration: DurationConstructor, limit: number) {
    let result: Snapshot[] = [];
    snaps.forEach(x => {
      if (result.length == 0) { result.push(x); return; }

      let last = result.last();
      if (moment(x.timestamp).diff(moment(last.timestamp), duration) > 0)
        result.push(x);
    });

    if (result.length > limit) result = result.slice(result.length - limit);

    return result;
  }

  async removeSnapshots(vol: Volume, snaps: Snapshot[]) {
    let names = snaps.map(x => x.name);
    log.debug('Removing %d snapshots {pvc: %s, pv: %s} : [%s]', snaps.length, vol.pvc, vol.pv, names.join(','));
    await this.invokeToolbox(`
      for i in ${names.join(' ')}; do      
        rbd -p ${cfg.backup.pool} --image=${vol.pv} snap rm --snap=$i
      done 
    `);
  }

  getNamespaceModel(namespace: string) : INamespace {
    return this.model.get(namespace);
  }

  async loadNamespaceModel(namespace: string) {
    log.debug('Loading namespace %s', namespace);

    function unbox(x: any) {
      return x.body.items.filter(i => i.metadata);
    }

    let [ pvcs, pods, statefulSets, deployments ] = await Promise.all([
      this.k8sClient.listNamespacedPersistentVolumeClaim(namespace).then(unbox),
      this.k8sClient.listNamespacedPod(namespace).then(unbox),
      this.k8sClientApps.listNamespacedStatefulSet(namespace).then(unbox),
      this.k8sClientApps.listNamespacedDeployment(namespace).then(unbox),
    ]);

    let model: INamespace = {
      persistentVolumeClaims: pvcs,
      pods: pods,
      deployments: deployments,
      statefulSets: statefulSets
    };

    this.model.set(namespace, model);

    return model;
  }

  isMatchLabels(selector:any, labels:any) : boolean {
    let keys = Object.keys(selector);
    let matching = keys.filter(k => selector[k] === labels[k]);
    return matching.length == keys.length;
  }

  async resolveVolumes(deployment: Deployment) : Promise<Volume[]> {
    if (deployment.volumes) return deployment.volumes;

    let model = this.getNamespaceModel(deployment.namespace);

    let deployments = [].concat(model.deployments).concat(model.statefulSets)
      //.filter(x => x.kind.match('Deployment|StatefulSet'))
      .find(x => x.metadata.name == deployment.name);
    let sel = deployments.spec.selector.matchLabels;
    let pods = model.pods
      //.filter(x => x.kind.match('Pod'))
      .filter(x => this.isMatchLabels(sel, x.metadata.labels));
    let claims = pods.map(x => x.spec.volumes
      .filter(v => v.persistentVolumeClaim)
      .map(v => v.persistentVolumeClaim.claimName)
    ).flat();

    let vols = claims.map(c => model.persistentVolumeClaims
      //.filter(x => x.kind.match('PersistentVolumeClaim'))
      .filter(x => x.metadata.name == c)
      .filter(x => x.spec.storageClassName == cfg.backup.storageClassName)
      .map(x => new Volume({
        deployment: deployment,
        pvc: x.metadata.name,
        pv: x.spec.volumeName,
      }))
    ).flat();

    await vols.forEachAsync(async v => await this.resolveSnapshots(v));

    return deployment.volumes = vols;
  }

  async resolveSnapshots(vol: Volume) : Promise<Snapshot[]> {
    if (vol.snapshots) return vol.snapshots;

    log.debug(
      'Resolving snapshots {namespace: %s, deployment: %s, pvc: %s, pv: %s}',
      vol.deployment.namespace, vol.deployment.name, vol.pvc, vol.pv);

    for (let i=1, attempts=2; i<=attempts; i++) {
      let json = await this.invokeToolbox(`rbd -p ${cfg.backup.pool} --image=${vol.pv} snap ls --format=json`);
      if (json.trim().length == 0) {
        log.warn('Attempt %s/%s: Failed to resolve snapshots.', i, attempts);
        continue;
      }
      vol.snapshots = JSON.parse(json).map(x => new Snapshot({
        name: x.name,
        timestamp: moment(x.name, 'YYYYMMDD-HHmm').toDate(), //don't rely on x.timestamp, it may be invalid if snapshot is imported
        volume: vol,
      }));
      break;
    }

    return vol.snapshots;
  }

  async backupSnapshot(image: string, fromSnapshot: string, snapshot: string, directory: string) {
    await this.backupSemaphore.use(async () => {
      let suffix = fromSnapshot ? `.since-${fromSnapshot}` : '';
      let path = `${directory}/${snapshot}${suffix}.gz`;
      let tmp = `${path}.tmp`;
      let rbdFromSnap = fromSnapshot ? `--from-snap=${fromSnapshot}` : '';
      let rbdSnap = snapshot ? `--snap=${snapshot}` : '';

      for (let i=1, attempts=2; i<=attempts; i++) {

        let result = await this.invokeToolbox(`
          [[ -f ${tmp} ]] && echo "File exists : ${tmp}. Another backup in progress?" >&2 && exit 1
          [[ -f ${path} ]] && echo "File exists: ${path}" && exit
          mkdir -p ${directory}    
          rbd -p ${cfg.backup.pool} --image ${image} export-diff ${rbdFromSnap} ${rbdSnap} - | gzip > ${tmp} && 
            mv ${tmp} ${path} &&
            echo "File created: $(du -h ${path})"
          `
        );

        if (result.trim().length == 0) {
          log.warn(`Attempt ${i}/${attempts}: Suspicious empty output for backup: ${path}`);
          continue;
        }

        log.debug(result.trim());
        break;
      }
    });
  }

  env() {
    let proxy = cfg.proxy.host ? `http://${cfg.proxy.host}:${cfg.proxy.port}` : '';
    return {
      KUBECONFIG: cfg.kubectl.config,
      //HTTPS_PROXY: proxy,
    }
  }

  async exec(command, args) : Promise<string> {
    return await this.execSemaphore.use(async () => {
      let opts = { env: this.env() };
      let proc = spawn(command, args, opts);
      let deferred = q.defer();
      let buf = Buffer.from('');
      let errbuf = Buffer.from('');
      let result;
      proc.stdout.on('data', data => buf += data);
      proc.stderr.on('data', data => errbuf += data);
      proc.on('exit', (code) => {
        result = code;
        deferred.resolve();
      });
      await deferred.promise;
      if (result != 0) throw new Error(`Exit code: ${result}. Errors: ${errbuf}. Output: ${buf}`);
      return buf.toString();
    });
  }

  async scriptexec(script: string) : Promise<string> {
    return await this.exec("bash", ["-c", script]);
  }

  async podexec(namespace, pod, container, script) : Promise<string> {

    let stdout = new streamBuffers.WritableStreamBuffer();
    let stderr = new streamBuffers.WritableStreamBuffer();
    let deferred = q.defer();
    let output: string;
    let error: string;
    let code: number;
    await this.k8sExec.exec(
      namespace,
      pod,
      container,
      ['bash', '-c', script],
      stdout,
      stderr,
      null /*stdin*/,
      false /*tty*/,
      (x: k8s.V1Status) => {
        output = stdout.getContentsAsString();
        if (x.status == 'Failure') {
          error = stderr.getContentsAsString();
          code = parseInt(x.details.causes.find(c => c.reason == 'ExitCode').message);
        }

        deferred.resolve();
      }
    ).catch(e => {
      throw e;
    });
    await deferred.promise;

    if (code && code != 0) {
      throw new Error(`Failed! Code: ${code}. Errors: ${error.trim()}. Script: ${script}`);
    }

    return output;
  }

  async resolveToolbox() {
    log.debug('Resolving rook-ceph-tools pod...');
    this.toolbox = await this.k8sClient.listNamespacedPod('rook-ceph')
      .then(x => x.body.items
        .filter(x => x.metadata)
        .filter(x => this.isMatchLabels({app: 'rook-ceph-tools'}, x.metadata.labels))
        .map(x => x.metadata.name)
        .first());
  }

  async invokeToolbox(script: string) : Promise<string> {
    return await this.operatorSemaphore.use(async () =>
      await this.podexec("rook-ceph", this.toolbox, 'rook-ceph-tools', script));
  }

  async report() {
    let report = await this.invokeToolbox(`
      cd ${cfg.backup.path} 
      find * -type f | sort | xargs ls -sh
      df -h $PWD
    `);
    log.debug('File report:\n%s', report);
  }

}
