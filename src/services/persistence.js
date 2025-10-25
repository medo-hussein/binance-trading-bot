// src/services/persistence.js
const fs = require('fs');
const path = require('path');
const { warn, info } = require('../utils/logger');

const dataDir = path.join(__dirname, '..', '..', 'data', 'bots');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function fileForBot(botId) {
  return path.join(dataDir, `${botId}.json`);
}

function saveBotState(botId, state) {
  try {
    fs.writeFileSync(fileForBot(botId), JSON.stringify({ updatedAt: Date.now(), state }, null, 2), { encoding: 'utf8' });
    info(`Saved state for bot ${botId}`);
  } catch (e) { warn('saveBotState error', e.message || e); }
}

function loadBotState(botId) {
  try {
    const file = fileForBot(botId);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.state || null;
  } catch (e) { warn('loadBotState error', e.message || e); return null; }
}

function deleteBotState(botId) {
  try {
    const file = fileForBot(botId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    info(`Deleted saved state for bot ${botId}`);
  } catch (e) { warn('deleteBotState error', e.message || e); }
}

module.exports = { saveBotState, loadBotState, deleteBotState };
