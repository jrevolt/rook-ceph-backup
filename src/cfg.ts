import config from 'config';
import deepExtend from 'deep-extend';
import {ElasticsearchTransportOptions} from "winston-elasticsearch";
import {RequestOptions} from "http";
import Bottleneck from "bottleneck";

export const cfg: Configuration = deepExtend({}, config.get('k8s'));

interface Configuration {
  proxy: {
    host: string,
    port: number,
  },
  kubectl: {
    config: string,
  },
  rancher: {
    url: string
    accessKey: string
    secretKey: string
  },
  backup: {
    path: string,
    storageClassName: string,
    pool: string,
    daily: number,
    weekly: number,
    monthly: number,
  },

  semaphore: {
    exec: number,
    operator: number,
    backup: number,
  },
  deployments: any;
}

export class Namespace {

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
}

export enum Kind { Deployment, statefulset }

export class Volume {
  deployment: Deployment;
  pv: string;
  pvc: string;
  snapshots: Snapshot[];

  constructor(src: Partial<Volume>) {
    Object.assign(this, src);
  }

  getDirectory() {
    return `${cfg.backup.path}/${this.deployment.namespace}/${this.deployment.name}/${this.pvc}-${this.pv}`;
  }

}

export class Snapshot {
  volume: Volume;

  id: number;
  name: string;
  size: number;
  protected: boolean;
  timestamp: Date;
  file: string;


  constructor(src: Partial<Snapshot>) {
    Object.assign(this, src);
  }

  getFileName() {
    let snaps = this.volume.snapshots;
    let i = snaps.indexOf(this);
    let since = i>0 ? snaps[i-1] : null;
    return since
      ? `${this.name}.since-${since.name}.gz`
      : `${this.name}.gz`;
  }
}




