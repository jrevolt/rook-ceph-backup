import './init'
import * as utils from './utils';
import {fail, newMoment} from './utils';
import {BackupType, BackupTypeUtils, cfg, Deployment, Namespace, Snapshot, Volume} from "./cfg";
import {spawn} from "child_process";
import q from 'q';
import {log} from "./log";
import {Semaphore} from 'await-semaphore';
import * as k8s from '@kubernetes/client-node';
import {V1Deployment, V1Pod, V1StatefulSet} from '@kubernetes/client-node';
import * as streamBuffers from 'stream-buffers';
import extend from 'extend';
import {Writable} from "stream";

export interface INamespace {
  persistentVolumes: k8s.V1PersistentVolume[],
  persistentVolumeClaims: k8s.V1PersistentVolumeClaim[],
  pods: V1Pod[],
  deployments: V1Deployment[],
  statefulSets: V1StatefulSet[],
}

export class Ceph {

  // k8s model by namespace
  model: Map<string,INamespace> = new Map<string, INamespace>();

  // name of the rook-ceph-tools pod
  toolbox ?: string;

  private resolveToolboxSemaphore : Semaphore = new Semaphore(1)
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
    log.debug(`Loading KubeConfig: ${cfg.kubectl.config}`)
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

  nameof(x:any) : string { return x?.metadata?.name || fail(`metadata.name? ${x}`) }

  async listNamespaces() : Promise<Namespace[]> {
    let all = await this.k8sClient.listNamespace().then(x => x.body.items.filter(i => i.metadata))
    return all.map(x => new Namespace({name: x.metadata?.name}))
  }

  getNamespaceModel(namespace: string) : INamespace|undefined {
    return this.model.get(namespace);
  }

