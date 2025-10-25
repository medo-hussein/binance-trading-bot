// src/utils/logger.js
const fs = require('fs');
const path = require('path');

const logDir = path.join(__dirname, '..', '..', 'logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, 'server.log');

function writeToFile(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}\n`;
  try { fs.appendFileSync(logFile, line); } catch(_) {}
}

function info(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.log(new Date().toISOString(), '-', msg);
  writeToFile('INFO', msg);
}
function warn(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.warn(new Date().toISOString(), '- ⚠️', msg);
  writeToFile('WARN', msg);
}
function error(...args) {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  console.error(new Date().toISOString(), '- ❌', msg);
  writeToFile('ERROR', msg);
}

// backward compatibility
const log = info;

module.exports = { log, info, warn, error };
