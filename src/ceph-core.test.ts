import {Deployment, Namespace, Volume} from "./cfg";
import {CephCore} from "./ceph-core";
import * as stream from "stream";
import * as streambuffers from 'stream-buffers';

test('remove snapshots', async () => {
  jest.setTimeout(60000)
  let ceph = new CephCore();
  await ceph.resolveToolbox()
  await ceph.loadNamespaces()
  // await ceph.removeAllSnapshots()
})

test('streams', () => {
  new streambuffers.WritableStreamBuffer()
})
