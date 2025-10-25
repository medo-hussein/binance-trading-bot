// src/core/botManager.js
const { v4: uuidv4 } = require('uuid');
const { info, warn, error } = require('../utils/logger');
const { loadBotState, saveBotState, deleteBotState } = require('../services/persistence');
const fs = require('fs');
const path = require('path');

class BotManager {
  constructor() {
    this.bots = new Map();
  }

  // Internal helper: persist full bot state (including status & times)
  _persistBot(bot) {
    try {
      const toSave = {
        name: bot.name,
        strategy: bot.strategy,
        symbol: bot.symbol,
        status: bot.status,
        config: bot.config,
        stats: bot.stats
      };
      saveBotState(bot.id, toSave);
    } catch (e) {
      warn('persistBot error', e.message || e);
    }
  }

  // This internal method builds the bot instance, attaches methods, and the runner.
  // It's used by both createBot and loadBotsFromDisk to avoid duplicate code.
  _buildBotInstance(id, state, runnerFactory) {
    const timeNow = Date.now(); // unify timestamp for initialization

    // ensure state.config exists
    const cfg = state.config || {};

    const bot = {
      id,
      name: state.name,
      strategy: state.strategy,
      symbol: state.symbol,
      // adopt persisted status if present
      status: state.status || 'stopped',
      // config: merge and ensure time fields exist
      config: {
        ...cfg,
        timeCreated: cfg.timeCreated || timeNow,
        timeStarted: cfg.timeStarted || null,
        timeStopped: cfg.timeStopped || null
      },
      stats: state.stats || { completedRounds: 0, realizedPnl: 0, lastDurationMs: 0 },
      _runner: null,
      runStartTime: null, // in-memory runtime start pointer (ms since epoch)
      // ================== NEW PROPERTY ==================
      _orderSubscriptions: new Map() // لتخزين الاشتراكات النشطة للطلبات
    };

    // If persisted indicated running and there's a timeStarted without timeStopped,
    // treat as running and set runStartTime to that time so duration continues.
    if (bot.status === 'running' && bot.config.timeStarted && !bot.config.timeStopped) {
      // Use the persisted timeStarted as runStartTime so currentDuration continues across restarts
      bot.runStartTime = bot.config.timeStarted;
    }

    const runner = runnerFactory(bot);
    bot._runner = runner;

    bot.start = () => {
      if (bot.status === 'running') return;
      try {
        bot.status = 'running';
        // if we already have a persisted timeStarted (resumed), keep it; otherwise set now
        if (!bot.config.timeStarted) {
          bot.config.timeStarted = Date.now();
        }
        bot.config.timeStopped = null; // clear stopped timestamp
        // set in-memory runStartTime to the persisted timeStarted (keeps continuity)
        bot.runStartTime = bot.config.timeStarted;
        // start runner (don't await, runner.start might be async)
        if (typeof runner.start === 'function') {
          try { runner.start(); } catch (e) { warn('runner.start threw', e.message || e); }
        }
        // persist full state including status/time
        this._persistBot(bot);
        info(`Bot ${bot.id} started`);
      } catch (e) {
        error('bot.start error', e.message || e);
      }
    };

    bot.stop = async () => {
      if (bot.status === 'stopped') return;
      try {
        const stopTime = Date.now();

        bot.status = 'stopped';

        // compute duration if runStartTime present and update stats.lastDurationMs
        if (bot.runStartTime) {
          const durationMs = stopTime - bot.runStartTime;
          bot.stats.lastDurationMs = durationMs;
          bot.runStartTime = null;
        }

        // persist stop time in config
        bot.config.timeStopped = stopTime;

        if (runner && typeof runner.stop === 'function') {
          try { await runner.stop(); } catch (e) { warn('runner.stop error', e.message || e); }
        }

        // ================== NEW: تنظيف الاشتراكات ==================
        this._cleanupOrderSubscriptions(bot.id);

        // persist full state including status/time/stats
        this._persistBot(bot);
        info(`Bot ${bot.id} stopped`);
      } catch (e) {
        error('bot.stop error', e.message || e);
      }
    };

    bot.updateStats = (delta) => {
      bot.stats.completedRounds += (delta.completedRounds || 0);
      bot.stats.realizedPnl += (delta.realizedPnl || 0);
      // persist updated stats (and keep times/status)
      this._persistBot(bot);
    };

    this.bots.set(id, bot);
    return bot;
  }

  // ================== NEW METHODS FOR ORDER MANAGEMENT ==================
  
