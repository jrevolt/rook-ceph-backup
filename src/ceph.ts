import {cfg, Deployment, Snapshot, Volume} from "./cfg";
import {spawn} from "child_process";
import q from 'q';
import {log} from "./log";
import dateFormat from 'dateformat';
import {report} from "./utils.js";
import {Semaphore} from 'await-semaphore';
import moment from 'moment';
import DurationConstructor = moment.unitOfTime.DurationConstructor;

export class Ceph {

  // k8s model by namespace
  model: Map<string,any> = new Map<string, any>();

  // name of the rook-ceph-operator pod
  operator : string;

  execSemaphore: Semaphore = new Semaphore(cfg.semaphore.exec);
  operatorSemaphore: Semaphore = new Semaphore(cfg.semaphore.operator);
  backupSemaphore: Semaphore = new Semaphore(cfg.semaphore.backup);

  async processAllDeployments(action: (d:Deployment)=>void) {
    await Promise.all([
      await this.resolveOperator(),
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
    await this.invokeOperator(`rbd snap create -p ${cfg.backup.pool} --image=${vol.pv} --snap=${snap}`);
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
      this.invokeOperator(`cd ${dir} && rm -fv ${deletedFiles.join(' ')}`),
    ]);

    // commit consolidated list & launch backup
    vol.snapshots = consolidated;

    await this.backupVolume(vol);
  }

  consolidateSnapshots(snaps: Snapshot[]) {
    let daily = this.electDailySnapshots(snaps);
    let weekly = this.electWeeklySnapshots(snaps, daily);
    let monthly = this.electMonthlySnapshots(snaps, weekly);
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
    await this.invokeOperator(`
      for i in ${names.join(' ')}; do      
        rbd -p ${cfg.backup.pool} --image=${vol.pv} snap rm --snap=$i
      done 
    `);
  }

  getNamespaceModel(namespace: string) {
    return this.model.get(namespace);
  }

  async loadNamespaceModel(namespace: string) {
    log.debug('Loading namespace %s', namespace);
    let json = await this.scriptexec(`kubectl -n ${namespace} get deployment,statefulset,pod,pvc -o json`);
    let model = JSON.parse(json);
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

    let deployments = model.items
      .filter(x => x.kind.match('Deployment|StatefulSet'))
      .find(x => x.metadata.name == deployment.name);
    let sel = deployments.spec.selector.matchLabels;
    let pods = model.items
      .filter(x => x.kind.match('Pod'))
      .filter(x => this.isMatchLabels(sel, x.metadata.labels));
    let claims = pods.map(x => x.spec.volumes
      .filter(v => v.persistentVolumeClaim)
      .map(v => v.persistentVolumeClaim.claimName))
      .flat();

    let vols = claims.map(c => model.items
      .filter(x => x.kind.match('PersistentVolumeClaim'))
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
      let json = await this.invokeOperator(`rbd -p ${cfg.backup.pool} --image=${vol.pv} snap ls --format=json`);
      if (json.trim().length == 0) {
        log.warn('Attempt %s/%s: Failed to resolve snapshots.', i, attempts);
        continue;
      }
      vol.snapshots = JSON.parse(json).map(x => new Snapshot({
        name: x.name,
        timestamp: new Date(Date.parse(x.timestamp)),
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

        let result = await this.invokeOperator(`
          [[ -f ${tmp} ]] && echo "File exists : ${tmp}. Another backup in progress?" >&2 && exit 1
          [[ -f ${path} ]] && echo "File exists: ${path}" && exit
          mkdir -p ${directory}    
          rbd -p replicapool --image ${image} export-diff ${rbdFromSnap} ${rbdSnap} - | gzip > ${tmp} && 
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
      HTTPS_PROXY: proxy,
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

  async podexec(namespace, pod, script) : Promise<string> {
    return await this.exec("kubectl", ["-n", namespace, "exec", pod, "--", "bash", "-c", script]);
  }

  async resolveOperator() {
    log.debug('Resolving rook-ceph-operator pod...');
    this.operator = await this.scriptexec(
      `kubectl -n rook-ceph get pod -l app=rook-ceph-operator -o jsonpath='{.items[].metadata.name}'`
    );
  }

  async invokeOperator(script: string) : Promise<string> {
    return await this.operatorSemaphore.use(async () =>
      await this.podexec("rook-ceph", this.operator, script));
  }

  async report() {
    let report = await this.invokeOperator(`
      cd ${cfg.backup.path} 
      find * -type f | sort | xargs ls -sh
      df -h $PWD
    `);
    log.debug('File report:\n%s', report);
  }

}
