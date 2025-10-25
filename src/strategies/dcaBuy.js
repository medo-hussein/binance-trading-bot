const { log, info, warn, error } = require('../utils/logger');
const { roundToTickSize, roundToStepSize } = require('../utils/math');

function createDcaBuyRunner({ binance, bot, bus }) {
  // --- STATE ---
  let isRunning = false;
  let durationTimer = null; 
  const { symbol } = bot;
  const cfg = bot.config || {};
  const { gridLevels, gridSpread, orderSize, takeProfit, durationMinutes } = cfg; 
  const options = cfg.options || {};
  const recenterEnabled = !!options.recenterEnabled;
  const recenterMinutes = Number(options.recenterMinutes || 0) > 0 ? Number(options.recenterMinutes) : 0;
  const botTag = (bot.id || '').split('-')[0];

  let filters = { tickSize: 0.01, stepSize: 0.0001 };
  let placedBuys = [];
  let filledBuys = [];
  let sellTp = null;
  let lastActivityMs = null;

  // --- UTILS ---
  function fmt(v) { return v.toString(); }

  // ================== MODIFIED ERROR HANDLER START ==================
  function handleApiError(error, context) {
    const message = error.response?.data?.msg || error.message;
    const code = error.response?.data?.code;

    // Redefined FATAL_CODES to only include truly critical errors
    const FATAL_CODES = [
      -2015, // Invalid API-key
      -2014, // API-key format invalid
      -1102, // Mandatory parameter error
    ];

    if (FATAL_CODES.includes(code)) {
      log(`FATAL ERROR in ${context}: [${code}] ${message}. Stopping bot.`);
      bus?.emit('bot_error', { botId: bot.id, context, message, code });
      if (stop) stop();
      return;
    }
    
    // For other common (but not fatal) errors like insufficient balance (-2010)
    // or filter failures (-1013), we just log them as a warning and continue.
    log(`WARN in ${context}: [${code || 'N/A'}] ${message}`);
  }
  // =================== MODIFIED ERROR HANDLER END ===================

  async function loadFilters() {
    try {
      const info = await binance.exchangeInfo(symbol);
      const sym = info.symbols?.find(s => s.symbol === symbol);
      if (!sym) {
        log(`FATAL ERROR: Symbol ${symbol} not found. Stopping bot.`);
        if (stop) stop();
        return;
      }
      const priceFilter = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
      const lotFilter = sym.filters.find(f => f.filterType === 'LOT_SIZE');
      filters.tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : 0.01;
      filters.stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : 0.0001;
    } catch (e) {
      handleApiError(e, 'loadFilters');
    }
  }

  // --- CORE LOGIC ---
  async function placeBuys() {
    await loadFilters();
    try {
      const price = await binance.getPrice(symbol);
      const placed = new Set();
      for (let i = 1; i <= gridLevels; i++) {
        const p = roundToTickSize(price - gridSpread * i, filters.tickSize);
        if (placed.has(p)) continue;
        const q = roundToStepSize(orderSize, filters.stepSize);
        const clientOrderId = `${botTag}-${Date.now()}-B-${i}`;
        try {
          const res = await binance.newOrder({ symbol, side: 'BUY', type: 'LIMIT_MAKER', quantity: fmt(q), price: fmt(p), newClientOrderId: clientOrderId });
          placedBuys.push({ orderId: res.orderId, clientOrderId, price: p, qty: q });
          placed.add(p);
          bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: 'BUY', price: p, qty: q, orderId: res.orderId, clientOrderId });
        } catch (e) {
          handleApiError(e, `placeBuys loop for price ${p}`);
        }
      }
      lastActivityMs = Date.now();
    } catch (e) {
      handleApiError(e, 'placeBuys getPrice');
    }
  }

  function buyStats() {
    if (filledBuys.length === 0) return null;
    const qty = filledBuys.reduce((a, b) => a + b.qty, 0);
    const value = filledBuys.reduce((a, b) => a + b.qty * b.price, 0);
    return { avg: value / qty, qty, value };
  }

  async function ensureTakeProfitSellUpToDate() {
    if (!takeProfit) return;
    const stats = buyStats();
    if (!stats) return;

    const desiredPrice = roundToTickSize(stats.avg + takeProfit, filters.tickSize);
    const qtyToSell = roundToStepSize(stats.qty, filters.stepSize);
    if (qtyToSell <= 0) return;

    if (sellTp && (Math.abs(sellTp.price - desiredPrice) > filters.tickSize / 2 || Math.abs(sellTp.qty - qtyToSell) > filters.stepSize / 2)) {
      try {
        await binance.cancelOrder(symbol, sellTp.orderId);
        bus?.emit('order', { event: 'canceled', botId: bot.id, symbol, orderId: sellTp.orderId });
        sellTp = null;
      } catch (e) {
        if (e.response?.data?.code !== -2011) {
            handleApiError(e, `cancel TP order ${sellTp.orderId}`);
        } else {
            sellTp = null;
        }
      }
    }
    
    if (!sellTp) {
      const clientOrderId = `${botTag}-${Date.now()}-S-TP`;
      try {
        const res = await binance.newOrder({ symbol, side: 'SELL', type: 'LIMIT_MAKER', quantity: fmt(qtyToSell), price: fmt(desiredPrice), newClientOrderId: clientOrderId });
        sellTp = { orderId: res.orderId, clientOrderId, price: desiredPrice, qty: qtyToSell };
        bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: 'SELL', price: desiredPrice, qty: qtyToSell, orderId: res.orderId });
      } catch (e) {
        handleApiError(e, 'place initial/replace TP sell');
      }
    }
  }
  
  async function onExecutionReport(raw) {
    const evt = raw.raw || raw;
    if (evt.s !== symbol || evt.X !== 'FILLED') return;

    const side = evt.S;
    const orderId = evt.i.toString();

    if (side === 'BUY') {
      const buy = placedBuys.find(b => b.orderId.toString() === orderId);
      if (buy && !filledBuys.some(fb => fb.orderId === buy.orderId)) {
        filledBuys.push({ ...buy });
        lastActivityMs = Date.now();
        bus?.emit('order', { event: 'filled', botId: bot.id, symbol, side: 'BUY', orderId: buy.orderId });
        await ensureTakeProfitSellUpToDate();
      }
    }
    
    if (side === 'SELL') {
      if (sellTp && sellTp.orderId.toString() === orderId) {
        const stats = buyStats();
        const pnl = (sellTp.price * sellTp.qty) - stats.value;
        bot.updateStats({ completedRounds: 1, realizedPnl: pnl });
        bus?.emit('order', { event: 'filled', botId: bot.id, symbol, side: 'SELL', orderId: sellTp.orderId });
        sellTp = null;
        placedBuys = [];
        filledBuys = [];
        await cancelAllRelatedOrders();
        await placeBuys();
      }
    }
  }

  async function cancelAllRelatedOrders() {
    try {
      const open = await binance.getOpenOrders(symbol);
      for (const o of open) {
        if (o.clientOrderId && o.clientOrderId.startsWith(botTag + '-')) {
          try {
            await binance.cancelOrder(symbol, o.orderId);
            bus?.emit('order', { event: 'canceled', botId: bot.id, symbol, orderId: o.orderId });
          } catch (e) {
            if (e.response?.data?.code !== -2011) {
                handleApiError(e, `cancelAll loop for orderId ${o.orderId}`);
            }
          }
        }
      }
    } catch (e) {
      handleApiError(e, 'cancelAllRelatedOrders');
    }
  }

  // 🎯 [تعديل 2]: إضافة دالة getDetails لحساب Floating PNL (النقطة 6)
  async function getDetails() {
    const stats = buyStats();
    const currentPrice = (await binance.getPrice(symbol)) || 0; // استخدام REST للحصول على أحدث سعر

    const totalHeldQuantity = stats ? stats.qty : 0;
    const totalCost = stats ? stats.value : 0;
    const avgBuyPrice = stats ? stats.avg : 0;
    
    const currentValue = totalHeldQuantity * currentPrice;
    const floatingPnl = currentValue - totalCost;

    // 🎯 [تعديل جديد]: تجميع الأوامر المفتوحة وتهيئة بيانات الكونفيج
    const openOrdersList = placedBuys.map(b => ({
        price: roundToTickSize(b.price, filters.tickSize),
        qty: roundToStepSize(b.qty, filters.stepSize),
        side: 'BUY',
        orderId: b.orderId,
        clientOrderId: b.clientOrderId
    })).concat(sellTp ? [{
        price: roundToTickSize(sellTp.price, filters.tickSize),
        qty: roundToStepSize(sellTp.qty, filters.stepSize),
        side: 'SELL', // أمر Take Profit
        orderId: sellTp.orderId,
        clientOrderId: sellTp.clientOrderId
    }] : []);
    // --------------------------------------------------------
    
    // Mock data لحقول الأرباح المطلوبة في UI (لأن الـ Runner لا يحسبها مباشرة)
    const mockInvestment = totalCost > 0 ? totalCost : orderSize * (gridLevels || 1);
    const totalPnl = bot.stats.realizedPnl + floatingPnl;
    
    // 🎯 [جديد] Mock PNL History (لإظهار المنحنى)
    // يتم استخدام وقت الإنشاء والبدء (من BotManager) لتمثيل البيانات
    const pnlCurveData = [
         { time: bot.config.timeCreated || Date.now() - 5 * 24 * 3600000, pnl: -10.0 },
         { time: bot.config.timeStarted || Date.now() - 3 * 24 * 3600000, pnl: -5.0 },
         { time: Date.now(), pnl: parseFloat(floatingPnl.toFixed(4)) }
    ];

    return {
        // PNL & Stats
      totalHeldQuantity: roundToStepSize(totalHeldQuantity, filters.stepSize),
      avgBuyPrice: roundToTickSize(avgBuyPrice, filters.tickSize),
      currentValue: roundToTickSize(currentValue, filters.tickSize),
      floatingPnl: roundToTickSize(floatingPnl, filters.tickSize),
      realizedPnl: bot.stats.realizedPnl,
      totalPnl: roundToTickSize(totalPnl, filters.tickSize),
        // 🎯 [جديد] حقول النسبة المئوية للمطابقة مع تصميم Binance
        totalPnlPercent: totalPnl / mockInvestment * 100,
        realizedPnlPercent: bot.stats.realizedPnl / mockInvestment * 100,
        floatingPnlPercent: floatingPnl / mockInvestment * 100,
        annualizedYield: 1364.52, // Mock Yield
        // 🎯 [جديد] بيانات الرسم البياني
        pnlCurveData: pnlCurveData,

        // Configuration for "Grid Details" section
        config: {
            strategy: 'DCA Buy',
            symbol: symbol,
            gridLevels: gridLevels, // DCA لا يستخدم Grid Levels بشكل مباشر، لكننا نمررها للـ UI
            gridSpread: gridSpread,
            orderSize: orderSize,
            takeProfit: takeProfit,
            durationMinutes: durationMinutes || 0,
            // 🎯 [جديد] حقول Time Tracking الحقيقية
            timeCreated: cfg.timeCreated || null,
            timeStarted: cfg.timeStarted || null,
            timeStopped: cfg.timeStopped || null,
            // 🎯 [جديد] حقول إضافية للمرجعية (لتجنب ظهور undefined)
            lowerPrice: 'N/A', upperPrice: 'N/A', initialInvestment: 'N/A',
        },
        
        // Open Orders for "Open Orders" section
        openOrdersCount: openOrdersList.length,
        openOrders: openOrdersList
    };
  }


  // --- RUNNER INTERFACE ---
  
  async function start() {
    if (isRunning) return;
    isRunning = true;
    log(`Starting DCA Buy bot ${bot.id} for ${symbol}...`);
    
    // 🎯 [تعديل 3]: إضافة منطق Duration Timer (النقطة 3)
    const durationMins = Number(durationMinutes || 0);
    if (durationMins > 0) {
      const ms = durationMins * 60 * 1000;
      durationTimer = setTimeout(() => {
        info(`[${symbol}] Bot duration of ${durationMins} minutes reached. Stopping bot automatically.`);
        stop(); 
      }, ms);
      info(`[${symbol}] Bot scheduled to stop in ${durationMins} minutes.`);
    }
    // ----------------------------

    await placeBuys();
    bus.on('order', onExecutionReport);
  }

  async function stop() {
    if (!isRunning) return;
    isRunning = false;
    log(`Stopping DCA Buy bot ${bot.id} for ${symbol}...`);
    
    // 🎯 [تعديل 4]: مسح Duration Timer عند الإيقاف
    if (durationTimer) { clearTimeout(durationTimer); durationTimer = null; }
    // ----------------------------

    bus.removeListener('order', onExecutionReport);
    await cancelAllRelatedOrders();
    log(`Bot ${bot.id} stopped.`);
  }

  return { start, stop, getDetails }; // 👈 إرجاع getDetails
}

module.exports = { createDcaBuyRunner };