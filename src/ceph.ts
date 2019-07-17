import {cfg, Deployment, Kind, Snapshot, Volume} from "./cfg";
import {spawn} from "child_process";
import q from 'q';
import {log} from "./log";
import dateFormat from 'dateformat';
import {report, rethrow} from "./utils.js";
import {Semaphore} from 'await-semaphore';

export class Ceph {

  // k8s model by namespace
  model: Map<string,any> = new Map<string, any>();

  // name of the rook-ceph-operator pod
  operator : string;

  execSemaphore: Semaphore = new Semaphore(cfg.semaphore.exec);
  operatorSemaphore: Semaphore = new Semaphore(cfg.semaphore.operator);
  backupSemaphore: Semaphore = new Semaphore(cfg.semaphore.backup);

  async createSnapshotAll() {
    await this.resolveOperator();
    await Object.keys(cfg.deployments).forEachAsync(async namespace => {
      await this.loadNamespaceModel(namespace);
      await Object.keys(cfg.deployments[namespace]).forEachAsync(async deployment =>
        await this.createSnapshot(namespace, deployment)).catch(report)
    });
  }

  async createSnapshot(namespace: string, deployment: string) {
    let date = dateFormat(Date.now(), 'yyyymmdd-HHMM');
    await this.getVolumes(namespace, deployment).forEachAsync(async vol => {
      let snap = `${date}-k8s-live`;
      log.debug('Creating snapshot %s for image %s (namespace=%s, deployment=%s, pvc=%s)', snap, vol.pv, namespace, deployment, vol.pvc);
      await this.invokeOperator(`rbd snap create -p ${cfg.backup.pool} --image=${vol.pv} --snap=${snap}`);
    });
  }

  async backupAll() {
    await this.resolveOperator();
    await Object.keys(cfg.deployments).forEachAsync(async namespace => {
      await this.loadNamespaceModel(namespace);
      await Object.keys(cfg.deployments[namespace]).forEachAsync(async deployment =>
        await this.backup2(deployment, namespace)).catch(report)
    });
  }

  async loadNamespaceModel(namespace: string) {
    let json = await this.scriptexec(`kubectl -n ${namespace} get deployment,statefulset,pvc -o json | jq -c`);
    this.model.set(namespace, JSON.parse(json));
  }

  getSelector(namespace: string, deployment: string) : string[] {
    let labels = this.model.get(namespace).items
      .find(x => x.kind.match('Deployment|StatefulSet'))
      .spec.selector.matchLabels
    ;
    let sel : string[] = [];
    Object.keys(labels).forEach(x => sel.push(`${x}=${labels[x]}`));
    return sel;
  }

  getVolumes(namespace: string, deployment: string) : Volume[] {
    let model = this.model.get(namespace);
    let labels = model.items
      .filter(x => x.kind.match('Deployment|StatefulSet'))
      .find(x => x.metadata.name == deployment)
      .spec.selector.matchLabels;
    return model.items
      .filter(x => x.kind == 'PersistentVolumeClaim')
      .filter(x => JSON.stringify(labels) === JSON.stringify(x.metadata.labels))
      .map(x => <Volume>{pvc: x.metadata.name, pv: x.spec.volumeName});
  }


  async backup2(deployment: string, namespace: string) {
    let sel = this.getSelector(namespace, deployment).join(",");
    let vols = this.getVolumes(namespace, deployment);
    let dpl: Deployment = {name: deployment, namespace: namespace, kind: Kind.Deployment, volumes: vols};
    await vols.forEachAsync(async vol =>
       await this.backup(dpl, vol).catch(report));
  }

  async backup(deployment: Deployment, vol: Volume) {
    await this.resolveSnapshots(vol).catch(rethrow);
    let dir = `${cfg.backup.path}/${deployment.namespace}/${deployment.name}/${vol.pvc}-${vol.pv}`;
    let actions = new Array<()=>void>();
    let previous: string;
    vol.snapshots.forEach(x => {
      let from = previous;
      actions.push(async () => await this.backupSnapshot(vol.pv, from, x.name, dir).catch(report));
      previous = x.name;
    });
    await actions.forEachAsync(async action => await action());
  }

  // async retry<T>(attempts:number, action: ()=>T) : Promise<T> {
  //   for (let i=1; i<=attempts; i++) {
  //     return await action();
  //   }
  //   return result;
  // }

  async resolveSnapshots(vol: Volume) {
    log.debug('Resolving snapshots for volume %s (%s)', vol.pvc, vol.pv);
    for (let i=1, attempts=2; i<=attempts; i++) {
      let json = await this.invokeOperator(`rbd -p ${cfg.backup.pool} --image=${vol.pv} snap ls --format=json`);
      if (json.trim().length == 0) {
        log.warn('Attempt %s/%s: Failed to resolve snapshots.', i, attempts);
        continue;
      }
      vol.snapshots = JSON.parse(json);
      break;
    }
  }

  async backupSnapshot(image: string, fromSnapshot: string, snapshot: string, directory: string) {
    await this.backupSemaphore.use(async () => {
      let suffix = fromSnapshot ? `.since-${fromSnapshot}` : '';
      let path = `${directory}/${snapshot}${suffix}.gz`;
      let tmp = `${path}.tmp`;
      let rbdFromSnap = fromSnapshot ? `--from-snap=${fromSnapshot}` : '';
      let rbdSnap = snapshot ? `--snap=${snapshot}` : '';

      //log.debug('Backup snapshot %s', path);

      for (let i=1, attempts=2; i<=attempts; i++) {

        let result = await this.invokeOperator(`
          [[ -f ${tmp} ]] && echo "File exists: ${tmp}. Another backup in progress?" && exit 1
          [[ -f ${path} ]] && echo "File exists: $(du -h ${path})" && exit
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
}
