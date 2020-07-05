import {cfg, Snapshot} from "./cfg";
import {CephCore} from "./ceph-core";
import {log} from "./log";
import printf = require("printf");
import {getFileSizeString} from "./utils";

export class CephRead extends CephCore {

  async search(q:string, namespace?:string) : Promise<string> {
    let nsall = (await this.listNamespaces()).filter(n => !namespace || n.name == namespace)
    await nsall.forEachAsync(async (ns) => await this.loadNamespace(ns));

    let re = new RegExp(q)
    let namespaces = nsall.filter(ns => re.test(ns.name))
    let deployments = nsall.flatMap(ns => ns.deployments).filter(d => re.test(d.name))
    let vols = nsall.flatMap(ns => ns.deployments).flatMap(d => d.volumes).filter(v => re.test(v.pvc) || re.test(v.image.name))

    let report : string[] = []
    report.push('Namespaces:')
    namespaces.forEach(x => report.push(printf('- %s', x.name)))
    report.push('Deployments:')
    deployments.forEach(d => report.push(printf('- %s/%s', d.namespace, d.name)))
    report.push('Volumes:')
    vols.forEach(v => report.push(printf('- %s/%s/%s (%s/%s)', v.deployment.namespace, v.deployment.name, v.pvc, v.image.pool, v.image.name)))

    return report.join('\n')
  }

  async list(namespace?:string, workload?:string, allSnapshots:boolean=false) {
    // load/filter
    let namespaces = (await this.listNamespaces()).filter(n => !namespace || n.name == namespace)
    await namespaces.forEachAsync(async (ns) => await this.loadNamespace(ns));
    namespaces.forEach(n => n.deployments = n.deployments.filter(d => !workload || d.name == workload))

    // sort
    namespaces.sort((a, b) => a.name.localeCompare(b.name));
    namespaces.forEach(n => n.deployments.sort((a, b) => a.name.localeCompare(b.name)));
    namespaces.flatMap(n => n.deployments).forEach(d => d.volumes.sort((a, b) => a.pvc.localeCompare(b.pvc)))

    // render
    let report : string[] = [];
    namespaces
      .filter(ns => ns.deployments.flatMap(d => d.volumes).length > 0)
      .forEach(ns => {
        report.push(ns.name);
        ns.deployments
          .filter(d => d.volumes.length > 0)
          .forEach(d => {
            report.push(printf('%2s%s', '', d.name));
            d.volumes.forEach(v => {
              report.push(printf('%4s%s (%s)', '', v.pvc, v.image.name));
              if (v.snapshots.length == 0) {
                report.push(printf('%6s%s', '', '(no snapshots)'))
                return
              }
              let latest : Snapshot[] = []
              for (let x : Snapshot|undefined = v.snapshots.last(); x; x = x.dependsOn) latest.push(x)
              v.snapshots
                .filter(x => allSnapshots || latest.contains(x))
                .forEach(s => {
                // minor fixup for reporting to avoid user confusion:
                s.isDeleteSnapshot = s.hasSnapshot && s.isDeleteSnapshot;
                s.isDeleteFile = s.hasFile && s.isDeleteFile;
                report.push(printf('%6s%s', '', s.consolidationInfo()))
              })
            })
          })
      });
    return report.join('\n');
  }


}
