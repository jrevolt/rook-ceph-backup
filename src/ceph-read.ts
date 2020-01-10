import {Namespace} from "./cfg";
import {CephCore} from "./ceph-core";
import {log} from "./log";
import printf = require("printf");

export class CephRead extends CephCore {

  async listAll() : Promise<string> {
    let namespaces: Namespace[] = [];
    await this.processAllNamespaces(ns => namespaces.push(ns));

    namespaces.sort((a, b) => a.name.localeCompare(b.name));
    namespaces.flatMap(x => x.deployments).sort((a, b) => a.name.localeCompare(b.name));
    namespaces.flatMap(x => x.deployments).flatMap(x => x.volumes).sort((a, b) => a.pvc.localeCompare(b.pvc));

    let report : string[] = [];
    namespaces.forEach(ns => {
      report.push(ns.name);
      ns.deployments.forEach(d => {
        report.push(printf('%2s%s', '', d.name));
        d.volumes.forEach(v => {
          report.push(printf('%4s%s (%s)', '', v.pvc, v.pv));
          v.snapshots.forEach(s => {
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
