// src/utils/retry.js
const { warn } = require('./logger');

async function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function retry(fn, { retries = 3, minTimeout = 200, factor = 2, onRetry } = {}) {
  let attempt = 0;
  let delay = minTimeout;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      attempt++;
      try { if (onRetry) await onRetry({ attempt, err }); } catch(_) {}
      warn(`Retry attempt ${attempt} after error: ${err && err.message?err.message:err}`);
      await wait(delay);
      delay = Math.floor(delay * factor);
    }
  }
}

module.exports = { retry };
