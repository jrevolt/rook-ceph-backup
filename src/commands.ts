import './init'
import {Main} from "./main";
import {CephRead} from "./ceph-read";
import {log} from "./log";
import {CephBackup} from "./ceph-backup";
import {CephRestore} from "./ceph-restore";
import {BackupType, BackupTypeUtils} from "./cfg";

export function registerCommands() {
  registerCommonOptions()
  registerSearchCommand();
  registerListCommand();
  registerDiskUsageCommand();
  registerSnapshotCommand();
  registerBackupCommand();
  registerConsolidateCommand();
  registerRestoreCommand();
  registerRemoveSnapshot();
  registerRemoveBackupCommand();
}

function err(msg) : never {
  console.error(msg)
  process.exit(1)
}

/// common ///

function registerCommonOptions() {
  Main.instance.program
    .option('-d, --debug')
    .option('-q, --quiet')
    // following are CLI optimizations to allow these options before command
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('--kubeconfig <kubeconfig>')
}

export class Options {
  quiet: boolean
  debug: boolean
  kubeconfig: string
}

/// search ///

function registerSearchCommand() {
  Main.instance.program
    .command('search [query]')
    .description("Search for namespaces/workloads/volumes/images")
    .option('-n, --namespace <namespace>', 'Search only in this namespace')
    .action(Main.instance.wrap(search))
}

export interface SearchOptions extends Options {
  namespace: string
}

export async function search(opts:SearchOptions, q:string = '.*') {
  log.debug(`Searching: ${q}`)
  let result = await new CephRead().search(q, opts.namespace)
  console.log(result)
}

/// ls ///

function registerListCommand() {
  Main.instance.program
    .command('ls')
    .description("List namespaces/workloads/volumes/images/snapshots")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-a, --all-snapshots', 'List all snapshots/backups. by default, only latest ful/dif/inc chain is listed')
    .action(Main.instance.wrap(list))
}

export interface ListOptions extends Options {
  namespace: string
  workload: string
  allSnapshots: boolean
}

export async function list(opts: ListOptions) {
  let result = await new CephRead().list(opts.namespace, opts.workload, opts.allSnapshots)
  console.log(result)
}

/// du ///

function registerDiskUsageCommand() {
  Main.instance.program
    .command('du')
    .description("Report disk usage for namespaces/workloads/volumes")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .action(Main.instance.wrap(du))
}

export interface DuOptions extends Options {
  namespace: string
  workload: string
}

export async function du(opts:DuOptions) {
  let result = await new CephRead().diskUsage(opts.namespace, opts.workload)
  console.log(result)
}

/// snapshot ///

function registerSnapshotCommand() {
  Main.instance.program
    .command('snapshot')
    .description("Create new snapshot of a volume's image")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('--all-namespaces')
    .option('--all-workloads')
    .action(Main.instance.wrap(snapshot))
}

export interface SnapshotOptions extends Options {
  namespace: string
  workload: string
  allNamespaces: boolean
  allWorkloads: boolean
}

export async function snapshot(opts: SnapshotOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.allWorkloads || opts.allNamespaces || err('Workload?')
  let ceph = new CephBackup();
  await ceph.createSnapshotAll(opts.namespace, opts.workload)
  console.log(await ceph.list(opts.namespace, opts.workload))
}

/// backup ///

function registerBackupCommand() {
  Main.instance.program
    .command('backup')
    .description("Export backups for previously created snapshot(s)")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-s, --make-snapshot', 'Create snapshot before starting volume backup. By defaults, backs up only new/unexported snapshots')
    .option('-t, --type <type>',
      'Backup type: (monthly|full)|(weekly|diff)|(daily|inc). Defaults to automatic selection.',
      BackupTypeUtils.fromCli)
    .option('--all-namespaces')
    .option('--all-workloads')
    .action(Main.instance.wrap(backup))
}

export interface BackupOptions extends Options {
  namespace: string
  workload: string
  makeSnapshot: boolean
  type: BackupType
  allNamespaces: boolean
  allWorkloads: boolean
}

