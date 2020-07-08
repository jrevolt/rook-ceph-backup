import TraceError from "trace-error";
import {log} from "./log";
import moment, {Moment, MomentFormatSpecification, MomentInput} from "moment";
import {BackupType} from "./cfg";
import DurationConstructor = moment.unitOfTime.DurationConstructor;


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
    equals(t:T) : boolean;
    pushAll(t:T[]);
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

Array.prototype.equals = function (t) {
  return this.length == t.length && this.every((x,idx,arr) => x == t[idx]);
};

Array.prototype.pushAll = function (t) {
  t.forEach(x => this.push(x))
}

String.prototype.truncate = function (max) {
  return this.substring(0, Math.min(this.length, max));
};

export class ParamError extends Error {
}

export function fail<T>(message?) : T|never {
  throw new ParamError(message ?? 'no message');
}

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

export function toBackupType(duration: DurationConstructor) : BackupType {
  switch (duration) {
    case "day": return BackupType.daily;
    case "week": return BackupType.weekly;
    case "month": return BackupType.monthly;
    default: throw new Error(`unexpected: ${duration}`);
  }
}

export enum Weekday {
  Sunday,
  Monday,
  Tuesday,
  Wednesday,
  Thursday,
  Friday,
  Saturday,
}

//export const Weekdays : string[] = ['Sunday', 'Monday', 'Tuesday', ];

export function findFirstDayOfMonthByWeekday(date: Date, weekday: Weekday) : number {
  let x = newMoment(new Date(date.getFullYear(), date.getMonth(), 1));
  while (x.toDate().getDay() != weekday)
    x = x.add(1, "d");
  return x.toDate().getDate();
}

export function newMoment(input?: MomentInput, format?: MomentFormatSpecification) : Moment {
  return moment(input, format);
}

export function getFileSizeString(x?:number) {
  if (!x) return 'NA';

  let u = 'B';
  if (x >   0) { x = Math.round(x/1024); u='K' }
  if (x > 999) { x = Math.round(x/1024); u='M' }
  if (x > 999) { x = Math.round(x/1024); u='G' }
  x = Math.max(1, x);
  return `${x}${u}`;
}

