import {Ceph} from "./ceph";
import {BackupType, cfg, Deployment, Namespace, Snapshot, Volume} from "./cfg";
import moment from "moment";
import * as utils from "./utils";
import {newMoment} from "./utils";
import {log} from "./log";

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
    let namespaces : Namespace[] = [];
    await Object.keys(cfg.deployments).forEachAsync(async (namespace) =>
      await Object.keys(cfg.deployments[namespace]).forEachAsync(async (deployment) => {
        let ns = namespaces.find(x => x.name == namespace);
        if (!ns) { ns = new Namespace({ name: namespace }); namespaces.push(ns); }
        let d = new Deployment(deployment, namespace);
        ns.deployments.push(d);
        await this.resolveVolumes(d).then(async vols =>
          await vols.forEachAsync(async v =>
            await this.consolidateSnapshots(v.snapshots)));
      }));
    return (this.namespaces = namespaces);
  }

  async processAllDeployments(action: (d:Deployment)=>void) {
    let namespaces : Namespace[] = [];
    await this.processAllNamespaces(x => namespaces.push(x));
    await namespaces.forEachAsync(async ns =>
      await ns.deployments.forEachAsync(async d =>
        await action(d)));
  }

  async processAllVolumes(action: (vol: Volume) => void) {
    let namespaces: Namespace[] = [];
    await this.processAllNamespaces(x => namespaces.push(x));
    await namespaces.forEachAsync(async ns =>
      await ns.deployments.forEachAsync(async d =>
        await d.volumes.forEachAsync(async v =>
          await action(v)
        )));
  }

  consolidateSnapshots(snaps: Snapshot[]) : Snapshot[] {
    if (snaps.length == 0) return snaps; // nothing to do here

    // identify backup types
    let latestFull: Snapshot;// = snaps.filter(x => x.backupType == BackupType.full).last();
    let latestDiff: Snapshot;// = snaps.filter(x => x.backupType == BackupType.differential).last();
    let cfgMonthly = cfg.backup.monthly;
    let cfgWeekly = cfg.backup.weekly;
    let cfgDaily = cfg.backup.daily;
    let cfgMonthlyDayOfMonth = cfgMonthly.dayOfMonth;
    let cfgMonthlyDayOfWeek = cfgMonthly.dayOfWeek ? moment.parseZone(cfgMonthly.dayOfWeek, 'ddd').toDate().getDay() : undefined;
    let cfgWeeklyDayOfWeek = cfgWeekly.dayOfWeek ? moment.parseZone(cfgWeekly.dayOfWeek, 'ddd').toDate().getDay() : undefined;
    let isMonthly = (x: Snapshot) : boolean => {
      if (!latestFull || !latestFull.hasSnapshot) return true;
      let xday = x.timestamp.getDate();
      let mday =
        cfgMonthlyDayOfMonth != undefined ? cfgMonthlyDayOfMonth :
          cfgMonthlyDayOfWeek != undefined ? utils.findFirstDayOfMonthByWeekday(x.timestamp, cfgMonthlyDayOfWeek) :
            1;
      return xday == mday || (xday > mday && newMoment(x.timestamp).month() > newMoment(latestFull.timestamp).month());
    };
    let isWeekly = (x: Snapshot) : boolean => {
      if (!latestDiff) return true;
      let xday = x.timestamp.getDay();
      return xday == cfgWeeklyDayOfWeek || (xday > cfgWeeklyDayOfWeek && newMoment(x.timestamp).week() > newMoment(latestDiff.timestamp).week());
    };
    snaps.forEach(x => {
      if (isMonthly(x)) {
        x.backupType = BackupType.monthly;
        latestFull = x;
        latestDiff = undefined; // reset
      } else if (isWeekly(x)) {
        x.backupType = BackupType.weekly;
        latestDiff = x;
      } else {
        x.backupType = BackupType.daily;
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
      let since = ['ful','dif','inc'][x.backupType];
      x.file = from ? `${x.name}-${since}-${from.name}.gz` : `${x.name}-${since}.gz`;
    });

    // filter OUT evicted snapshots
    let result = snaps.filter(x => !x.isDeleteFile);

    return result;
  }

  async removeSnapshots(vol: Volume, snaps: Snapshot[]) {
    let names = snaps.map(x => x.name);
    log.debug('Removing %d snapshots in volume %s : [%s]', snaps.length, vol.describe(), names.join(','));
    if (names.length == 0) return;
    await this.invokeToolbox(`
      for i in ${names.join(' ')}; do
        rbd -p ${cfg.backup.pool} --image=${vol.pv} snap rm --snap=$i
      done
    `);
  }


}
