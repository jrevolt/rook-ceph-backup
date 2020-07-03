import {cfg, Snapshot} from "./cfg";
import {fail, report} from "./utils";
import {log} from "./log";
import dedent from 'dedent';
import {CephCore} from "./ceph-core";
import {CephRead} from "./ceph-read";

export class CephRestore extends CephRead {

  async restoreFromSnapshot(namespace: string, deployment: string, volume: string, snapshot: string) {

    namespace || deployment || volume || snapshot || fail()

    let namespaces = (await this.listNamespaces())
      .filter(ns => ns.name == namespace)
    await namespaces.forEachAsync(async (ns) => await this.loadNamespace(ns));
    let vol = await namespaces
      .filter(ns => ns.name == namespace)
      .flatMap(ns => ns.deployments)
      .filter(d => d.name == deployment)
      .flatMap(d => d.volumes)
      .filter(v => v.pvc == volume || v.image.name == volume)
      .first()

    if (!vol) throw fail(`Volume not found: ${namespace}/${deployment}/${volume}`)

    let snaps = vol.snapshots;
    await this.consolidateSnapshots(snaps);

    let snap : Snapshot|undefined = snaps.find(x => x.name == snapshot);
    if (!snap) throw fail(`No such snapshot: ${namespace}/${deployment}/${volume}@${snapshot}`)

    let alldeps : Snapshot[] = [];
    for (let x: Snapshot|undefined = snap; x != undefined; x = x.dependsOn) alldeps.push(x);
    alldeps.reverse();
    let importables = alldeps.filter(x => !x.hasSnapshot);
    let importableNames = importables.map(x => x.file);
    let evictables = snaps.slice(snaps.indexOf(snap) + 1).filter(x => x.hasSnapshot);
    let evictableNames = evictables.map(x => x.name);
    let script = dedent`
        dir=${vol.getDirectory()}
        pool=${snap.volume.image.pool}
        image=${snap.volume.image.name}
        importables="${importableNames.join(' ')}"
        evictables="${evictableNames.join(' ')}"
        sname=${snap.name}
        cd $dir &&
        echo "Working directory: $dir" &&
        echo "Importing snapshots [$importables] into image $pool/$image..." &&
        for i in $importables; do echo "- $i" && rbd import-diff --image $pool/$image <(gunzip -c $i) ; done &&
        echo "Reverting image $pool/$image to selected snapshot $sname..." &&
        rbd snap revert $pool/$image@$sname &&
        echo "Removing obsolete snapshots..." &&
        for i in $evictables; do echo "- $i"; rbd snap rm --image $pool/$image --snap $i; done &&
        echo OK || echo ERROR
      `;
    log.info('Restoring from backup: %s/%s/%s/%s. Importing snapshots [%s], reverting to [%s], removing obsolete [%s]',
      namespace, deployment, vol.pvc, vol.image.name,
      importables.map(x => x.name).join(','),
      snap.name,
      evictables.map(x => x.name).join(', '),
    );
    let result = await this.invokeToolbox(script).catch(report);
    log.debug('Script output:\n%s', result);
  }

}
