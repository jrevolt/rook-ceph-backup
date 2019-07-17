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
}

export enum Kind { Deployment, statefulset }

export class Volume {
  pv: string;
  pvc: string;
  snapshots: Snapshot[];
}

export class Snapshot {
  id: number;
  name: string;
  size: number;
  protected: boolean;
  timestamp: Date;
  file: string;
}