  /**
   * جلب الطلبات المفتوحة للبوت
   */
  async getBotOpenOrders(botId) {
    try {
      const bot = this.bots.get(botId);
      if (!bot) {
        throw new Error(`Bot ${botId} not found`);
      }

      // 🎯 [إصلاح]: استخدام binance client مباشرة إذا الـ runner ماعندهش method
      if (bot._runner && bot._runner.getOpenOrders) {
        const orders = await bot._runner.getOpenOrders();
        return orders;
      }

      // 🎯 [إضافة]: إذا الـ runner ماعندهش method، نستخدم binance client مباشرة
      if (bot._runner && bot._runner.binance) {
        info(`Using direct binance client for bot ${botId} orders`);
        const orders = await bot._runner.binance.getOpenOrders(bot.symbol);
        return orders;
      }

      // إذا الـ runner ماعندهش method أو binance client
      warn(`Bot ${botId} runner doesn't have getOpenOrders method or binance client`);
      return [];
    } catch (err) {
      error(`Error getting open orders for bot ${botId}:`, err.message || err);
      return [];
    }
  }

  /**
   * الاشتراك في تحديثات الطلبات للبوت
   */
  subscribeToBotOrders(botId, callback) {
    try {
      const bot = this.bots.get(botId);
      if (!bot) {
        throw new Error(`Bot ${botId} not found`);
      }

      const subscriptionId = uuidv4();
      
      // نخزن الـ callback
      bot._orderSubscriptions.set(subscriptionId, callback);

      // إذا الـ runner بيقدر يشتترك في التحديثات
      if (bot._runner && bot._runner.subscribeToOrderUpdates) {
        bot._runner.subscribeToOrderUpdates((orderUpdate) => {
          // ننشر التحديث لكل الـ subscribers
          bot._orderSubscriptions.forEach(cb => {
            try {
              cb(orderUpdate);
            } catch (err) {
              error('Error in order subscription callback:', err);
            }
          });
        });
      }

      info(`Subscribed to order updates for bot ${botId}, subscription: ${subscriptionId}`);
      
      // نرجع function علشان نقد ن unsubscribe
      return () => {
        this._unsubscribeFromBotOrders(botId, subscriptionId);
      };

    } catch (err) {
      error(`Error subscribing to bot orders ${botId}:`, err.message || err);
      return () => {}; // نرجع function فارغة
    }
  }

  /**
   * إلغاء الاشتراك من تحديثات الطلبات
   */
  _unsubscribeFromBotOrders(botId, subscriptionId) {
    const bot = this.bots.get(botId);
    if (bot && bot._orderSubscriptions) {
      bot._orderSubscriptions.delete(subscriptionId);
      info(`Unsubscribed from order updates for bot ${botId}, subscription: ${subscriptionId}`);
    }
  }

  /**
   * تنظيف كل الاشتراكات عند إيقاف البوت
   */
  _cleanupOrderSubscriptions(botId) {
    const bot = this.bots.get(botId);
    if (bot && bot._orderSubscriptions) {
      bot._orderSubscriptions.clear();
      info(`Cleaned up all order subscriptions for bot ${botId}`);
    }
  }

  /**
   * جلب بيانات تفصيلية عن البوت للواجهة
   */
  async getBotDetails(botId) {
    try {
      const bot = this.bots.get(botId);
      if (!bot) {
        throw new Error(`Bot ${botId} not found`);
      }

      // نجيب الطلبات المفتوحة
      const openOrders = await this.getBotOpenOrders(botId);
      info(`Fetched ${openOrders.length} open orders for bot ${botId}`);

      // نحسب الـ PNL الحالي
      let currentDurationMs = 0;
      if (bot.status === 'running' && bot.runStartTime) {
        currentDurationMs = Date.now() - bot.runStartTime;
      } else if (bot.stats?.lastDurationMs) {
        currentDurationMs = bot.stats.lastDurationMs;
      }

      return {
        id: bot.id,
        name: bot.name,
        strategy: bot.strategy,
        symbol: bot.symbol,
        status: bot.status,
        config: bot.config,
        stats: bot.stats,
        currentDurationMs,
        openOrders,
        lastUpdated: new Date().toISOString()
      };
    } catch (err) {
      error(`Error getting bot details for ${botId}:`, err.message || err);
      throw err;
    }
  }

  // ================== END OF NEW METHODS ==================

  // 🎯 [إضافة]: دالة لتحويل المدة لصيغة مقروءة
  _formatDuration(ms) {
    if (!ms || ms < 1000) return 'None';
    
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    if (hours > 0) {
      return `${hours}h ${minutes}m ${remainingSeconds}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${remainingSeconds}s`;
    } else {
      return `${remainingSeconds}s`;
    }
  }

