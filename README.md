# Rook Ceph Backup Tools

## Problem

Typical universal cloud backup strategy is generally like this:
 - regular snapshot of the virtual machines
 - export the snapshot to backup location

With Ceph cluster and its distributed/replicated nature, VM snapshot strategy has several serious drawbacks and flaws:
 - VM snapshots are huge even if the actual logical data increment is relatively small. This is because not only data is replicated in Ceph cluster (which causes data multiplications in VM snapshot), Ceph also rearranges data in a cluster at will according to its own internal algorithms (which causes false diffs in VM snapshot)
 - Ceph cluster is a storage solution with its own internal logical structures like pools/images/filesystems. These structures are typically independent but share storage infrastructure. VM snapshot strategy does not have any idea about this, nor can it support this in any meaningful way.
 - With VM snapshots, you always backup/restore full cluster, not individual structures.
 - VM snapshots are usually created and processed in sequence that may easily span over an hour for large clusters, and this may introduce inconsistencies, when restoring cluster from the VM snapshots created in different times. (A workaround for this may be creating VM snapshots for all Ceph VMs at the same time)
 - Restore operation causes downtime of the whole cluster and all services that depend on it.

## Solution

Backup:
- use Ceph RBD snapshots
- export these snapshots to a dedicated shared file system like NFS
  - use configurable full/differential/incremental strategy for snapshot exports
