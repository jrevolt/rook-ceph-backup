import path from "path";

// do this before loading cfg+config modules
process.env['NODE_CONFIG_DIR'] = (process.env['NODE_CONFIG_DIR'] ?? '')
  .split(path.delimiter)
  .concat([
    `./config`,
    `${__dirname}/config`,
    `${__dirname}/../config`, // dev fallback
  ])
  // normalization: use forward slashes
  .map(x => x.replace(/\\/g, '/'))
  // drop empty elements
  .filter(x => x && x.trim().length > 0)
  // build final path
  .join(path.delimiter)

// order is important
// cfg load config module which relies on NODE_CONFIG_DIR during load
import './cfg'
import './log'
import './utils'
