import {cfg, Snapshot} from "./cfg";
import {help, report} from "./utils";
import {log} from "./log";
import dedent from 'dedent';
import {CephCore} from "./ceph-core";

export class CephRestore extends CephCore {

  async restoreFromSnapshot(namespace: string, deployment: string, volume: string, snapshot: string) {

    namespace || deployment || volume || snapshot || help();

    await this.processAllVolumes(async vol => {
      if (vol.pvc != volume && vol.pv != volume) return; // ignore

      //let scale = await this.k8sClientApps.readNamespacedStatefulSetScale(deployment, namespace).catch(report);

      let snaps = vol.snapshots;
      await this.consolidateSnapshots(snaps);
      let snap = snaps.find(x => x.name == snapshot);
      let alldeps : Snapshot[] = [];
      for (let x = snap; x != undefined; x = x.dependsOn) alldeps.push(x);
      alldeps.reverse();
      let importables = alldeps.filter(x => !x.hasSnapshot);
      let importableNames = importables.map(x => x.file);
      let evictables = snaps.slice(snaps.indexOf(snap) + 1).filter(x => x.hasSnapshot);
      let evictableNames = evictables.map(x => x.name);
      let script = dedent`
        dir=${vol.getDirectory()}
        pool=${cfg.backup.pool}
        image=${snap.volume.pv}
        importables="${importableNames.join(' ')}"
        evictables="${evictableNames.join(' ')}"
        cd $dir &&
        echo "Importing snapshots..." &&
        for i in $importables; do echo "- $i"; rbd import-diff --image $pool/$image <(gunzip -c $i) ; done &&
        echo "Reverting to selected snapshot..." &&
        rbd snap revert --image $pool/$image --snap ${snap.name} &&
        echo "Removing obsolete snapshots..." &&
        for i in $evictables; do echo "- $i"; rbd snap rm --image $pool/$image --snap $i; done &&
        echo OK || echo ERROR
      `;
      log.info('Restoring from backup: %s/%s [%s:%s]. Importing snapshots [%s], reverting to [%s], removing obsolete [%s]',
        namespace, deployment, vol.pvc, vol.pv,
        importables.map(x => x.name).join(','),
        snap.name,
        evictables.map(x => x.name).join(', '),
      );
      let result = await this.invokeToolbox(script).catch(report);
      log.debug('Script output:\n%s', result);
    })
  }

}
