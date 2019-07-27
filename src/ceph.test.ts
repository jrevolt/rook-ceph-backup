import { Ceph } from './ceph';
import {cfg, Snapshot} from "./cfg.js";
import moment from "moment";
import {monitorEventLoopDelay} from "perf_hooks";

test('Ceph.consolidateSnapshots', () => {
  let snaps : Snapshot[] = [];
  for (let i=0; i<120; i++) {
    let timestamp = moment('20191010', 'YYYYMMDD').add(i, 'd').toDate();
    snaps.push(new Snapshot({timestamp: timestamp}));
  }
  let result = new Ceph().consolidateSnapshots(snaps);
  let strings = result.map(x => moment(x.timestamp).format('YYYYMMDD ddd'));
  let expected = [
    '20191101 Fri',
    '20191201 Sun',
    '20200101 Wed',
    '20200105 Sun',
    '20200112 Sun',
    '20200119 Sun',
    '20200126 Sun',
    '20200131 Fri',
    '20200201 Sat',
    '20200202 Sun',
    '20200203 Mon',
    '20200204 Tue',
    '20200205 Wed',
    '20200206 Thu',
  ];
  expect(strings).toStrictEqual(expected);
});
