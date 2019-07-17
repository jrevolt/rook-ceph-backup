import TraceError from "trace-error";
import {log} from "./log.js";

export function qdhImportGlobals() {}

declare global {
  interface String {
    truncate(max: number): string
  }
  interface Array<T> {
    forEachAsync(action:(item:T)=>void) : Promise<void>
  }
  interface Map<K,V> {
    forEachAsync(action: (item: V) => void): void;
  }
}

Array.prototype.forEachAsync = async function (cb) {
  await Promise.all(this.map(async (x) => await cb(x)));
};

String.prototype.truncate = function (max) {
  return this.substring(0, Math.min(this.length, max));
};

export function report(err) {
   if (err) {
      let e = new TraceError(err.message, err);
      log.error('Error (reported, ignored): %s', e);
   }
}

export function rethrow(err:Error, msg?:string) : TraceError {
   throw new TraceError(msg || err.message, err);
}




