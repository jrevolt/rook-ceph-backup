# Rook Ceph Backup Tools

## Problem

Typical cloud backup strategy is generally like this:
 - regular snapshot of the virtual machines
 - export the snapshot to backup location

With Ceph cluster and its distributed/replicated nature, VM snapshots strategy have several serious drawbacks and flaws:
 - VM snapshots are huge even if the actual logical data increment is relatively small. This is because not only data is replicated in Ceph cluster (which causes data multiplications in VM snapshot), Ceph also rearranges data in a cluster at will according to its own internal algorithms (which causes false diffs in VM snapshot)
 - Ceph cluster is a storage solution with its own internal logical structures like pools/images/filesystems. These structures are typically independent but share storage infrastructure. VM snapshot strategy does not have any idea aboout this, nor can it support this in any meaningul way.
 - With VM snapshots, you always backup/restore full cluster, not individual structures.
 - VM snapshots are usually created and processed in sequence that may easily span over an hour for large clusters, and this may introduce inconsistencies, when restoring cluster from the VM snapshots created in different times. (A workaround for this may be creating VM snapshots for all Ceph VMs at the same time)
 - Restore operation causes downtime of the whole cluster and all services that depend on it.

## Solution

Backup:
- use Ceph RBD snapshots
- export these snapshots to a dedicated shared file system like NFS
- backup NFS as usual (e.g. VM snapshots or rsync)

Restore:
- restore NFS source, if needed
- import all necessary backup archives as RBD snapshots into the target Ceph RBD image
- use RBD tools to revert to a selected RBD snapshot

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

 - 3 monthly backups
 - 4 weekly
 - 7 daily

**Dependencies**

*Weekly diffs* depend on *monthlies*, and *daily increments* depend on other *dailies* or *weeklies*. This means that for every backup, system must keep all its dependencies, and may have to postpone eviction of the obsolete backups until the dependant backups are also evicted.

### Snapshot Naming and Hierarchy

RBD snapshots are named automatically depending on actual time, using template `YYYYMMDD-HHmm`.
This name is used to infer snapshot time, whether the information is loaded from backup archives (NFS) or live RBD snapshots.
Actual file or snapshot timestamps are ignored entirely.

In Ceph RBD image, there is no distinction between monthly/weekly/daily snapshots, all snapshots are equal.
Backup type (monthly/weekly/daily) of a given snapshot is determined during the export to file.

### Scheduling

System does not have internal scheduling. Instead, it relies on existing services (OS cron, K8S cron jobs, etc).

Backup points are driven by Ceph RBD snapshots. Creating a RBD snapshot is fast and lightweight operation, and can be done anytime. Snapshot creation is done using `snapshot` command, and it effectively determines state in time to where one can later revert using `restore` command.

Actual backup process (export to file) basically migrates the backup data outside the Ceph cluster to safe external storage to allow disaster recovery when Ceph cluster and its data need to be restored.
This process should be typically scheduled to run outside working hours but can also be run immediately after snapshot creation.

Consolidation is a complementary process responsible for reclaiming the space:
- deletes obsolete backup archives (driven by retention policy)
- removes obsolete snapshots (keeps only thos not yet exported or those needed for future exports)

During the backup, the type of a given snapshot export is determined according to configurable rules:

 - *monthly* backup starts on a fixed day of month, or a first day of week in a given month (e.g. 1st day of month, or first Sunday in a given month).
 - *weekly* starts on a specific day of week
 - *daily* is the default type, unless the backup is promoted to weekly or monthly, depending on the above mentioned rules.

 No matter what the actual day or day of week is, backup hierarchy always starts with initial full monthly backup, followed be initial weekly diff, and a bunch of subsequent daily backups.

 System will not start with incremental backups, unless there is at least one weekly backup, and it won't create weekly backups unless there is at least one monthly.

 More formally:

 ```
[monthly,[weekly,[daily*]*]*]*
```

## Configuration

## Usage

```
Usage: rbdtools [options] [command]

Options:
  -h, --help         output usage information

Commands:
  ls                 List all supported deployments/volumes/snapshots
  snapshot           Create snapshot for all supported volumes
  backup             Export all volume snapshots, if missing in destination
  consolidate        Remove obsolete backups, re-export missing ones
  restore [options]  Restore image from snapshot
```

**snapshot**

**backup**

**consolidate**

**ls**

Dumps information about the supported/recognized namespaces/deployments/volumes and detected snapshots (files+rbd)

How to read this report:

```
namespace
  deployment
    PVClaimName (PVName)
      [M][20191107-1352][has:SF][evict:--][file:350K|20191107-1352-ful.gz]
      [W][20191107-1500][has:SF][evict:--][file:  5K|20191107-1500-dif-20191107-1352.gz]
      [D][20191107-1505][has:-F][evict:--][file:  1K|20191107-1505-inc-20191107-1500.gz]
       |  |              |       |         + file size + file name        
       |  |              |       + objects scheduled for eviction (Snapshot|File)      
       |  |              + available objects (Snapshot|File)
       |  + snapshot name, format YYYYMMDD-HHmm
       + backup type (Monthly|Weekly|Daily)                                                   
```

