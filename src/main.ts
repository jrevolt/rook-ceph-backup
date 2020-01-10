import {Command} from "commander";
import * as utils from "./utils";
import {report} from "./utils";
import {log, logctx} from "./log";
import {CephBackup} from "./ceph-backup";
import {CephRestore} from "./ceph-restore";
import {CephRead} from "./ceph-read";

utils.qdhImportGlobals();

export let rbdtools = new Command('rbdtools');

// rbdtools
//   .option('--dry-run')
//   .option('-n, --namespace <namespace>')
//   .option('-d, --deployment <deployment>')
//   .option('-v, --volume <volume>')
//   ;

rbdtools
  .command('ls')
  .description('List all supported deployments/volumes/snapshots')
  .action(async () => await main(ls));
rbdtools
  .command('snapshot')
  .description('Create snapshot for all supported volumes')
  .action(async () => await main(snapshot));
rbdtools
  .command('backup')
  .description('Export all volume snapshots, if missing in destination')
  .option('--type <backupType>', 'Preferred backup type for most recent snapshot')
  .action(async () => await main(backup));
rbdtools
  .command('consolidate')
  .description('Remove obsolete backups, re-export missing ones')
  .action(async () => await main(consolidate));
rbdtools
  .command('restore')
  .option("-n, --namespace <namespace>", "Namespace name")
  .option("-d, --deployment <deployment>", "Deployment or statefulset name")
  .option("-v, --volume <volume>", "Persistent volume claim name or persistent volume / RBD image name")
  .option("-s, --snapshot <snapshot>", "Name of the RBD snapshot to restore to")
  // todo: --dry-run or --force or --preview
  .description('Restore image from snapshot')
  .action(async (cmd) => await main(restore, cmd.opts()));

// on invalid command
rbdtools.on('command:*', (cmd) => help(2, `ERROR: Invalid command: ${cmd}`));

// default: show help
if (!process.argv.slice(2).length) { rbdtools.help(); log.end(); }

// parse & execute commands/actions
rbdtools.parse(process.argv);

async function ls() { await new CephRead().listAll(); }
async function snapshot() { await new CephBackup().createSnapshotAll(); }
async function backup() { await new CephBackup().backupVolumeAll(); }
async function consolidate() { await new CephBackup().consolidateAll(); }
async function restore(opts:any) { await new CephRestore().restoreFromSnapshot(opts.namespace, opts.deployment, opts.volume, opts.snapshot); }

async function main(action: any, opts?: any) {
  try {
    logctx.command = action.name;
    log.debug('Executing command %s', action.name);
    await action(opts);
  } catch (e) {
    report(e);
    process.exitCode = 1;
  } finally {
    log.end();
  }
}

function help(code:number, msg?:string) {
  if (msg) console.error(msg);
  rbdtools.outputHelp();
  process.exitCode = code;
  log.end();
}






