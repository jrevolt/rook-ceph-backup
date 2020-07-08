import {BackupType, cfg, Snapshot, Volume} from "./cfg";
import {log} from "./log";
import {report} from "./utils";
import {CephRead} from "./ceph-read";
import moment = require("moment");

export class CephBackup extends CephRead {

  async processVolumesAll(namespace:string|undefined, deployment:string|undefined, action:(v:Volume)=>void) {
    let namespaces = (await this.listNamespaces())
      .filter(ns => !namespace || ns.name == namespace)
    await namespaces.forEachAsync(async (ns) => await this.loadNamespace(ns));
    await namespaces
      .filter(ns => !namespace || ns.name == namespace)
      .flatMap(ns => ns.deployments)
      .filter(d => !deployment || d.name == deployment)
      .flatMap(d => d.volumes)
      .forEachAsync(async (v) => await action(v))
  }

  async createSnapshotAll(namespace?:string, deployment?:string) {
    await this.processVolumesAll(namespace, deployment, async (v) => await this.createSnapshot(v))
  }

  async createSnapshot(vol: Volume) {
    let name = moment().format(cfg.backup.nameFormat);
    let found = vol.snapshots.find(x => x.name == name)
    if (found) {
      log.warn('Snapshot %s already exists. Skipping volume %s', name, vol.describe())
      return
    }
    log.info('Creating snapshot %s for volume %s', name, vol.describe());
    let result = await this.invokeToolbox(`
      rbd snap create ${vol.image.pool}/${vol.image.name}@${name} &&
      echo -n "Created snapshot ${vol.image.pool}/${vol.image.name}@${name}"
    `);
    log.info(result);
    vol.snapshots.push(new Snapshot({name: name, timestamp: moment(name, cfg.backup.nameFormat).toDate(), hasSnapshot: true, hasFile: false}));
    this.consolidateSnapshots(vol.snapshots);
  }

  async backupVolumeAll(namespace?:string, deployment?:string, type?:BackupType) {
    await this.processVolumesAll(namespace, deployment, async (v) => await this.backupVolume(v, type))
  }

  async backupVolume(vol: Volume, type?:BackupType) {
    log.info('Backing up volume %s', vol.describe())

    // if explicit backup mode is specified, try to enforce backup type on latest unexported snapshot
    if (type) {
      // find candidate
      let latest = vol.snapshots.filter(x => x.hasSnapshot && !x.hasFile && !x.isDeleteFile).last()
      if (latest) {
        latest.backupType = type
        log.info('Suggesting backup type for latest unsaved snapshot %s@%s=%s', latest.volume.describe(), latest.name, latest.backupType)
      } else {
        log.warn('Explicit back mode specified but no snapshot candidate was found')
      }
    }
    await this
      .consolidateSnapshots(vol.snapshots)
      .filter(x => x.hasSnapshot && !x.hasFile && !x.isDeleteFile)
      .forEachAsync(async x => await this.backupSnapshot(x).catch(report));
  }


  async backupSnapshot(snap: Snapshot/*, image: string, fromSnapshot: string, snapshot: string, directory: string*/) { //todo
    await this.backupSemaphore.use(async () => {
      let pool = snap.volume.image.pool;
      let image = snap.volume.image.name;
      let snapshot = snap.name;
      let spec=`${pool}/${image}@${snapshot}`;
      let directory = snap.volume.getDirectory();
      let path = `${directory}/${snap.file}`;
      let tmp = `${path}.tmp`;
      let rbdFromSnap = snap.dependsOn ? `--from-snap=${snap.dependsOn.name}` : '';

      log.info('Creating backup %s for %s', snap.file, snap.volume.describe());
      let result = await this.invokeToolbox(`
        cd ${directory} &&
        rbd export-diff --no-progress ${spec} ${rbdFromSnap} - | dd status=progress | gzip > ${tmp} && mv ${tmp} ${path} &&
        echo -n "Created: ${path}"
      `);
      log.debug(result);
      snap.hasFile = true;
    });
  }

  async consolidateAll(namespace?:string, deployment?:string) {
    await this.processVolumesAll(namespace, deployment, async (v) => await this.consolidate(v))
  }

  async consolidate(vol: Volume) {

    let snaps = vol.snapshots;
    let dir = vol.getDirectory();
    let consolidated = this.consolidateSnapshots(snaps);

    let toBackup = snaps.filter(x => x.hasSnapshot && !x.hasFile && !x.isDeleteFile)
    let toEvict = snaps.filter(x => x.hasSnapshot && x.isDeleteSnapshot);
    let toDelete = snaps.filter(x => x.hasFile && x.isDeleteFile)

    log.info('Consolidating (backup:%d, evict:%d, delete:%d) : %s/%s/%s',
      toBackup.length, toEvict.length, toDelete.length,
      vol.deployment.namespace, vol.deployment.name, vol.pvc)

    //log.debug(`Consolidation plan: ${vol.pvc} (${vol.pv}):\n${snaps.map(x => '-' + x.consolidationInfo()).join('\n')}`);

    // backup those not yet done
    await toBackup.forEachAsync(async x => await this.backupSnapshot(x));

    // remove evicted snapshots
    await this.removeSnapshots(vol, toEvict)

    // delete backup files for evicted and outdated snapshots
    await this.invokeToolbox(`cd ${dir} && rm -fv ${toDelete.map(s => s.file).join(' ')}`)

    // commit consolidated list
    vol.snapshots = consolidated
  }

  async cliRemoveSnapshots(namespace?:string, workload?:string, volume?:string, snapshot?:string) {
    let namespaces = (await this.listNamespaces())
      .filter(ns => !namespace || ns.name == namespace)
    await namespaces.forEachAsync(async (ns) => await this.loadNamespace(ns));

    let snaps = namespaces
      .filter(ns => !namespace || ns.name == namespace)
      .flatMap(ns => ns.deployments)
      .filter(d => !workload || d.name == workload)
      .flatMap(d => d.volumes)
      .filter(v => !volume || v.pvc == volume || v.image.name == volume)
      .flatMap(v => v.snapshots)
      .filter(s => !snapshot || s.name == snapshot)
      .filter(s => s.hasSnapshot)

    let cmds = snaps.map(x => `
    echo "Removing ${x.volume.image.pool}/${x.volume.image.name}@${x.name}" >&2
    rbd snap rm "${x.volume.image.pool}/${x.volume.image.name}@${x.name}"
    `)

    if (cmds.length > 0) {
      log.debug('Removing %s snapshots: %s', snaps.length, snaps.map(s => `${s.name} in ${s.volume.describe()}`))
      let result = await this.invokeToolbox(cmds.join('\n'))
      log.debug(result)
    }
    else
      log.info('No snapshots found')

  }

  async removeBackupArchives(namespace:string, workload:string) {
    await this.processVolumesAll(namespace, workload, async (v) => {
      let toDelete = v.snapshots.filter(s => s.hasFile)
      if (toDelete.length == 0) {
        log.info('Nothing to delete in volume %s', v.describe())
        return
      }
      log.info('Deleting %d backup archives in volume %s', toDelete.length, v.describe())
      let cmds = toDelete
        .map(s => `rm -vf ${v.getDirectory()}/${s.file}`)
        .join('\n')
      let out = await this.invokeToolbox(cmds)
      log.debug(out)
    })
  }

}
