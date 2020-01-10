import winston from 'winston';
import ElasticSearch from 'winston-elasticsearch';
import extend from 'extend';
import {cfg} from "./cfg";

interface LogContext {
  command? : string
}

export const logctx : LogContext = {
  command: undefined,
};

const metadataFormat = winston.format(info => {
  info.command = logctx.command;
  return info;
});

const format = winston.format.combine(
  winston.format.splat(),
  winston.format.simple(),
  winston.format.timestamp(),
  winston.format.printf(({ timestamp, level, label, message }) => `${timestamp}|${lvl(level)}|${logctx.command}| ${message}`),
);

const esformat = winston.format.combine(
  winston.format.splat(),
  winston.format.simple(),
  metadataFormat(),
);

function lvl(level) {
  // dirty translation to (DBG|INF|WRN|ERR)
  return level.toLowerCase()
              .replace(/[aeou]/gi, '')
              .substring(0, 3)
              .toUpperCase()
              .replace(/RRR/gi, 'ERR');
}

export const log = winston.createLogger({
  level: 'debug',
  transports: [
    new winston.transports.Console({ format: format }),
    cfg.elasticsearch.clientOpts.host ? new ElasticSearch(extend({ format: esformat }, cfg.elasticsearch)) : undefined,
  ].filter(x=>x),
});

ElasticSearch.prototype.end = async function () {
  const writer = this['bulkWriter'];
  await writer.flush();
  writer.stop();

  //await this.doWhilst(() => writer.flush(), () => writer.bulk.length > 0);

  this.emit('finish');
};


