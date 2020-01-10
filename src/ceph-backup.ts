import {cfg, Snapshot, Volume} from "./cfg";
import {log} from "./log";
import {report} from "./utils";
import {CephRead} from "./ceph-read";
import moment = require("moment");

export class CephBackup extends CephRead {

  async createSnapshotAll() {
    await this.processAllVolumes(async (vol) =>
      await this.createSnapshot(vol));
    await this.listAll();
  }

  async createSnapshot(vol: Volume) {
    let name = moment().format(cfg.backup.nameFormat);
    let deployment = vol.deployment;
    let spec=`${cfg.backup.pool}/${vol.pv}@${name}`;
    log.debug('Creating snapshot %s for volume %s', name, vol.describe());
    let result = await this.invokeToolbox(`
      rbd snap create ${spec} &&
      echo -n "Created snapshot ${name} for volume ${vol.describe()}"
    `);
    log.info(result);
    vol.snapshots.push(new Snapshot({name: name, timestamp: moment(name, cfg.backup.nameFormat).toDate(), hasSnapshot: true, hasFile: false}));
    this.consolidateSnapshots(vol.snapshots);
  }


  async backupVolumeAll() {
    await this.processAllVolumes(async (vol) =>
      await this.backupVolume(vol));
    await this.listAll();
  }

  async backupVolume(vol: Volume) {
    await this
      .consolidateSnapshots(vol.snapshots)
      .filter(x => x.hasSnapshot && !x.hasFile && !x.isDeleteFile)
      .forEachAsync(async x => await this.backupSnapshot(x).catch(report));
  }


  async backupSnapshot(snap: Snapshot/*, image: string, fromSnapshot: string, snapshot: string, directory: string*/) {
    await this.backupSemaphore.use(async () => {
      let pool = cfg.backup.pool;
      let image = snap.volume.pv;
      let snapshot = snap.name;
      let spec=`${pool}/${image}@${snapshot}`;
      let directory = snap.volume.getDirectory();
      let path = `${directory}/${snap.file}`;
      let tmp = `${path}.tmp`;
      let rbdFromSnap = snap.dependsOn ? `--from-snap=${snap.dependsOn.name}` : '';

      log.debug('Creating backup %s for %s', snap.file, snap.volume.describe());
      let result = await this.invokeToolbox(`
        cd ${directory} &&
        rbd export-diff --no-progress ${spec} ${rbdFromSnap} - | gzip > ${tmp} && mv ${tmp} ${path} &&
        echo -n "Created: ${path}"
      `);
      log.debug(result);
      snap.hasFile = true;
    });
  }

  async consolidateAll() {
    await this.processAllVolumes(async (vol) =>
      await this.consolidate(vol));
    await this.listAll();
  }

  async consolidate(vol: Volume) {

    let snaps = vol.snapshots;
    let dir = vol.getDirectory();
    let consolidated = this.consolidateSnapshots(snaps);
    let evicted = snaps.filter(x => x.hasSnapshot && x.isDeleteSnapshot);
    let deletedFiles = snaps.filter(x => x.hasFile && x.isDeleteFile).map(x => x.file);

    //log.debug(`Consolidation plan: ${vol.pvc} (${vol.pv}):\n${snaps.map(x => '-' + x.consolidationInfo()).join('\n')}`);

    // backup those not yet done
    await snaps
      .filter(x => x.hasSnapshot && !x.hasFile && !x.isDeleteFile)
      .forEachAsync(async x => await this.backupSnapshot(x));

    await Promise.all([
      // remove evicted snapshots
      this.removeSnapshots(vol, evicted),

      // delete backup files for evicted and outdated snapshots
      this.invokeToolbox(`cd ${dir} && rm -fv ${deletedFiles.join(' ')}`),
    ]);

    // commit consolidated list
    vol.snapshots = vol.snapshots.filter(x => x.hasSnapshot || x.hasFile);
  }


}
