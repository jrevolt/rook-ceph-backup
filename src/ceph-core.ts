import {Ceph} from "./ceph";
import {BackupType, BackupTypeUtils, cfg, Deployment, Namespace, Snapshot, Volume} from "./cfg";
import moment from "moment";
import * as utils from "./utils";
import {newMoment} from "./utils";
import {log} from "./log";
import assert from "assert";

export class CephCore extends Ceph {

  namespaces: Namespace[];

  async processAllNamespaces(action: (ns: Namespace) => void) {
    await Promise.all([
      await this.resolveToolbox(),
      await Object.keys(cfg.deployments).forEachAsync(async (namespace) =>
        await this.loadNamespaceModel(namespace)),
    ]);
    this.namespaces || await this.loadNamespaces();
    await this.namespaces.forEachAsync(async x => await action(x));
  }

  async loadNamespaces() : Promise<Namespace[]> {

    this.namespaces = []

    Object.keys(cfg.namespaces).forEach(ns => this.namespaces.push(new Namespace({name: ns})))

    await this.namespaces.forEachAsync(async (ns) => {
      await this.loadNamespaceModel(ns.name)
      await Object.keys(cfg.deployments[ns.name]).forEachAsync(async (deployment) => {
        let d = new Deployment(deployment, ns.name);
        ns.deployments.push(d);
        await this.resolveVolumes(d).then(async vols =>
          await vols.forEachAsync(async v =>
            await this.consolidateSnapshots(v.snapshots)));
      })
    })
    return this.namespaces
  }



  async loadNamespace(ns:Namespace) : Promise<Namespace> {
    let model = await this.loadNamespaceModel(ns.name);
    ns.deployments.pushAll(
      [model.deployments, model.statefulSets].flat().map(x =>
        new Deployment(x?.metadata?.name as string, ns.name)));
    await ns.deployments.forEachAsync(async (d) =>
      await this.resolveVolumes(d).then(async (vols) =>
        await vols.forEachAsync(async (v) =>
          await this.resolveSnapshots(v))))
    this.model[ns.name] = model
    return ns
  }

  async processAllDeployments(action: (d:Deployment)=>void) {
    let namespaces : Namespace[] = [];
    await this.processAllNamespaces(x => namespaces.push(x));
    await namespaces.forEachAsync(async ns =>
      await ns.deployments.forEachAsync(async d =>
        await action(d)));
  }

