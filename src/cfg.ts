import config from 'config';
import {ElasticsearchTransportOptions} from "winston-elasticsearch";
import moment from "moment";
import printf from "printf";
import assert from "assert";

export function isUnitTest() {
  return process.env.NODE_ENV == "test" && process.env.JEST_WORKER_ID != undefined
}

export function isCli() {
  return !isUnitTest()
}

export class Configuration {

  quiet: boolean
  debug: boolean

  rook: {
    namespace: string
    toolbox: string
  }

  elasticsearch: ElasticsearchTransportOptions
  backup: {
    nameFormat:  string, // YYYYMMDD-HHmm
    namePattern: string, // regexp: ^\d{8}-\d{4}$
    path: string,
    storageClassName: string,
    monthly: { max: number, dayOfMonth: number, dayOfWeek: string },
    weekly:  { max: number, dayOfWeek: string, },
    daily:   { max: number },
    // full:          { interval: string, max: number, preferredDayOfMonth: number },
    // differential : { interval: string, max: number, preferredDayOfWeek: number },
    // incremental:   { interval: string, max: number },
  }

  semaphore: {
    exec: number,
    operator: number,
    backup: number,
  }
  deployments: any

  private static $instance : Configuration

  static get instance() : Configuration {
    return this.$instance || (this.$instance = new Configuration())
  }

  constructor() {
    //NODE_CONFIG_DIR: see init.ts
    process.env['ALLOW_CONFIG_MUTATIONS']='true'
    Object.assign(this, config.get('rbdtools'))
  }

  get namespaces() {
    return Object.keys(this.deployments || {})
  }
}

export class Namespace {
  name: string;
  deployments: Deployment[] = [];

  constructor(src: Partial<Namespace>) {
    Object.assign(this, src);
  }

  du() : number {
    return this.deployments.map(d => d.du()).reduce((a,b) => a+b, 0)
  }

}

export class Deployment {
  name: string;
  kind: Kind;
  namespace: string;
  volumes: Volume[];


  constructor(name: string, namespace: string) {
    this.name = name;
    this.namespace = namespace;
  }

  du() : number {
    return this.volumes.map(v => v.du()).reduce((a,b) => a+b, 0)
  }

}

export enum Kind { Deployment, statefulset }

export class Volume {
  deployment: Deployment;
  //pv: string;
  pvc: string;
  image: {
    pool: string
    name: string
  }
  pool: string
  snapshots: Snapshot[];

  constructor(src: Partial<Volume>) {
    Object.assign(this, src);
  }

  getDirectory() {
    return `${cfg.backup.path}/${this.deployment.namespace}/${this.deployment.name}/${this.pvc}/${this.image.name}`;
  }

  describe(simple=false) {
    return `${this.deployment.namespace}/${this.deployment.name}/${this.pvc} (${this.image.pool}/${this.image.name})`;
  }

  du() : number {
    return this.snapshots.map(s => s.fileSize).reduce((a,b) => a+b, 0)
  }

}

export enum BackupType {
  // full backup
  monthly = 'monthly',
  // diff against latest full
  weekly = 'weekly',
  // diff against latest incremental, or latest differential (if previous incremental is unavailable)
  daily = 'daily',
}

export class Snapshot {
  volume: Volume;

  id: number;
  name: string;
  size: number;
  protected: boolean;
  timestamp: Date;
  file: string;
  fileSize: number;

  // elected backup type
  backupType: BackupType;

  hasSnapshot : boolean = false;
  hasFile : boolean = false;

  isDeleteSnapshot : boolean = false;
  isDeleteFile : boolean = false;

  dependsOn ?: Snapshot;

  constructor(src: Partial<Snapshot>) {
    Object.assign(this, src);
  }

  setType(type:BackupType) {
  }

  updateFileName() {
    let type = BackupTypeUtils.toFileType(this.backupType);
    this.file = this.dependsOn ? `${this.name}-${type}-${this.dependsOn.name}.gz` : `${this.name}-${type}.gz`
  }

  describe() : string {
    return moment(this.timestamp).format('YYYYMMDD ddd');
  }

  dbginfo() {
    return Object.assign({
      t: this.backupType,
      d: this.timestamp.getDay(),
      //n: this.name,
      n: this.file || this.name,
      //dep: o(this.dependsOn).name,
      o: `${this.hasSnapshot ? 'S' : '-'}${this.hasFile ? 'F' : '-'}`,
      x: `${this.isDeleteSnapshot ? 'S' : '-'}${this.isDeleteFile ? 'F' : '-'}`,
      //snap: this,
    });
  }

  consolidationInfo() {
    return printf(
      '[%s][%s][has:%s][evict:%s][file:%4s|%s]',
      BackupTypeUtils.toCharFlag(this.backupType) || '?',
      this.name,
      `${this.hasSnapshot ? 'S' : '-'}${this.hasFile ? 'F' : '-'}`,
      `${this.isDeleteSnapshot ? 'S' : '-'}${this.isDeleteFile ? 'F' : '-'}`,
      this.getFileSizeString(),
      this.file,
    );
  }

  getFileSizeString() {
    if (!this.fileSize) return 'NA';

    let x = this.fileSize;
    let u = 'B';
    if (x >   0) { x = Math.round(x/1024); u='K' }
    if (x > 999) { x = Math.round(x/1024); u='M' }
    if (x > 999) { x = Math.round(x/1024); u='G' }
    x = Math.max(1, x);
    return `${x}${u}`;
  }

  toString() {
    return this.dbginfo();
  }

}

export class BackupTypeUtils {

  private static mappings = [
    [BackupType.monthly, 'M', 'ful'],
    [BackupType.weekly, 'W', 'dif'],
    [BackupType.daily, 'D', 'inc'],
  ]

  static toFileType(type: BackupType): string {
    return this.mappings.map(x => x[2])[this.mappings.map(x => x[0]).indexOf(type)]
  }

  static fromFileType(type: string): BackupType {
    return this.mappings.map(x => x[0])[this.mappings.map(x => x[2]).indexOf(type)] as BackupType
  }

  static toCharFlag(type: BackupType): string {
    return this.mappings.map(x => x[1])[this.mappings.map(x => x[0]).indexOf(type)]
  }

  static fromCharFlag(type: string): BackupType {
    return this.mappings.map(x => x[0])[this.mappings.map(x => x[1]).indexOf(type)] as BackupType
  }

  static fromCli(s:string) : BackupType {
    return (
      /m[onthly]*|full?/i.test(s) ? BackupType.monthly :
      /w[ekly]*|dif[ferntial]*/i.test(s) ? BackupType.weekly :
      /d[aily]*|inc[remntal]*/i.test(s) ? BackupType.daily :
      assert.fail(s)
    )
  }

}

export const cfg = Configuration.instance
