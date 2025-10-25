// src/services/cache.js
let redisClient = null;
const memory = new Map();

function initRedis(client) {
  redisClient = client;
}

function setMemory(key, value) {
  memory.set(key, { v: value, ts: Date.now() });
}

function getMemory(key, maxAgeMs = 30_000) {
  const e = memory.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > maxAgeMs) { memory.delete(key); return null; }
  return e.v;
}

async function set(key, value) {
  setMemory(key, value);
  if (redisClient) {
    try { await redisClient.set(key, JSON.stringify({ v: value, ts: Date.now() })); } catch(_) {}
  }
}

async function get(key) {
  if (redisClient) {
    try {
      const raw = await redisClient.get(key);
      if (raw) {
        const parsed = JSON.parse(raw);
        return parsed.v;
      }
    } catch(_) {}
  }
  return getMemory(key);
}

module.exports = { initRedis, set, get, setMemory, getMemory };