  async loadNamespaceModel(namespace: string) : Promise<INamespace> {
    let model : INamespace|undefined = this.getNamespaceModel(namespace);
    if (model) return model;

    log.debug('Loading namespace %s', namespace);

    function unbox(x: any) {
      return x.body.items.filter(i => i.metadata);
    }

    let [ pvs, pvcs, pods, statefulSets, deployments ] = await Promise.all([
      this.k8sClient.listPersistentVolume().then(unbox),
      this.k8sClient.listNamespacedPersistentVolumeClaim(namespace).then(unbox),
      this.k8sClient.listNamespacedPod(namespace).then(unbox),
      this.k8sClientApps.listNamespacedStatefulSet(namespace).then(unbox),
      this.k8sClientApps.listNamespacedDeployment(namespace).then(unbox),
      // daemon sets: out of scope, cannot share volume (ReadWriteOnce)
    ]);

    model = {
      persistentVolumes: pvs,
      persistentVolumeClaims: pvcs,
      pods: pods,
      deployments: deployments,
      statefulSets: statefulSets,
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

    let model : INamespace = this.getNamespaceModel(deployment.namespace) as INamespace

    // all k8s deployments/statefulsets (other type are unsupported yet)
    let all : V1Deployment[]|V1StatefulSet[] = model.deployments.concat(model.statefulSets)
    // resolve k8s entity
    let dpl = all.find(x => x.metadata?.name == deployment.name);
    // find all PVC names related to this deployment (this will not contain PVC templates)
    let claims = all
      .filter(x => x.metadata?.name == deployment.name)
      .map(x => (x.spec?.template?.spec?.volumes || []).flat())
      .flat()
      .filter(x => x.persistentVolumeClaim)
      .map(x => x.persistentVolumeClaim?.claimName);
    let vols = model.persistentVolumeClaims
      .filter(x => x.spec?.storageClassName == cfg.backup.storageClassName)
      // if the PVC is not found in claims, fallback to lookup by labels (this works work PVC templates)
      .filter(x => claims.contains(x.metadata?.name) || this.isMatchLabels(dpl?.spec?.selector.matchLabels, x.metadata?.labels))
      .map(x => new Volume({
        deployment: deployment,
        pvc: x.metadata?.name,
        //pv: x.spec?.volumeName,
        image: model.persistentVolumes
          .filter(pv => pv.metadata?.name == x.spec?.volumeName)
          .map(pv => Object.assign({
            name: pv.spec?.csi?.volumeHandle.replace(/^.*-rook-ceph-[0-9]+-(.*)/, 'csi-vol-$1'),
            pool: pv.spec?.csi?.volumeAttributes?.pool,
          }))
          .first(),
      }));

    await vols.forEachAsync(async v => await this.resolveSnapshots(v));

    return deployment.volumes = vols;
  }

  async resolveSnapshots(vol: Volume) : Promise<Snapshot[]> {
    if (vol.snapshots) return vol.snapshots;

    log.debug('Resolving snapshots for volume %s', vol.describe());

    let json = await this.invokeToolbox(`rbd snap ls --format=json ${vol.image.pool}/${vol.image.name} `);
    let parsed = JSON.parse(json).filter(x => x.name.match(cfg.backup.namePattern));

    // validate snapshot list: native RBD order (by time) must be the same as our timestamped name ordering (YYYYMMDD-HHmm)
    let names = parsed.map(x => x.name);
    let sortedNames = parsed.map(x => x.name).sort((a,b) => a.localeCompare(b));
    if (!names.equals(sortedNames)) {
      // todo: review: may happen after restore; otherwise, this indicates problem in snapshot hierarchy: results are undefined
      log.warn(`Unexpected snapshot ordering: [${names.join(',')}]`);
    }

    vol.snapshots = parsed.map(x => new Snapshot({
      name: x.name,
      timestamp: utils.newMoment(x.name, cfg.backup.nameFormat).toDate(), //don't rely on x.timestamp, it may be invalid if snapshot is imported
      volume: vol,
      hasSnapshot: true,
    }));

    let files =
      // list all files
      await this.invokeToolbox(`dir="${vol.getDirectory()}"; mkdir -p "$dir" && cd "$dir" && ls -1s --block-size=1`)
        // split result by lines
        .then(result => result.match(/[^\r\n]*/g)?.filter(x => x.length > 0))
        // process file names
        .then(fnames => fnames?.slice(1) // skip header
          // convert to snapshot
          .map(f => {
            let fname = f.replace(/.*\s/g, '');
            let fsize = parseInt(f.replace(/.*\s(\d+)\s.*/g, '$1'));
            let timestamp = newMoment(fname, cfg.backup.nameFormat);
            let name = newMoment(timestamp).format(cfg.backup.nameFormat);
            let snap = new Snapshot({
              name: name,
              timestamp: timestamp.toDate(),
              //backupType: name.indexOf('-ful') ? BackupType.full : name.indexOf('-dif') ? BackupType.differential : BackupType.incremental,
              backupType: BackupTypeUtils.fromFileType(fname.replace(/^.*-(ful|dif|inc).*/g, '$1')), //fixme hardcoded literals
              file: fname,
              fileSize: fsize,
              hasFile: true,
              hasSnapshot: vol.snapshots.find(s => s.name === name) != null,
              volume: vol,
            });
            return snap;
          })
        ) as Snapshot[]

    // merge results, deduplicate
    files.forEach(x => {
      let snap = vol.snapshots.find(s => s.name === x.name);
      if (snap) extend(snap, x);
      else vol.snapshots.push(x);
    });
    vol.snapshots.forEach(x => {
      if (!x.hasFile) x.hasFile = files.find(s => s.name === x.name) != null;
    });

    // sort
    vol.snapshots = vol.snapshots.sort((a,b) => a.name > b.name ? 1 : -1);

    // link dependencies: only existing file (new snapshots have type=undefined)
    vol.snapshots.every((x, idx, arr) => {
      if (x.backupType == BackupType.monthly) return true; // skip, no deps
      if (x.hasFile) {
        let name = x.file.replace(/.*(dif|inc)-(.*)\.gz/g, '$2'); //fixme hardcoded literal
        x.dependsOn = vol.snapshots.find(x => x.name == name);
      }
      return true;
    });

    // contents:
    // - new (hasSnapshot=true, hasFile=false)
    // - exported (hasSnapshot=true, hasFile=true)
    // - archived (hasSnapshot=false, hasFile=true)
    return vol.snapshots;
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
    let stderrbuf = new streamBuffers.WritableStreamBuffer();
    let stderr = new Writable({
      write: (chunk, encoding, cb) => {
        process.stderr.write(chunk, encoding)
        stderrbuf.write(chunk, encoding, cb)
      }
    })

    let deferred = q.defer();
    let output: string = '';
    let error: string = '';
    let code: number = 0;
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
        if (x.status == 'Success') {
          output = stdout.getContentsAsString() || '';
          //log.debug(stderr.getContentsAsString())
        } else {
          output = stdout.getContentsAsString() || '';
          error = stderrbuf.getContentsAsString();
          code = parseInt(x.details?.causes?.find(c => c.reason == 'ExitCode')?.message || '0');
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
    if (this.toolbox) return;
    await this.resolveToolboxSemaphore.use(async () => {
      if (this.toolbox) return;
      log.debug('Resolving rook-ceph-tools pod...');
      this.toolbox = await this.k8sClient.listNamespacedPod('rook-ceph')
        .then(x => x.body.items
          .filter(x => x.metadata)
          .filter(x => this.isMatchLabels({app: 'rook-ceph-tools'}, x.metadata?.labels))
          .map(x => x.metadata?.name)
          .first())
    })
  }

  async invokeToolbox(script: string) : Promise<string> {
    if (!this.toolbox) await this.resolveToolbox()
    return await this.operatorSemaphore.use(async () =>
      await this.podexec("rook-ceph", this.toolbox, 'rook-ceph-tools', script));
  }

  async report() {
    let report = await this.invokeToolbox(`
      cd ${cfg.backup.path}
      find * -type f -name "*.gz*" | sort | xargs ls -sh
      df -h $PWD
    `);
    log.debug('File report:\n%s', report);
  }

}
