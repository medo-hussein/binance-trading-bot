require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const compression = require('compression');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const EventEmitter = require('events');
const axios = require('axios');

const { info, warn, error, log } = require('./utils/logger');

// Core imports
const { BinanceClient } = require('./binance/client');
const { BinanceWS } = require('./binance/wsClient');
const { BotManager } = require('./core/botManager');
const { createGridRunner } = require('./strategies/grid');
const { createDcaBuyRunner } = require('./strategies/dcaBuy');
const { createDcaSellRunner } = require('./strategies/dcaSell');
const cache = require('./services/cache');

const IORedis = require('ioredis');

// --------- App / infra setup ----------
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const bus = new EventEmitter();

// basic security headers
app.use(helmet({
  contentSecurityPolicy: false
}));

// hide X-Powered-By
app.disable('x-powered-by'); // 🎯 [إصلاح]: تصحيح typo

// compression
app.use(compression());

// CORS & parsing
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// sanitize inputs
app.use(mongoSanitize());
app.use(xss());

// basic rate limiter for API
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: 'Too many requests, try later.' })
});
app.use('/api/', limiter);

// static frontend
app.use(express.static(path.join(__dirname,'public')));

// request logger middleware (method path status time)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    info(`${req.method} ${req.originalUrl} ${res.statusCode} - ${ms}ms`);
  });
  next();
});

// --------- Binance + Redis init ----------
if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
  error('Missing BINANCE_API_KEY or BINANCE_API_SECRET in .env — exiting');
  process.exit(1);
}

const binance = new BinanceClient({
  apiKey: process.env.BINANCE_API_KEY,
  apiSecret: process.env.BINANCE_API_SECRET,
  baseURL: process.env.BINANCE_BASE_URL || 'https://api.binance.com'
});

// optional Redis init
let redis = null;
if (process.env.REDIS_URL) {
  try {
    redis = new IORedis(process.env.REDIS_URL);
    cache.initRedis(redis);
    info('Redis initialized for cache');
  } catch (e) {
    warn('Failed to init Redis:', e.message || e);
  }
}

// Binance WebSocket client
const binanceWS = new BinanceWS({ binanceClient: binance, bus, cache });

// forward important ws events to bus
binanceWS.on('info', (m) => info('BinanceWS:', m));
binanceWS.on('error', (e) => error('BinanceWS error:', e));
bus.on('kline', (payload) => bus.emit('market_update', payload));
binanceWS.on('userEvent', (evt) => {
  try {
    if (evt && (evt.e === 'executionReport' || evt.eventType === 'executionReport' || evt.e === 'ORDER_TRADE_UPDATE')) {
      bus.emit('order', { event: 'execution_report', raw: evt });
    } else {
      bus.emit('userEvent', evt);
    }
  } catch (ex) {
    warn('Error forwarding userEvent', ex.message || ex);
  }
});

// try to start user stream and subscribe to default symbols
(async () => {
  try {
    await binanceWS.startUserStream();
    const subs = (process.env.SUBSCRIBE_SYMBOLS || 'BTCUSDT,ETHUSDT,BTCFDUSD').split(',').map(s => s.trim()).filter(Boolean);
    for (const s of subs) {
      try { binanceWS.subscribeMarketSymbol(s, 'kline_1m'); } catch (e){ warn('subscribeMarketSymbol', s, e.message || e); }
    }
    info('BinanceWS started and subscriptions created');
  } catch (e) {
    error('Failed to start BinanceWS:', e.message || e);
  }
})();

// --------- WebSocket broadcast to frontend clients ----------
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((client) => {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (e) { /* ignore */ }
    }
  });
}

bus.on('order', (payload) => broadcast({ type: 'order', ...payload }));
bus.on('bot', (payload) => broadcast({ type: 'bot', ...payload }));
bus.on('kline', (payload) => broadcast({ type: 'kline', ...payload }));
bus.on('userEvent', (payload) => broadcast({ type: 'userEvent', ...payload }));

// --------- Bot manager ----------
const manager = new BotManager();