Full example:

```
$ rbdtools ls

2019-11-08T20:31:54.495Z|DBG|ls| Executing command ls (ls)
2019-11-08T20:31:54.509Z|DBG|ls| Resolving rook-ceph-tools pod...
2019-11-08T20:31:54.744Z|DBG|ls| Loading namespace my-namespace
2019-11-08T20:31:55.110Z|DBG|ls| Resolving snapshots {namespace: my-namespace, deployment: mssql, pvc: data-mssql-0, pv: pvc-94f8fd98-98c8-11e9-91ea-00505688efe6}
2019-11-08T20:31:55.111Z|DBG|ls| Resolving snapshots {namespace: my-namespace, deployment: minio, pvc: minio-minio-0, pv: pvc-ace15c86-f652-11e9-9078-005056880054}
2019-11-08T20:31:55.112Z|DBG|ls| Resolving snapshots {namespace: my-namespace, deployment: minio, pvc: minio-minio-1, pv: pvc-ace43eea-f652-11e9-9078-005056880054}
2019-11-08T20:31:58.470Z|DBG|ls| Report:
my-namespace
  mssql
    data-mssql-0 (pvc-94f8fd98-98c8-11e9-91ea-00505688efe6)
      [M][20191107-1352][has:SF][evict:--][file:350K|20191107-1352-ful.gz]
      [W][20191107-1500][has:SF][evict:--][file:  5K|20191107-1500-dif-20191107-1352.gz]
      [D][20191107-1505][has:-F][evict:--][file:  1K|20191107-1505-inc-20191107-1500.gz]
      [D][20191107-1705][has:-F][evict:--][file: 15K|20191107-1705-inc-20191107-1505.gz]
      [D][20191107-1911][has:-F][evict:--][file:  8K|20191107-1911-inc-20191107-1705.gz]
      [D][20191107-1916][has:-F][evict:--][file:  1K|20191107-1916-inc-20191107-1911.gz]
      [D][20191107-2105][has:-F][evict:--][file:  7K|20191107-2105-inc-20191107-1916.gz]
      [D][20191107-2114][has:-F][evict:--][file:  2K|20191107-2114-inc-20191107-2105.gz]
      [D][20191107-2202][has:-F][evict:--][file:  4K|20191107-2202-inc-20191107-2114.gz]
      [D][20191107-2216][has:-F][evict:--][file:  2K|20191107-2216-inc-20191107-2202.gz]
      [D][20191107-2227][has:-F][evict:--][file:  2K|20191107-2227-inc-20191107-2216.gz]
      [D][20191107-2231][has:-F][evict:--][file:  1K|20191107-2231-inc-20191107-2227.gz]
      [D][20191108-0801][has:SF][evict:S-][file: 21K|20191108-0801-inc-20191107-2231.gz]
      [D][20191108-1705][has:SF][evict:--][file: 20K|20191108-1705-inc-20191108-0801.gz]
  minio
    minio-minio-0 (pvc-ace15c86-f652-11e9-9078-005056880054)
      [M][20191107-1352][has:SF][evict:--][file:  1K|20191107-1352-ful.gz]
      [W][20191107-1500][has:SF][evict:--][file:  0K|20191107-1500-dif-20191107-1352.gz]
      [D][20191107-1505][has:-F][evict:--][file:  0K|20191107-1505-inc-20191107-1500.gz]
      [D][20191107-1705][has:-F][evict:--][file:  0K|20191107-1705-inc-20191107-1505.gz]
      [D][20191107-1911][has:-F][evict:--][file:  0K|20191107-1911-inc-20191107-1705.gz]
      [D][20191107-1916][has:-F][evict:--][file:  0K|20191107-1916-inc-20191107-1911.gz]
      [D][20191107-2105][has:-F][evict:--][file:  0K|20191107-2105-inc-20191107-1916.gz]
      [D][20191107-2114][has:-F][evict:--][file:  0K|20191107-2114-inc-20191107-2105.gz]
      [D][20191107-2202][has:-F][evict:--][file:  0K|20191107-2202-inc-20191107-2114.gz]
      [D][20191107-2216][has:-F][evict:--][file:  0K|20191107-2216-inc-20191107-2202.gz]
      [D][20191107-2227][has:-F][evict:--][file:  0K|20191107-2227-inc-20191107-2216.gz]
      [D][20191107-2232][has:-F][evict:--][file:  0K|20191107-2232-inc-20191107-2227.gz]
      [D][20191108-0801][has:SF][evict:S-][file:  0K|20191108-0801-inc-20191107-2232.gz]
      [D][20191108-1705][has:SF][evict:--][file:  0K|20191108-1705-inc-20191108-0801.gz]
    minio-minio-1 (pvc-ace43eea-f652-11e9-9078-005056880054)
      [M][20191107-1352][has:SF][evict:--][file:  1K|20191107-1352-ful.gz]
      [W][20191107-1500][has:SF][evict:--][file:  0K|20191107-1500-dif-20191107-1352.gz]
      [D][20191107-1505][has:-F][evict:--][file:  0K|20191107-1505-inc-20191107-1500.gz]
      [D][20191107-1705][has:-F][evict:--][file:  0K|20191107-1705-inc-20191107-1505.gz]
      [D][20191107-1911][has:-F][evict:--][file:  0K|20191107-1911-inc-20191107-1705.gz]
      [D][20191107-1916][has:-F][evict:--][file:  0K|20191107-1916-inc-20191107-1911.gz]
      [D][20191107-2105][has:-F][evict:--][file:  0K|20191107-2105-inc-20191107-1916.gz]
      [D][20191107-2114][has:-F][evict:--][file:  0K|20191107-2114-inc-20191107-2105.gz]
      [D][20191107-2202][has:-F][evict:--][file:  0K|20191107-2202-inc-20191107-2114.gz]
      [D][20191107-2216][has:-F][evict:--][file:  0K|20191107-2216-inc-20191107-2202.gz]
      [D][20191107-2227][has:-F][evict:--][file:  0K|20191107-2227-inc-20191107-2216.gz]
      [D][20191107-2232][has:-F][evict:--][file:  0K|20191107-2232-inc-20191107-2227.gz]
      [D][20191108-0801][has:SF][evict:S-][file:  0K|20191108-0801-inc-20191107-2232.gz]
      [D][20191108-1705][has:SF][evict:--][file:  0K|20191108-1705-inc-20191108-0801.gz]
```

