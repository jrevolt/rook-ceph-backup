# k8s

## Backup 

Based on GFS strategy (grandfather-father-son):

 - daily backup (max 7d)
 - weekly backup (max 4w)
 - monthly backup (max 3 months)
 
All values configurable.

### Actions

 - **snapshot** - create live RDB snapshot for all images
 - **backup** - export all image snapshots (idempotent, diff against previous snapshot)
 - **consolidate** - considering configured limits for maximum daily/weekly/monthly snasphots, 
    - remove all obsolete snapshots and associated backup files
    - reexport all snapshots depending on removed snapshots
    
### Scheduling

 - snapshot: daily @ 17:00
 - backup: daily after snasphot, before VM backup @ 19:00
 - consolidate: weekly, after weekly backup, typically Monday 2:00  

### Processing

#### RBD Image resolution 

Configuration specifies list of namespace/deployment values.

For every namespace:

 - Use `kubectl` to get JSON details for all deployments, stateful sets, pods and persistent volume claims (`kubectl -n $namespace get deployment,statefulset,pod,pvc -o json`)
 - cache this information
 
For every deployment:

 - find it by name among deployments/statefulsets
 - use selector to find all pods
 - for all matching pods, resolve all PVC references using Ceph RBD storage class (`backup.storageClassName`)
 - extract claim names from pod's PVC references
 - find all PVCs matching the used claim names
 - and finally, resolved PVC's `volumeName` attribute refers to RBD image
 
For every volume / image:

 - use `kubectl` to access `rook-ceph-operator` to list snapshots associated with the given image         

#### GFS Backup Processing

System starts with **daily** backups.

#### Full Backup

Full backup is always based on first (oldest) snapshot.

After the series of daily snapshots, several (4) snapshots are promoted to weekly backups (Sunday, typically).

As the time passes, snapshots created on 1st day of month are promoted to monthly backups.

When the oldest montlhy snapshot is dropped, next snapshot in line becomes the oldest snapshot and it is used to export full image backup. 

This typically happens first Monday after the 1st day of month, when the regular backup consolidation is scheduled.   
   

            
  
