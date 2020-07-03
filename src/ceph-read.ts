import {Namespace} from "./cfg";
import {CephCore} from "./ceph-core";
import {log} from "./log";
import printf = require("printf");
import {renameSync} from "fs";

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

  async list(namespace?:string, workload?:string) {
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
              if (v.snapshots.length == 0) report.push(printf('%6s%s', '', '(no snapshots)'))
              else v.snapshots.forEach(s => {
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

  async listAll() : Promise<string> {
    let namespaces = await this.listNamespaces()
    await namespaces.forEachAsync(async (ns) => await this.loadNamespace(ns));

    namespaces.sort((a, b) => a.name.localeCompare(b.name));
    namespaces.flatMap(x => x.deployments).sort((a, b) => a.name.localeCompare(b.name));
    namespaces.flatMap(x => x.deployments).flatMap(x => x.volumes).sort((a, b) => a.pvc.localeCompare(b.pvc));

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
          if (v.snapshots.length == 0) report.push(printf('%6s%s', '', '(no snapshots)'))
          else v.snapshots.forEach(s => {
            // minor fixup for reporting to avoid user confusion:
            s.isDeleteSnapshot = s.hasSnapshot && s.isDeleteSnapshot;
            s.isDeleteFile = s.hasFile && s.isDeleteFile;
            report.push(printf('%6s%s', '', s.consolidationInfo()))
          })
        })
      })
    });
    let out = report.join('\n');
    log.debug('Report:\n%s', out);
    return out;
  }

}