// helper runnerFactory used by /api/bots
function runnerFactoryFor(strategy, args) {
  if (strategy === 'grid') return createGridRunner({ ...args, cache });
  if (strategy === 'dca_buy') return createDcaBuyRunner(args);
  if (strategy === 'dca_sell') return createDcaSellRunner(args);
  throw new Error('Unknown strategy');
}

manager.loadBotsFromDisk(bot => runnerFactoryFor(bot.strategy, { binance, bot, bus, cache }));

// --------- API endpoints (cache-aware) ----------
app.get('/api/health', async (req, res) => {
  try {
    const serverTime = await binance.getServerTime();
    res.json({ ok: true, serverTime, timeOffset: binance.timeOffset });
  } catch (e) {
    error('health error', e.message || e);
    res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// 🎯 [إضافة endpoint للـ Symbols] - مهم للـ SPA
app.get('/api/symbols', async (req, res) => {
    try {
        // رموز افتراضية - ممكن تعدلها أو تجلبها من بينانس
        const symbols = ['BTCFDUSD', 'BTCUSDT', 'ETHUSDT', 'ETHFDUSD', 'ADAUSDT', 'DOTUSDT'];
        res.json(symbols);
    } catch (e) {
        error('api/symbols error', e.message || e);
        res.status(500).json({ error: e.message });
    }
});

// NEW ENDPOINT for historical klines
app.get('/api/klines', async (req, res) => {
    const { symbol, interval = '1m', limit = 100 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol is required' });
    try {
        const klines = await binance.klines(symbol, interval, { limit });
        const formattedKlines = klines.map(k => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
        }));
        res.json(formattedKlines);
    } catch (e) {
        error(`API klines error for ${symbol}:`, e.message || e);
        res.status(500).json({ error: e.response?.data?.msg || e.message });
    }
});

app.get('/api/price', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const cached = await cache.get(`price:${symbol}`);
    if (cached && cached.price !== undefined) {
      return res.json({ symbol, price: cached.price, source: 'ws_cache' });
    }
    const price = await binance.getPrice(symbol);
    await cache.set(`price:${symbol}`, { price, ts: Date.now() });
    res.json({ symbol, price, source: 'rest' });
  } catch (e) {
    error('api/price error', e.message || e);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/symbolInfo', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const info = await binance.exchangeInfo(symbol);
    const sym = info.symbols && info.symbols.find(s => s.symbol === symbol);
    if (!sym) return res.status(404).json({ error: 'symbol not found' });
    const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
    const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
    res.json({
      symbol: sym.symbol, baseAsset: sym.baseAsset, quoteAsset: sym.quoteAsset,
      tickSize: priceFilter ? parseFloat(priceFilter.tickSize) : 0.01,
      stepSize: lotFilter ? parseFloat(lotFilter.stepSize) : 0.0001,
    });
  } catch (e) {
    error('api/symbolInfo error', e.message || e);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/balances', async (req, res) => {
  try {
    const symbol = (req.query.symbol || '').trim();
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    const info = await binance.exchangeInfo(symbol);
    const sym = info.symbols && info.symbols.find(s => s.symbol === symbol);
    if (!sym) return res.status(404).json({ error: 'symbol not found' });
    const { baseAsset, quoteAsset } = sym;
    const cachedBalances = await cache.get('account:balances');
    if (cachedBalances && Object.keys(cachedBalances).length) {
      const bBal = cachedBalances[baseAsset] || { free: 0, locked: 0 };
      const qBal = cachedBalances[quoteAsset] || { free: 0, locked: 0 };
      return res.json({ baseAsset, quoteAsset, baseFree: bBal.free, baseLocked: bBal.locked, quoteFree: qBal.free, quoteLocked: qBal.locked });
    }
    const acc = await binance.accountInfo();
    const bBal = acc.balances.find(b => b.asset === baseAsset);
    const qBal = acc.balances.find(b => b.asset === quoteAsset);
    res.json({
      baseAsset, quoteAsset,
      baseFree: bBal ? parseFloat(bBal.free) : 0, baseLocked: bBal ? parseFloat(bBal.locked) : 0,
      quoteFree: qBal ? parseFloat(qBal.free) : 0, quoteLocked: qBal ? parseFloat(qBal.locked) : 0,
    });
  } catch (e) {
    error('api/balances error', e.message || e);
    res.status(500).json({ error: e.response?.data || e.message });
  }
});

app.get('/api/bots/summary', (req, res) => {
  try {
    const bots = manager.listBots();
    const runningBots = bots.filter(b => b.status === 'running').length;
    const totalPnl = bots.reduce((sum, b) => sum + (b.stats.realizedPnl || 0), 0);
    const totalRounds = bots.reduce((sum, b) => sum + (b.stats.completedRounds || 0), 0);
    res.json({ totalBots: bots.length, runningBots, totalPnl, totalRounds, bots });
  } catch (e) {
    error('api/bots/summary error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/bots', (req, res) => {
  try { res.json(manager.listBots()); }
  catch (e) { error('list bots error', e.message); res.status(500).json({ error: e.message }); }
});

// ================== BOT DETAILS ENDPOINT ==================
app.get('/api/bots/:id/details', async (req, res) => {
    try {
        const bot = manager.getBot(req.params.id);
        if (!bot) return res.status(404).json({ error: 'Bot not found' });
        
        const runner = bot._runner;
        if (!runner || typeof runner.getDetails !== 'function') {
            return res.status(400).json({ error: 'This bot strategy does not support detailed view.' });
        }

        const details = await runner.getDetails();
        res.json(details);

    } catch (e) {
        error(`api/bots/:id/details error for bot ${req.params.id}:`, e.message || e);
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/bots', async (req, res) => {
  try {
    const { name, strategy, symbol, config } = req.body;
    if (!name || !strategy || !symbol) return res.status(400).json({ error: 'name/strategy/symbol required' });
    const runnerFactory = (bot) => runnerFactoryFor(strategy, { binance, bot, bus, cache });
    const bot = manager.createBot({ name, strategy, symbol, config, runnerFactory });
    info(`Bot created: ${bot.id} (${bot.name})`);
    res.json(bot);
  } catch (e) {
    error('create bot error', e.message);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/bots/:id/start', (req, res) => {
  const bot = manager.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Not found' });
  try {
    bot.start();
    bus.emit('bot', { event: 'started', botId: bot.id, symbol: bot.symbol });
    info(`Bot started: ${bot.id}`);
    res.json({ id: bot.id, status: bot.status });
  } catch (e) {
    error('start bot error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/bots/:id/stop', async (req, res) => {
  const bot = manager.getBot(req.params.id);
  if (!bot) return res.status(404).json({ error: 'Not found' });
  try {
    await bot.stop();
    bus.emit('bot', { event: 'stopped', botId: bot.id, symbol: bot.symbol });
    info(`Bot stopped: ${bot.id}`);
    res.json({ id: bot.id, status: bot.status });
  } catch (e) {
    error('stop bot error', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/strategies', (req, res) => res.json([
  { key: 'grid', name: 'Grid Trading' },
  { key: 'dca_buy', name: 'DCA Buy' },
  { key: 'dca_sell', name: 'DCA Sell' },
]));

// ----------------------------------------------------
// 🎯 [إصلاح كامل للـ Routes لنظام SPA]
// ----------------------------------------------------

// 1. المسار الرئيسي (Dashboard) - SPA
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 🎯 [تعليق صفحة التفاصيل المنفصلة] - علشان نستخدم SPA بدل صفحات منفصلة
// app.get('/bot-details', (req, res) => {
//     res.sendFile(path.join(__dirname, 'public', 'bot-details.html'));
// });

// 🎯 [إضافة Fallback Route للـ SPA] - مهم علشان الـ routing يشتغل
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----------------------------------------------------

const PORT = process.env.PORT || 8123;
const serverInstance = server.listen(PORT, () => info(`🚀 Server running on http://localhost:${PORT}`));

async function shutdown(signal) {
  try {
    info(`Shutdown requested via ${signal}`);
    serverInstance.close();
    await binanceWS.closeAll();
    for (const b of manager.listBots()) {
      const bot = manager.getBot(b.id);
      if (bot && bot.status === 'running') await bot.stop();
    }
    if (redis) await redis.quit();
    process.exit(0);
  } catch (e) {
    error('Error during shutdown:', e.message);
    process.exit(1);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);