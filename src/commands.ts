import {Main} from "./main";
import {fail} from "./utils";
import {CephCore} from "./ceph-core";
import {CephRead} from "./ceph-read";
import {log} from "./log";
import {CephBackup} from "./ceph-backup";
import {CephRestore} from "./ceph-restore";
import assert from "assert";

export function registerCommands(main: Main) {
  main.program
    .option('-d, --debug')
    .option('-q, --quiet')
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-A, --all-namespaces')
  main.program
    .command('search [query]')
    .description("Search for namespaces/workloads/volumes/images")
    .action(main.wrap(search))
  main.program
    .command('ls')
    .description("List namespaces/workloads/volumes/images/snapshots")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-a, --all-snapshots')
    .action(main.wrap(list))
  main.program
    .command('du')
    .description("Report disk usage for namespaces/workloads/volumes")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .action(main.wrap(du))
  main.program
    .command('snapshot')
    .description("Create new snapshot of a volume's image")
    .option('-w, --workload <workload>')
    .action(main.wrap(snapshot))
  main.program
    .command('backup')
    .description("Export backups for previously created snapshot(s)")
    .option('-w, --workload <workload>')
    .action(main.wrap(backup))
  main.program
    .command('consolidate')
    .description("Consolidate backup archives/snapshots")
    .option('-w, --workload <workload>')
    .action(main.wrap(consolidate))
  main.program
    .command('restore')
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-v, --volume <volume>')
    .option('-s, --snapshot <snapshot>')
    .description("Restore volume/image state from a live/exported snapshot")
    .action(main.wrap(restore))
  main.program
    .command('remove-snapshots')
    .description("Remove snapshot")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-v, --volume <volume>')
    .option('-s, --snapshot <snapshot>')
    .action(main.wrap(removeSnapshots))
  main.program
    .command('remove-backups')
    .description("Remove backup archives")
    .option('-n, --namespace [namespace]')
    .option('-w, --workload [workload]')
    .action(main.wrap(removeBackupArchives))
}

async function notYetImplemented(opts:any) {
  console.log(opts)
  console.error('not yet implemented!')
}

function err(msg) : never {
  console.error(msg)
  process.exit(1)
}

export class Options {
  quiet: boolean
  debug: boolean
  namespace: string
  workload: string
  allNamespaces: boolean
}


export interface SearchOptions extends Options {
  namespace: string
}

export async function search(opts:SearchOptions, q:string = '.*') {
  log.debug(`Searching: ${q}`)
  let result = await new CephRead().search(q, opts.namespace)
  console.log(result)
}

export interface ListOptions extends Options {
  namespace: string
  workload: string
  allSnapshots: boolean
}

export async function list(opts: ListOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  let result = await new CephRead().list(opts.namespace, opts.workload, opts.allSnapshots)
  console.log(result)
}

export interface DuOptions extends Options {
  namespace: string
  workload: string
}

export async function du(opts) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  let result = await new CephRead().diskUsage(opts.namespace, opts.workload)
  console.log(result)
}

export interface SnapshotOptions extends Options {
  namespace: string
  workload: string
}

export async function snapshot(opts: SnapshotOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  await new CephBackup().createSnapshotAll(opts.namespace, opts.workload)
}

export interface BackupOptions extends Options {
  namespace: string
  workload: string
}

export async function backup(opts: BackupOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  await new CephBackup().backupVolumeAll(opts.namespace, opts.workload)
}

export interface ConsolidateOptions extends Options {
  workload: string
}

export async function consolidate(opts: ConsolidateOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  await new CephBackup().consolidateAll(opts.namespace, opts.workload)
}

export interface RestoreOptions extends Options {
  namespace: string
  workload: string
  volume: string
  snapshot: string
}

export async function restore(opts: RestoreOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.volume || opts.snapshot || err('workload/volume/snapshot?')
  await new CephRestore().restoreFromSnapshot(opts.namespace, opts.workload, opts.volume, opts.snapshot)
}

export interface RemoveSnapshotOptions extends  Options {
  namespace: string
  workload: string
  volume: string
  snapshot: string
}

export async function removeSnapshots(opts:RemoveSnapshotOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  await new CephBackup().cliRemoveSnapshots(opts.namespace, opts.workload, opts.volume, opts.snapshot)
}

export interface RemoveBackupsOptions extends Options {
}

export async function removeBackupArchives(opts:RemoveBackupsOptions) {
  opts.namespace || err('Namespace?')
  opts.workload || err('Workload?')
  await new CephBackup().removeBackupArchives(opts.namespace, opts.workload)
}