- backup NFS as usual (e.g. VM snapshots or rsync)
- schedule your backup workflow:
  - create daily snapshot at appropriate time (e.g. end of working hours)
  - run actual backup (snapshot export) at appropriate time (e.g. between snapshot time and planned VM snapshot of NFS target
  - consolidate snapshots/archives regularly (e.g. after NFS VM snapshot and before start of working hours)
    - configure suitable retention policy for backup archives


Restore:
- restore NFS source, if needed
- import all necessary backup archives as RBD snapshots into the target Ceph RBD image
- use RBD tools to revert to a selected RBD snapshot (stop application before final revert-to-snapshot operation)

## Implementation

### Backup

Based on GFS strategy (grandfather-father-son):

 - **monthly** backup is always a full backup. Typically scheduled on 1st day of the month or a a 1st Sunday of the month (configurable)
 - **weekly** backup is differential, with latest *monthly/full* used as baseline. Typically scheduled on a given day of week, e.g. Sunday (configurable).
 - **daily** backup is incremental, with most recent *daily* or *weekly* backup used as baseline. Typically scheduled on a given time in day, e.g. 17:00 (determined by the time `snapshot` command is executed)

#### Retention Policy

**RBD Image Snapshots**

To release the space occupied by snapshots in Ceph cluster, RBD snapshots are deleted from Ceph after successful export to backup archives. However, some of the snapshots must be preserved to allow streamlined future backup processing:

 - 0..1 latest monthly snapshot, to provide baseline for weekly diffs.
 - 0..1 latest weekly snapshot, to provide baseline for daily increments. If missing, latest *monthly* is used.
 - 0..1 latest daily increment, to provide baseline for next increment. If missing, latest *weekly* is used as baseline.

**Exported Backup Archives**

System keeps configured maximum number of monhtly/weekly/daily backups, and automatically removes older, obsolete backups to reclaim space.

Following have been considered reasonable defaults (which can be overridden in configuration):

 - 3 monthly full backups
 - 4 weekly diffs
 - 7 daily increments

**Dependencies**

*Weekly diffs* depend on *monthlies*, and *daily increments* depend on other *dailies* or *weeklies*. This means that for every backup, system must keep all its dependencies, and may have to postpone eviction of the obsolete backups until the dependant backups are also evicted.

### Snapshot Naming and Hierarchy

RBD snapshots are named automatically depending on actual time, using template `YYYYMMDD-HHmmss` (configurable).
This name is used to infer snapshot time, whether the information is loaded from backup archives (NFS) or live RBD snapshots.
Actual file or snapshot timestamps are ignored entirely.

In Ceph RBD image, there is no distinction between monthly/weekly/daily snapshots, all snapshots are equal.
Backup type (monthly/weekly/daily) of a given snapshot is determined during the export to a file, when the baseline snapshot is elected.

### Scheduling

System does not have internal scheduling. Instead, it relies on existing services (OS cron, K8S cron jobs, etc).

Backup points are driven by Ceph RBD **snapshots**. Creating a RBD snapshot is fast and lightweight operation, and can be done anytime. Snapshot creation is done using `snapshot` command, and it effectively determines state in time to where one can later revert using `restore` command.

Actual **backup** process (export to file) basically migrates the backup data outside the Ceph cluster to safe external storage to allow disaster recovery when Ceph cluster and its data need to be restored.
This process should be typically scheduled to run outside working hours but can also be run immediately after snapshot creation.

**Consolidation** is a complementary process responsible for reclaiming the space:
- deletes obsolete backup archives (driven by configured retention policy)
- removes obsolete snapshots (keeps only those not yet exported or those needed for future exports)

During the backup, the type of a given snapshot export is determined according to configurable rules:

 - **monthly** backup starts on a fixed day of month, or a first day of week in a given month (e.g. 1st day of month, or first Sunday in a given month).
 - **weekly** starts on a specific day of week
 - **daily** is the default type, unless the backup is promoted to weekly or monthly, depending on the above mentioned rules.

 No matter what the actual day or day of week is, backup hierarchy always starts with initial full monthly backup, followed be initial weekly diff, and a bunch of subsequent daily backups.

 System will not start with incremental backups, unless there is at least one weekly diff backup, and it won't create weekly backups unless there is at least one monthly full baseline.

 More formally:

 ```
[monthly,[weekly,[daily*]*]*]*
or:
[full,[diff,[inc*]*]*]*
```

## Configuration

## Usage

```
Usage: rbdtools [options] [command]

Rook Ceph Backup Tools

Options:
  -V, --version                output the version number
  -d, --debug
  -q, --quiet
  -n, --namespace <namespace>
  -w, --workload <workload>
  -h, --help                   display help for command

Commands:
  search [options] [query]     Search for namespaces/workloads/volumes/images
  ls [options]                 List namespaces/workloads/volumes/images/snapshots
  du [options]                 Report disk usage for namespaces/workloads/volumes
  snapshot [options]           Create new snapshot of a volume's image
  backup [options]             Export backups for previously created snapshot(s)
  consolidate [options]        Consolidate backup archives/snapshots
  restore [options]            Restore volume/image state from a live/exported snapshot
  remove-snapshot [options]    Remove snapshot
  remove-backup [options]      Remove backup archives
  help [command]               display help for command
```
**search**

```
Usage: rbdtools search [options] [query]

Search for namespaces/workloads/volumes/images

Options:
  -n, --namespace <namespace>  Search only in this namespace
```

```
$ rbdtools search -n default
Namespaces:
- default
Deployments:
- default/alpine
Volumes:
- default/alpine/vol1-alpine-0 (rbd/csi-vol-a822aae7-c0ec-11ea-a0e6-864cd8ef41c2)
```

**ls**

```
Usage: rbdtools ls [options]

List namespaces/workloads/volumes/images/snapshots

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
  -a, --all-snapshots          List all snapshots/backups. by default, only latest ful/dif/inc chain is listed
```

```
$ rdbtools ls -n default

default
  alpine
    vol1-alpine-0 (csi-vol-a822aae7-c0ec-11ea-a0e6-864cd8ef41c2)
      [M][20200709-115102][has:SF][evict:--][file: 36K|20200709-115102-ful.gz]
      [W][20200709-124001][has:SF][evict:--][file:  4K|20200709-124001-dif-20200709-115102.gz]
      [D][20200709-124009][has:SF][evict:--][file:  4K|20200709-124009-inc-20200709-124001.gz]
```

How to read this report:

```
namespace
  workload
    PVC-Name (RBD-image)
      [M][20191107-135200][has:SF][evict:--][file:350K|20191107-135200-ful.gz]
      [W][20191107-150000][has:SF][evict:--][file:  5K|20191107-150000-dif-20191107-135200.gz]
      [D][20191107-150500][has:-F][evict:--][file:  1K|20191107-150500-inc-20191107-150000.gz]
       |  |                |       |         |         |--snapshot---|  |  |--baseline---|
       |  |                |       |         + file size/name           +- type of backup (full/differential/incremental)
       |  |                |       + objects scheduled for eviction (Snapshot|File)
       |  |                + available objects (Snapshot|File)
       |  + snapshot name, format YYYYMMDD-HHmmss
       + backup type (Monthly|Weekly|Daily)
```

**du**

```
Usage: rbdtools du [options]

Report disk usage for namespaces/workloads/volumes

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
```

```
[ 44K] default
[ 44K]   alpine
[ 44K]     vol1-alpine-0 (csi-vol-a822aae7-c0ec-11ea-a0e6-864cd8ef41c2)
[ 44K] [total]
Filesystem                       Size  Used Avail Use% Mounted on
nfs.local:/nfs/rook-ceph-backup  122G   84G   39G  69% /backups
```

**snapshot**

```
Usage: rbdtools snapshot [options]

Create new snapshot of a volume's image

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
  --all-namespaces
  --all-workloads
```

**backup**

```
Usage: rbdtools backup [options]

Export backups for previously created snapshot(s)

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
  -s, --make-snapshot          Create snapshot before starting volume backup. By defaults, backs up only new/unexported snapshots
  -t, --type <type>            Backup type: (monthly|full)|(weekly|diff)|(daily|inc). Defaults to automatic selection.
  --all-namespaces
  --all-workloads
```

**consolidate**

```
Usage: rbdtools consolidate [options]

Consolidate backup archives/snapshots

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
  --all-namespaces
  --all-workloads
```

**restore**

```
Usage: rbdtools restore [options]

Restore volume/image state from a live/exported snapshot

Options:
  -n, --namespace <namespace>
  -w, --workload <workload>
  -v, --volume <volume>
  -s, --snapshot <snapshot>
```

Find available parameters using `ls` command, and pass them to `restore`, e.g.:

```
$ rbdtools ls -n default -w alpine

default
  alpine
    vol1-alpine-0 (csi-vol-a822aae7-c0ec-11ea-a0e6-864cd8ef41c2)
      [M][20200709-115102][has:SF][evict:--][file: 36K|20200709-115102-ful.gz]
      [W][20200709-124001][has:SF][evict:--][file:  4K|20200709-124001-dif-20200709-115102.gz]
      [D][20200709-124009][has:SF][evict:--][file:  4K|20200709-124009-inc-20200709-124001.gz]
```

```
$ rbd restore -n default -w alpine -v vol1-alpine-0 -s 20200709-124009
...
2020-07-09T11:00:41.873Z|INF|restore| Restoring from backup: default/alpine/vol1-alpine-0/csi-vol-a822aae7-c0ec-11ea-a0e6-864cd8ef41c2. Importing snapshots [20200709-115102,20200709-124001,20200709-124009], reverting to [20200709-124009], removing obsolete []
Importing image diff: 100% complete...done.
Importing image diff: 100% complete...done.
Importing image diff: 100% complete...done.
Rolling back to snapshot: 100% complete...done.
2020-07-09T11:00:44.721Z|INF|restore| Finished command [restore] in 3258 msec.
```

## Notes

- usually, it is a good idea to turn off (scale=0) the deployment which is using volumes being restored.
- after succesful restore, consider restarting the backup process:
  - purge all snapshots
  - remove all backup archives
  - create new initial snapshot
  - run initial full monthly backup

## Future Releases

- optional/configurable: stop workload (scale=0) before taking snapshot, restore afterwards (scale=X)
- stop workload before restore (mandatory; must be handled manually at the moment)
- improve consistency of backup sequence after restore; work is in progress regarding the post-restore reliability and robustness of the backup process (at the moment it is recommended to reset the backup process after restore)