export async function backup(opts: BackupOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.allWorkloads || opts.allNamespaces || err('Workload?')
  let ceph = new CephBackup()
  if (opts.makeSnapshot) await ceph.createSnapshotAll(opts.namespace, opts.workload)
  await ceph.backupVolumeAll(opts.namespace, opts.workload, opts.type)
  console.log(await ceph.list(opts.namespace, opts.workload, true))
}

/// consolidate ///

function registerConsolidateCommand() {
  Main.instance.program
    .command('consolidate')
    .description("Consolidate backup archives/snapshots")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('--all-namespaces')
    .option('--all-workloads')
    .action(Main.instance.wrap(consolidate))
}

export interface ConsolidateOptions extends Options {
  namespace: string
  workload: string
  allNamespaces: boolean
  allWorkloads: boolean
}

export async function consolidate(opts: ConsolidateOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.allWorkloads || opts.allNamespaces || err('Workload?')
  let ceph = new CephBackup();
  await ceph.consolidateAll(opts.namespace, opts.workload)
  console.log(await ceph.list(opts.namespace, opts.workload, true))
}

/// restore ///

function registerRestoreCommand() {
  Main.instance.program
    .command('restore')
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-v, --volume <volume>')
    .option('-s, --snapshot <snapshot>')
    .description("Restore volume/image state from a live/exported snapshot")
    .action(Main.instance.wrap(restore))
}

export interface RestoreOptions extends Options {
  namespace: string
  workload: string
  volume: string
  snapshot: string
}

export async function restore(opts: RestoreOptions) {
  opts.namespace || err('Namespace?')
  opts.workload || err('Workload?')
  opts.volume || err('Volume?')
  opts.snapshot || err('Snapshot?')
  await new CephRestore().restoreFromSnapshot(opts.namespace, opts.workload, opts.volume, opts.snapshot)
}

/// remove-snapshots ///

function registerRemoveSnapshot() {
  Main.instance.program
    .command('remove-snapshot')
    .description("Remove snapshot")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-v, --volume <volume>')
    .option('-s, --snapshot <snapshot>')
    .option('--all-namespaces')
    .option('--all-workloads')
    .option('--all-volumes')
    .option('--all-snapshots')
    .action(Main.instance.wrap(removeSnapshots))
}

export interface RemoveSnapshotOptions extends  Options {
  namespace: string
  workload: string
  volume: string
  snapshot: string

  allNamespaces: boolean
  allWorkloads: boolean
  allVolumes: boolean
  allSnapshots: boolean
}

export async function removeSnapshots(opts:RemoveSnapshotOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.allWorkloads || opts.allNamespaces || err('Workload?')
  opts.volume || opts.allVolumes || opts.allWorkloads || opts.allNamespaces || err('Volume?')
  opts.snapshot || opts.allSnapshots || opts.allVolumes || opts.allWorkloads || opts.allNamespaces || err('Snapshot?')
  await new CephBackup().cliRemoveSnapshots(opts.namespace, opts.workload, opts.volume, opts.snapshot)
}

function registerRemoveBackupCommand() {
  Main.instance.program
    .command('remove-backup')
    .description("Remove backup archives")
    .option('-n, --namespace <namespace>')
    .option('-w, --workload <workload>')
    .option('-v, --volume <volume>')
    .option('--all-namespaces')
    .option('--all-workloads')
    .option('--all-volumes')
    .action(Main.instance.wrap(removeBackupArchives))
}

export interface RemoveBackupsOptions extends Options {
  namespace: string
  workload: string
  volume: string
  allNamespaces: boolean
  allWorkloads: boolean
  allVolumes: boolean
}

export async function removeBackupArchives(opts:RemoveBackupsOptions) {
  opts.namespace || opts.allNamespaces || err('Namespace?')
  opts.workload || opts.allWorkloads || opts.allNamespaces || err('Workload?')
  opts.volume || opts.allVolumes || opts.allWorkloads || opts.allNamespaces || err('Volume?')
  await new CephBackup().removeBackupArchives(opts.namespace, opts.workload, opts.volume)
}
