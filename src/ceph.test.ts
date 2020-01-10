import {BackupType, cfg, Snapshot, Volume} from "./cfg";
import moment from "moment";
import extend from "extend";
import * as utils from "./utils";
import {findFirstDayOfMonthByWeekday, Weekday} from "./utils";
import {CephCore} from "./ceph-core";

utils.qdhImportGlobals();

test('findFirstDayOfMonthByWeekday', () => {
  let fmt = 'YYYYMMDD';
  expect(findFirstDayOfMonthByWeekday(moment('20190101').toDate(), Weekday.Sunday)).toBe(6);
});

test('consolidateSnapshots: extra full', () => {
  let snaps = generateSnapshots('20190102', 10);
  let result = new CephCore().consolidateSnapshots(snaps);
  let diffs = result.filter(x => x.backupType == BackupType.monthly);
  expect(diffs.length).toBe(1);
  expect(diffs.first().timestamp).toStrictEqual(moment('20190102').toDate());
});

test('consolidateSnapshots: extra diff', () => {
  let snaps = generateSnapshots('20190101', 10);
  let result = new CephCore().consolidateSnapshots(snaps);
  let diffs = result.filter(x => x.backupType == BackupType.weekly);
  expect(diffs.length).toBe(2);
  expect(diffs.first().name).toBe('20190102');
  expect(diffs.last().timestamp.getDay()).toBe(Weekday.Sunday);
});

test('consolidateSnapshots: long', () => {
  let snaps = new CephCore().consolidateSnapshots(generateSnapshots('20190101', 120));
  expect(snaps.filter(x => x.backupType == BackupType.monthly).length).toBe(cfg.backup.monthly.max);
  expect(snaps.filter(x => x.backupType == BackupType.weekly).length).toBe(cfg.backup.weekly.max);
  expect(snaps.filter(x => x.backupType == BackupType.daily).length).toBe(8); // since latest diff + previous week
});

test('consolidateSnapshots: check days', () => {
  let snaps = new CephCore().consolidateSnapshots(generateSnapshots('20190101', 120));
  expect(new Set(snaps.filter(x => x.backupType == BackupType.monthly).map(x => x.timestamp.getDate()))).toStrictEqual(new Set([1]));
  expect(new Set(snaps.filter(x => x.backupType == BackupType.weekly).map(x => x.timestamp.getDay()))).toStrictEqual(new Set([Weekday.Sunday]));
});

test('consolidateSnapshots: random', () => {
  let iterations = 3;
  while (iterations-- > 0) {
    let count = Math.floor(Math.random() * 999) + 120;
    let snaps = new CephCore().consolidateSnapshots(generateSnapshots('20190101', count));
    expect(snaps.filter(x => x.backupType == BackupType.monthly).length).toBe(cfg.backup.monthly.max);
    expect(snaps.filter(x => x.backupType == BackupType.weekly).length).toBe(cfg.backup.weekly.max);
    expect(snaps.filter(x => x.backupType == BackupType.daily).length).toBeGreaterThanOrEqual(cfg.backup.daily.max);
    expect(new Set(snaps.filter(x => x.backupType == BackupType.monthly).map(x => x.timestamp.getDate()))).toStrictEqual(new Set([1]));
    expect(snaps.filter(x => x.backupType == BackupType.weekly).map(x => x.timestamp.getDay()).last()).toBe(Weekday.Sunday);
  }
});

test('consolidateSnapshots: evictions', () => {
  let snaps = generateSnapshots('20191010', 120, new Snapshot({hasSnapshot: true}));
  let result = new CephCore().consolidateSnapshots(snaps);
  expect(result.filter(x => x.backupType == BackupType.monthly).length).toEqual(2);
  expect(result.filter(x => x.backupType == BackupType.monthly && x.hasSnapshot && !x.isDeleteSnapshot).length).toEqual(1);
  expect(result.filter(x => x.backupType == BackupType.monthly && x.hasSnapshot && !x.isDeleteSnapshot).first().name).toBe('20200201');
  expect(result.filter(x => x.backupType == BackupType.weekly).length).toEqual(2);
  expect(result.filter(x => x.backupType == BackupType.weekly && x.hasSnapshot && !x.isDeleteSnapshot).length).toEqual(1);
  expect(result.filter(x => x.backupType == BackupType.weekly && x.hasSnapshot && !x.isDeleteSnapshot).first().name).toBe('20200202');
  expect(result.filter(x => x.backupType == BackupType.daily).length).toEqual(9);
  expect(result.filter(x => x.backupType == BackupType.daily && x.hasSnapshot && !x.isDeleteSnapshot).length).toEqual(1);
  expect(result.filter(x => x.backupType == BackupType.daily && x.hasSnapshot && !x.isDeleteSnapshot).first().name).toBe('20200206');
});

// test('resolveFromSnapshot: inc', () => {
//   let snaps = generateSnapshots('20190102', 10, <Snapshot>{backupType: BackupType.incremental});
//   let result = ceph.resolveFromSnapshot(snaps.last());
//   expect(result.name).toBe('20190110');
// });
//
// test('resolveFromSnapshot: inc on diff', () => {
//   let snaps = generateSnapshots('20190102', 10, <Snapshot>{backupType: BackupType.differential});
//   snaps.first().backupType = BackupType.full;
//   snaps.last().backupType = BackupType.incremental;
//   let result = ceph.resolveFromSnapshot(snaps.last());
//   expect(result.name).toBe('20190110');
// });
//
// test('resolveFromSnapshot: diff', () => {
//   let snaps = generateSnapshots('20190102', 10, <Snapshot>{backupType: BackupType.differential});
//   snaps.first().backupType = BackupType.full;
//   let result = ceph.resolveFromSnapshot(snaps.last());
//   expect(result.name).toBe(snaps.first().name);
// });
//
// test('resolveFromSnapshot: full', () => {
//   let snaps = generateSnapshots('20190102', 10, <Snapshot>{backupType: BackupType.full});
//   let result = ceph.resolveFromSnapshot(snaps.last());
//   expect(result).toBeUndefined();
// });

function createSnapshots(names : string[]) : Snapshot[] {
  return names.map(x => new Snapshot({name: x, timestamp: moment(x, 'YYYYMMDD').toDate()}));
}

function generateSnapshots(initial: string, count: number, template : Snapshot = null) : Snapshot[] {
  let snaps : Snapshot[] = [];
  let vol = new Volume({snapshots: snaps});
  let format = 'YYYYMMDD';
  for (let i=0; i<count; i++) {
    let timestamp = moment(initial, format).add(i, 'd');
    let name = timestamp.format(format);
    let snap = extend(new Snapshot({name: name, timestamp: timestamp.toDate(), volume: vol, hasSnapshot: true}), template);
    snaps.push(snap);
  }
  return snaps;
}

function generateName(s : string) : string {
  let format = 'YYYYMMDD';
  return moment(s, format).format(format);
}
