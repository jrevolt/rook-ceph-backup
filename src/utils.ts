import TraceError from "trace-error";
import {log, logctx} from "./log";
import moment, {Moment, MomentFormatSpecification, MomentInput} from "moment";
import {BackupType} from "./cfg";
import {rbdtools} from "./main";
import DurationConstructor = moment.unitOfTime.DurationConstructor;

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
    equals(t:T) : boolean;
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

String.prototype.truncate = function (max) {
  return this.substring(0, Math.min(this.length, max));
};

export class ParamError extends Error {
}

export function fail(message) : boolean {
  throw new ParamError(message);
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

export function help() {
  let c = rbdtools.commands.find(x => x._name == logctx.command);
  c ? c.help() : rbdtools.help();
}
