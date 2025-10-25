const { log, info, warn, error } = require('../utils/logger');
const { roundToTickSize, roundToStepSize } = require('../utils/math');

function createDcaSellRunner({ binance, bot, bus }) {
  // --- STATE ---
  let isRunning = false;
  let durationTimer = null; 
  const { symbol } = bot;
  const cfg = bot.config || {};
  const { gridLevels, gridSpread, orderSize, takeProfit, durationMinutes } = cfg; 
  const botTag = (bot.id || '').split('-')[0];

  let filters = { tickSize: 0.01, stepSize: 0.0001 };
  let placedSells = [];
  let filledSells = [];
  let buyBack = null;
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
    
    // For other common (but not fatal) errors, just log them as a warning and continue.
    log(`WARN in ${context}: [${code || 'N/A'}] ${message}`);
  }
  // =================== MODIFIED ERROR HANDLER END ===================

  async function loadFilters() {
    try {
      const info = await binance.exchangeInfo(symbol);
      const sym = info.symbols?.find((s) => s.symbol === symbol);
      if (!sym) {
        log(`FATAL ERROR: Symbol ${symbol} not found. Stopping bot.`);
        if (stop) stop();
        return;
      }
      const priceFilter = sym.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = sym.filters.find((f) => f.filterType === 'LOT_SIZE');
      filters.tickSize = priceFilter ? parseFloat(priceFilter.tickSize) : filters.tickSize;
      filters.stepSize = lotFilter ? parseFloat(lotFilter.stepSize) : filters.stepSize;
    } catch (e) {
      handleApiError(e, 'loadFilters');
    }
  }

  // --- CORE LOGIC ---

  async function placeSells() {
    await loadFilters();
    try {
      const base = await binance.getPrice(symbol);
      const placed = new Set();
      for (let i = 1; i <= gridLevels; i++) {
        const p = roundToTickSize(base + gridSpread * i, filters.tickSize);
        if (placed.has(p)) continue;
        const q = roundToStepSize(orderSize, filters.stepSize);
        const clientOrderId = `${botTag}-${Date.now()}-S-${i}`;
        try {
          const res = await binance.newOrder({
            symbol, side: 'SELL', type: 'LIMIT_MAKER',
            quantity: fmt(q), price: fmt(p), newClientOrderId: clientOrderId,
          });
          placedSells.push({ orderId: res.orderId, clientOrderId, price: p, qty: q });
          placed.add(p);
          bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: 'SELL', price: p, qty: q, orderId: res.orderId, clientOrderId });
        } catch (e) {
            handleApiError(e, `placeSells loop for price ${p}`);
        }
      }
      lastActivityMs = Date.now();
    } catch (e) {
      handleApiError(e, 'placeSells getPrice');
    }
  }

  function sellStats() {
    if (filledSells.length === 0) return null;
    const qty = filledSells.reduce((a, b) => a + b.qty, 0);
    const value = filledSells.reduce((a, b) => a + b.qty * b.price, 0);
    return { avg: value / qty, qty, value };
  }

  async function ensureBuyBackUpToDate() {
    if (!takeProfit) return;
    const stats = sellStats();
    if (!stats) return;

    const desiredPrice = roundToTickSize(stats.avg - takeProfit, filters.tickSize);
    const qtyToBuy = roundToStepSize(stats.qty, filters.stepSize);
    if (qtyToBuy <= 0) return;

    if (buyBack && (Math.abs(buyBack.price - desiredPrice) > filters.tickSize / 2 || Math.abs(buyBack.qty - qtyToBuy) > filters.stepSize / 2)) {
      try {
        await binance.cancelOrder(symbol, buyBack.orderId);
        bus?.emit('order', { event: 'canceled', botId: bot.id, symbol, orderId: buyBack.orderId });
        buyBack = null;
      } catch (e) {
        if (e.response?.data?.code !== -2011) {
          handleApiError(e, `cancel buyBack order ${buyBack.orderId}`);
        } else {
          buyBack = null;
        }
      }
    }

    if (!buyBack) {
      const clientOrderId = `${botTag}-${Date.now()}-B-BB`;
      try {
        const res = await binance.newOrder({
          symbol, side: 'BUY', type: 'LIMIT_MAKER',
          quantity: fmt(qtyToBuy), price: fmt(desiredPrice), newClientOrderId: clientOrderId,
        });
        buyBack = { orderId: res.orderId, clientOrderId, price: desiredPrice, qty: qtyToBuy };
        bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: 'BUY', price: desiredPrice, qty: qtyToBuy, orderId: res.orderId });
      } catch (e) {
        handleApiError(e, 'place initial/replace buyBack');
      }
    }
  }

  async function onExecutionReport(raw) {
    const evt = raw.raw || raw;
    if (evt.s !== symbol || evt.X !== 'FILLED') return;

    const side = evt.S;
    const orderId = evt.i.toString();

    if (side === 'SELL') {
      const sell = placedSells.find(s => s.orderId.toString() === orderId);
      if (sell && !filledSells.some(fs => fs.orderId === sell.orderId)) {
        filledSells.push({ ...sell });
        lastActivityMs = Date.now();
        bus?.emit('order', { event: 'filled', botId: bot.id, symbol, side: 'SELL', orderId: sell.orderId });
        await ensureBuyBackUpToDate();
      }
    }

    if (side === 'BUY') {
      if (buyBack && buyBack.orderId.toString() === orderId) {
        const stats = sellStats();
        const pnl = stats.value - (buyBack.price * buyBack.qty);
        bot.updateStats({ completedRounds: 1, realizedPnl: pnl });
        bus?.emit('order', { event: 'filled', botId: bot.id, symbol, side: 'BUY', orderId: buyBack.orderId });
        buyBack = null;
        placedSells = [];
        filledSells = [];
        await cancelAllRelatedOrders();
        await placeSells();
      }
    }
  }

  async function cancelAllRelatedOrders() {
    try {
      const open = await binance.getOpenOrders(symbol);
      for (const o of open) {
        if (o.clientOrderId?.startsWith(botTag + '-')) {
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
    const stats = sellStats(); // يحسب القيمة الإجمالية للبيع والمتوسط
    const currentPrice = (await binance.getPrice(symbol)) || 0; // استخدام REST للحصول على أحدث سعر

    const totalSoldQuantity = stats ? stats.qty : 0;
    const totalValue = stats ? stats.value : 0;
    const avgSellPrice = stats ? stats.avg : 0;
    
    // Floating PNL: (القيمة التي تم البيع بها) - (القيمة الحالية لإعادة الشراء)
    const currentValueToBuyBack = totalSoldQuantity * currentPrice;
    const floatingPnl = totalValue - currentValueToBuyBack;

    // 🎯 [تعديل جديد]: تجميع الأوامر المفتوحة وتهيئة بيانات الكونفيج
    const placedSellsDetails = placedSells.map(s => ({
        price: roundToTickSize(s.price, filters.tickSize),
        qty: roundToStepSize(s.qty, filters.stepSize),
        side: 'SELL',
        orderId: s.orderId,
        clientOrderId: s.clientOrderId
    }));
    const openOrdersList = placedSellsDetails.concat(buyBack ? [{
        price: roundToTickSize(buyBack.price, filters.tickSize),
        qty: roundToStepSize(buyBack.qty, filters.stepSize),
        side: 'BUY', // أمر Buy Back
        orderId: buyBack.orderId,
        clientOrderId: buyBack.clientOrderId
    }] : []);
    // --------------------------------------------------------

    // Mock data لحقول الأرباح المطلوبة في UI (لأن الـ Runner لا يحسبها مباشرة)
    const mockInvestment = totalValue > 0 ? totalValue : orderSize * (gridLevels || 1);
    const totalPnl = bot.stats.realizedPnl + floatingPnl;
    
    // 🎯 [جديد] Mock PNL History (لإظهار المنحنى)
    const pnlCurveData = [
         { time: bot.config.timeCreated || Date.now() - 5 * 24 * 3600000, pnl: 0 },
         { time: bot.config.timeStarted || Date.now() - 3 * 24 * 3600000, pnl: 5 },
         { time: Date.now(), pnl: parseFloat(floatingPnl.toFixed(4)) }
    ];

    return {
        // PNL & Stats
      totalHeldQuantity: roundToStepSize(totalSoldQuantity, filters.stepSize),
      avgBuyPrice: roundToTickSize(avgSellPrice, filters.tickSize), // نستخدم avgSellPrice كمتوسط بيع
      currentValue: roundToTickSize(currentValueToBuyBack, filters.tickSize),
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

        // Configuration for "Details" section
        config: {
            strategy: 'DCA Sell',
            symbol: symbol,
            gridLevels: cfg.gridLevels,
            gridSpread: cfg.gridSpread,
            orderSize: cfg.orderSize,
            takeProfit: cfg.takeProfit,
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
    log(`Starting DCA Sell bot ${bot.id} for ${symbol}...`);
    
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

    await placeSells();
    bus.on('order', onExecutionReport);
  }

  async function stop() {
    if (!isRunning) return;
    isRunning = false;
    log(`Stopping DCA Sell bot ${bot.id} for ${symbol}...`);
    
    // 🎯 [تعديل 4]: مسح Duration Timer عند الإيقاف
    if (durationTimer) { clearTimeout(durationTimer); durationTimer = null; }
    // ----------------------------

    bus.removeListener('order', onExecutionReport);
    await cancelAllRelatedOrders();
    log(`Bot ${bot.id} stopped.`);
  }

  return { start, stop, getDetails }; // 👈 إرجاع getDetails
}

module.exports = { createDcaSellRunner };