**restore**

```
$ rbdtools restore --help

Usage: rbdtools restore [options]

Restore image from snapshot

Options:
  -n, --namespace <namespace>    Namespace name
  -d, --deployment <deployment>  Deployment or statefulset name
  -v, --volume <volume>          Persistent volume claim name or persistent volume / RBD image name
  -s, --snapshot <snapshot>      Name of the RBD snapshot to restore to
  -h, --help                     output usage information

```

Find available parameters using `ls` command, and pass them to `restore`, e.g.:

```
$ rbdtools ls

my-namespace
  minio
    minio-minio-0 (pvc-ace15c86-f652-11e9-9078-005056880054)
      [M][20191107-1352][has:SF][evict:--][file:  1K|20191107-1352-ful.gz]
      [W][20191107-1500][has:SF][evict:--][file:  0K|20191107-1500-dif-20191107-1352.gz]
      [D][20191107-1505][has:-F][evict:--][file:  0K|20191107-1505-inc-20191107-1500.gz]
      [D][20191107-1705][has:-F][evict:--][file:  0K|20191107-1705-inc-20191107-1505.gz]

$ rbdtools restore \
    --namespace my-namespace \
    --deployment minio \
    --volume pvc-ace43eea-f652-11e9-9078-005056880054 \
    --snapshot 20191108-1705

2019-11-08T20:51:19.760Z|DBG|restore| Executing command restore (restore)
2019-11-08T20:51:19.781Z|DBG|restore| Resolving rook-ceph-tools pod...
2019-11-08T20:51:20.024Z|DBG|restore| Loading namespace my-namespace
2019-11-08T20:51:20.447Z|DBG|restore| Resolving snapshots {namespace: my-namespace, deployment: minio, pvc: minio-minio-0, pv: pvc-ace15c86-f652-11e9-9078-005056880054}
2019-11-08T20:51:20.448Z|DBG|restore| Resolving snapshots {namespace: my-namespace, deployment: minio, pvc: minio-minio-1, pv: pvc-ace43eea-f652-11e9-9078-005056880054}
2019-11-08T20:51:23.986Z|INF|restore| Restoring from backup: my-namespace/minio [minio-minio-1:pvc-ace43eea-f652-11e9-9078-005056880054]. Importing snapshots [20191107-1505,20191107-1705,20191107-1911,20191107-1916,20191107-2105,20191107-2114,20191107-2202,20191107-2216,20191107-2227,20191107-2232], reverting to [20191108-1705], removing obsolete []
2019-11-08T20:51:34.307Z|DBG|restore| Script output:
Importing snapshots...
Reverting to selected snapshot...
Removing obsolete snapshots...
OK 
```

*NOTES:*

- usually, it is a good idea to turn off (scale=0) the deployment which is using volumes being restored.
- after succesful restore, consider restarting the backup process:
  - purge all snapshots
  - remove all backup archives
  - create new initial snapshot
  - run initial full monthly backup
- ^^ at the moment this is the only approach that guarantees further consistency of subsequent backup sequence; work is in progress regarding the post-restore reliability and robustness of the backup process

