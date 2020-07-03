import {CephBackup} from "./ceph-backup";
import {INamespace} from "./ceph";
import {fail} from "assert";
import {cfg, Volume} from "./cfg";

let ceph : CephBackup
let vol : Volume

beforeEach(async () => {
  cfg.toString()
  ceph = new CephBackup()
  await Promise.all([
    ceph.loadNamespaceModel('default'),
    ceph.resolveToolbox(),
  ])
  await ceph.loadNamespaces()
  vol = ceph.namespaces.flatMap(ns => ns.deployments.flatMap(d => d.volumes)).first()
})

test('snapshot', async () => {
  await ceph.createSnapshot(vol)
})

test('backup', async () => {
  await ceph.backupVolume(vol)
})
