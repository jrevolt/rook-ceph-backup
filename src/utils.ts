import TraceError from "trace-error";
import {log} from "./log.js";

export function qdhImportGlobals() {}

declare global {
  interface String {
    truncate(max: number): string
  }
  interface Array<T> {
    forEachAsync(action:(item:T)=>void) : Promise<void>
    first() : T;
    last() : T;
    previous(t:T) : T;
    contains(t:T) : boolean;
    remove(t:T) : T[];
  }
  interface Map<K,V> {
    forEachAsync(action: (item: V) => void): void;
  }
}

Array.prototype.forEachAsync = async function (cb) {
  await Promise.all(this.map(async (x) => await cb(x)));
};

Array.prototype.first = function () {
  return this.find(()=>true);
};

Array.prototype.last = function () {
  return this.length > 0 ? this[this.length - 1] : undefined;
};

Array.prototype.previous = function (t) {
  let i = this.indexOf(t);
  return i > 0 ? this[i-1] : undefined;
};

Array.prototype.contains = function (t) {
  return this.indexOf(t) != -1;
};

Array.prototype.remove = function (t) {
  let i = this.indexOf(t);
  this.copyWithin(i, i+1);
  this.length--;
  return this;
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

export function dateCompare(a: Date, b:Date) : number {
  return Math.max(-1, Math.min(a.getTime() - b.getTime(), 1))
}

export function o<T>(someObject: T, defaultValue: T = {} as T) : T {
  if (typeof someObject === 'undefined' || someObject === null)
    return defaultValue;
  else
    return someObject;
}





