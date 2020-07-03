import "./cfg"
import "./log"

import {Options, registerCommands} from "./commands";
import {log} from "./log";
import {rethrow} from "./utils";
import extend from "extend";
import * as version from './version.json'
import * as commander from 'commander'
import {isCli, isUnitTest} from "./cfg";

export class Main {

  private static $instance : Main

  static get instance() : Main {
    return Main.$instance || (Main.$instance = new Main())
  }

  readonly program : commander.Command = new commander.Command('rbdtools')
    .description('Rook Ceph Backup Tools')
    .version(this.versionString())

  command : commander.Command = this.program

  options() { return this.program.opts() as Options }

  async run(args?: string[]) {
    if (args) args.unshift('dummy-exe-name', 'dummy-script-name')
    if (!args) args = process.argv

    registerCommands(this)

    let result = await this.program.parseAsync(args)

    return result
  }

  wrap(action) {
    const main = this;
    return async function () {
      let started = Date.now();
      let error: Error | undefined;
      let cmd = main.command = arguments[arguments.length - 1]

      try {
        let opts: Options = extend({}, cmd.parent.opts(), cmd.opts())
        let args: any[] = [opts]
        for (let i = 0; i < arguments.length - 1; i++) args.push(arguments[i])

        log.level = opts.quiet ? 'error' : opts.debug ? 'debug' : log.level

        log.info(`${main.program.name()} ${main.versionString()})`)
        log.info('Executing command [%s], options: %s', cmd.name(), main.optionsString(args));

        // @ts-ignore
        await action.apply(this, args);

      } catch (e) {
        error = e;
        if (isUnitTest()) rethrow(e)
        process.exitCode = 3;

      } finally {
        let elapsed = Date.now() - started;
        let logm = error ? log.error : log.info;
        let err = error ? error.stack : '';
        logm('Finished command [%s] in %d msec. %s', cmd.name(), elapsed, err);
      }
    }
  }

  versionString() : string {
    return `${version["FullSemVer"]} (${version["CommitDate"]}, ${version["ShortSha"]})`
  }

  optionsString(src:any[]) : string {
    let dst = extend(true,[], src)
    delete dst[0]["version"]
    return JSON.stringify(dst)
  }

}

if (isCli()) Main.instance.run().then()