  consolidateSnapshots(snaps: Snapshot[]) : Snapshot[] {
    if (snaps.length == 0) return snaps; // nothing to do here

    // identify backup types
    let latestFull: Snapshot;// = snaps.filter(x => x.backupType == BackupType.full).last();
    let latestDiff: Snapshot|undefined;// = snaps.filter(x => x.backupType == BackupType.differential).last();
    let cfgMonthly = cfg.backup.monthly;
    let cfgWeekly = cfg.backup.weekly;
    let cfgDaily = cfg.backup.daily;
    let cfgMonthlyDayOfMonth = cfgMonthly.dayOfMonth;
    let cfgMonthlyDayOfWeek = cfgMonthly.dayOfWeek ? moment.parseZone(cfgMonthly.dayOfWeek, 'ddd').toDate().getDay() : undefined;
    let cfgWeeklyDayOfWeek = cfgWeekly.dayOfWeek ? moment.parseZone(cfgWeekly.dayOfWeek, 'ddd').toDate().getDay() : undefined;

    function isMonthly(x: Snapshot) : boolean {
      if (x.hasFile) return x.backupType == BackupType.monthly;
      if (!latestFull) return true;
      if (x.backupType == BackupType.monthly) return true;
      let xday = x.timestamp.getDate();
      let mday =
        cfgMonthlyDayOfMonth != undefined ? cfgMonthlyDayOfMonth :
        cfgMonthlyDayOfWeek != undefined ? utils.findFirstDayOfMonthByWeekday(x.timestamp, cfgMonthlyDayOfWeek) :
        1;
      return xday == mday || (xday > mday && newMoment(x.timestamp).month() > newMoment(latestFull.timestamp).month());
    }

    function isWeekly(x: Snapshot) : boolean {
      if (x.hasFile) return x.backupType == BackupType.weekly;
      if (!latestDiff) return true;
      if (x.backupType == BackupType.weekly) return true;
      let xday = x.timestamp.getDay();
      return xday == cfgWeeklyDayOfWeek || (/*xday > cfgWeeklyDayOfWeek &&*/ newMoment(x.timestamp).week() > newMoment(latestDiff.timestamp).week());
    }

    function isDaily(x:Snapshot) : boolean {
      if (x.hasFile) return x.backupType == BackupType.daily;
      return true;
    }

    snaps.forEach(x => {
      if (isMonthly(x)) {
        x.backupType = BackupType.monthly;
        latestFull = x;
        latestDiff = undefined; // reset
      } else if (isWeekly(x)) {
        x.backupType = BackupType.weekly;
        latestDiff = x;
      } else if (isDaily(x)) {
        x.backupType = BackupType.daily;
      } else {
        assert.fail(`Unable to determine backup type for snapshot ${JSON.stringify(x.dbginfo())}`);
      }
    });

    // evict obsolete snapshots
    let evict = (x: Snapshot, idx: number, arr: Snapshot[], max: number) : boolean => {
      x.isDeleteFile = idx < arr.length - max;  // honor config backup limits of each type and remove obsolete archives
      x.isDeleteSnapshot = idx < arr.length - 1; // keep only latest snapshot from each type
      return true;
    };
    snaps.filter(x => x.backupType == BackupType.monthly).every((x, idx, arr) => evict(x, idx, arr, cfgMonthly.max));
    snaps.filter(x => x.backupType == BackupType.weekly).every((x, idx, arr) => evict(x, idx, arr, cfgWeekly.max));
    snaps.filter(x => x.backupType == BackupType.daily).every((x, idx, arr) => evict(x, idx, arr, cfgDaily.max));

    // resolve dependencies for new snapshots
    snaps.every((x, idx, arr) => {
      if (x.dependsOn != undefined) return true; // already resolved
      if (x.backupType == BackupType.monthly) return true; // skip, no dependencies
      if (x.backupType == BackupType.weekly) {
        x.dependsOn = arr.slice(0, idx).filter(x => x.backupType == BackupType.monthly).last();
      }
      else if (x.backupType == BackupType.daily) {
        // depends on previous snapshot, but it should not be from the same day, unless there is no other choice
        x.dependsOn = arr[idx-1];
        for (let i = idx - 1; i >= 0; i--)
          if (arr[i].timestamp.getDate() != x.timestamp.getDate()) {
            x.dependsOn = arr[i];
            break;
          }
      }
      return true;
    });


    // sanity check
    snaps.filter(x => !x.isDeleteFile).forEach(x => {
      for (let d = x.dependsOn; d != undefined; d = d.dependsOn) d.isDeleteFile = false;
    });

    // generate file names for new archives
    snaps.filter(x => !x.hasFile).forEach(x => {
      let from = x.dependsOn;
      let since = BackupTypeUtils.toFileType(x.backupType);
      x.file = from ? `${x.name}-${since}-${from.name}.gz` : `${x.name}-${since}.gz`;
    });

    // filter OUT evicted snapshots
    let result = snaps.filter(x => !x.isDeleteFile);

    return result;
  }

  async removeSnapshots(vol: Volume, snaps: Snapshot[]) {
    let names = snaps.map(x => x.name);
    if (names.length == 0) {
      log.debug('No snapshots to remove: %s', vol.describe())
      return
    }
    log.info('Removing %d snapshots in volume %s : [%s]', snaps.length, vol.describe(), names.join(','));
    await this.invokeToolbox(`
      for i in ${names.join(' ')}; do
        rbd snap rm ${vol.image.pool}/${vol.image.name}@$i
      done
    `);
  }

}