  // This method reads all .json files from the data directory on startup and resumes running bots.
  // runnerFactory is expected to be a function that accepts the bot object and returns a runner.
  async loadBotsFromDisk(runnerFactory) {
    info('Loading existing bots from disk...');
    const dataDir = path.join(__dirname, '..', '..', 'data', 'bots');
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const files = fs.readdirSync(dataDir);
      let count = 0;
      for (const file of files) {
        if (file.endsWith('.json')) {
          const botId = file.replace('.json', '');
          const savedState = loadBotState(botId);
          if (savedState && savedState.name) { // Check for valid state
            savedState.stats = savedState.stats || {};
            savedState.stats.lastDurationMs = savedState.stats.lastDurationMs || 0;

            // Build instance
            const bot = this._buildBotInstance(botId, savedState, runnerFactory);

            // If persisted as running, resume it WITHOUT overwriting original timeStarted
            if (savedState.status === 'running') {
              try {
                // mark status and runStartTime from persisted values
                bot.status = 'running';
                bot.config.timeStarted = bot.config.timeStarted || Date.now();
                bot.config.timeStopped = null;
                bot.runStartTime = bot.config.timeStarted;

                // start runner (don't call bot.start() because that may overwrite timeStarted)
                if (bot._runner && typeof bot._runner.start === 'function') {
                  try { bot._runner.start(); } catch (e) { warn('resumed runner.start error', e.message || e); }
                }

                info(`Resumed bot ${bot.id} (auto-start).`);
              } catch (e) {
                warn(`Failed to auto-resume bot ${botId}: ${e.message || e}`);
              }
            }

            count++;
          }
        }
      }
      if (count > 0) {
        info(`Loaded and reconstructed ${count} bots.`);
      }
    } catch (e) {
      error('Failed to load bots from disk:', e.message || e);
    }
  }

  listBots() {
    return Array.from(this.bots.values()).map(b => {
      let currentDurationMs = 0;
      
      // 🎯 [إصلاح]: حساب المدة الصح
      if (b.status === 'running' && b.runStartTime) {
        currentDurationMs = Date.now() - b.runStartTime;
      } else if (b.stats?.lastDurationMs) {
        currentDurationMs = b.stats.lastDurationMs;
      }

      // 🎯 [إضافة]: تحويل المدة لصيغة مقروءة
      const durationDisplay = this._formatDuration(currentDurationMs);

      return {
        id: b.id,
        name: b.name,
        strategy: b.strategy,
        symbol: b.symbol,
        status: b.status,
        // expose time fields so frontend can show start/stop
        timeStarted: b.config?.timeStarted || null,
        timeStopped: b.config?.timeStopped || null,
        stats: b.stats,
        currentDurationMs: currentDurationMs,
        // 🎯 [مهم]: إضافة حقل المدة الجاهز للعرض
        durationDisplay: durationDisplay
      };
    });
  }

  createBot({ name, strategy, symbol, config, runnerFactory }) {
    const id = uuidv4();
    const timeNow = Date.now();
    const initialState = {
      name,
      strategy,
      symbol,
      status: 'stopped',
      config: { ...config, timeCreated: timeNow, timeStarted: null, timeStopped: null },
      stats: { completedRounds: 0, realizedPnl: 0, lastDurationMs: 0 }
    };
    // Save the complete initial state first (includes status)
    saveBotState(id, initialState);
    info('Created bot', { id, name, strategy, symbol });
    // Then build the instance from that state.
    return this._buildBotInstance(id, initialState, runnerFactory);
  }

  getBot(id) { return this.bots.get(id); }

  removeBot(id) {
    if (!this.bots.has(id)) return;
    
    // ================== NEW: تنظيف الاشتراكات قبل الحذف ==================
    this._cleanupOrderSubscriptions(id);
    
    try { deleteBotState(id); } catch (_) {}
    this.bots.delete(id);
    info('Removed bot', id);
  }

  // 🎯 [إضافة]: دالة debug لفحص حالة البوت
  debugBot(botId) {
    const bot = this.bots.get(botId);
    if (!bot) {
      return { error: 'Bot not found' };
    }

    return {
      id: bot.id,
      status: bot.status,
      symbol: bot.symbol,
      runStartTime: bot.runStartTime,
      timeStarted: bot.config.timeStarted,
      timeStopped: bot.config.timeStopped,
      currentTime: Date.now(),
      durationCalculated: bot.runStartTime ? Date.now() - bot.runStartTime : 0,
      stats: bot.stats,
      hasRunner: !!bot._runner,
      runnerMethods: bot._runner ? Object.keys(bot._runner) : []
    };
  }
}

module.exports = { BotManager };