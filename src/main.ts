import {Command} from "commander";
import {Ceph} from "./ceph.js";
import * as utils from "./utils";

utils.qdhImportGlobals();

let program : Command = new Command();

program
  .command('backup')
  .action(async () => await new Ceph().backupAll());
program
  .command('snapshot')
  .action(async () => await new Ceph().createSnapshotAll());

program.parse(process.argv);
