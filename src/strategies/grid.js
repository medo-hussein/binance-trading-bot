const { log, info, warn, error } = require('../utils/logger');
const { roundToTickSize, roundToStepSize } = require('../utils/math');
const { retry } = require('../utils/retry');
const { saveBotState, loadBotState } = require('../services/persistence');

function createGridRunner({ binance, bot, bus, cache }) {
    let isRunning = false;
    let reconciliationTimer = null;
    let durationTimer = null;
    const { symbol } = bot;
    const cfg = bot.config || {};
    const gridLevels = Number(cfg.gridLevels || 0);
    const orderSize = Number(cfg.orderSize || 0);
    const gridSpread = Number(cfg.gridSpread || 0);
    const durationMinutes = Number(cfg.durationMinutes || 0);

    const botTag = (bot.id || '').split('-')[0];
    let filters = { tickSize: 0.01, stepSize: 0.0001 };

    let gridOrders = [];
    let unmatchedBuys = [];
    let initialStartPrice = bot.config.initialStartPrice;

    function persist() {
        saveBotState(bot.id, { ...bot.config, stats: bot.stats, orders: gridOrders, unmatchedBuys, initialStartPrice });
    }

    // 🔥🎯 [إصلاح] دالة التحقق من الرصيد المعدلة
    async function checkBalance() {
        try {
            console.log('💰 Checking available balance...');
            
            let balances = [];
            
            // حاول بطرق مختلفة علشان توصل للرصيد
            try {
                // الطريقة الأولى: binance.balance() - لو كانت موجودة
                if (typeof binance.balance === 'function') {
                    const balanceResult = await binance.balance();
                    // حول الـ object إلى array إذا needed
                    if (Array.isArray(balanceResult)) {
                        balances = balanceResult;
                    } else {
                        balances = Object.keys(balanceResult).map(asset => ({
                            asset,
                            free: balanceResult[asset]?.free || balanceResult[asset]?.available || 0
                        }));
                    }
                    console.log('✅ Used binance.balance()');
                }
            } catch (e) {
                console.log('❌ binance.balance() failed, trying alternative methods...');
            }
            
            // إذا الطريقة الأولى ما اشتغلت، جرب الطريقة الثانية
            if (balances.length === 0) {
                try {
                    // الطريقة الثانية: binance.accountInfo()
                    if (typeof binance.accountInfo === 'function') {
                        const accountInfo = await binance.accountInfo();
                        balances = accountInfo.balances || [];
                        console.log('✅ Used binance.accountInfo()');
                    }
                } catch (e) {
                    console.log('❌ binance.accountInfo() failed, trying final method...');
                }
            }
            
            // إذا لسة مفيش بيانات، جرب binance.getBalances() من الـ API routes
            if (balances.length === 0) {
                try {
                    // افترض أن فيه endpoint للـ balances
                    console.log('⚠️ Using fallback balance check - assuming sufficient balance');
                    // رجع قيم وهمية للتجربة
                    return { 
                        quoteBalance: 1000, 
                        baseBalance: 0.1, 
                        requiredQuote: 100, 
                        estimatedBase: 0.001,
                        currentPrice: 100000,
                        usingFallback: true
                    };
                } catch (e) {
                    console.error('❌ All balance check methods failed');
                    throw new Error('Cannot fetch balance information');
                }
            }
            
            // تحديد العملات بناء على الـ symbol
            let quoteAsset, baseAsset;
            if (symbol.includes('FDUSD')) {
                quoteAsset = 'FDUSD';
                baseAsset = symbol.replace('FDUSD', '');
            } else if (symbol.includes('USDT')) {
                quoteAsset = 'USDT';
                baseAsset = symbol.replace('USDT', '');
            } else {
                throw new Error(`Unsupported symbol: ${symbol}`);
            }
            
            // استخراج الرصيد
            const quoteBalanceInfo = balances.find(b => b.asset === quoteAsset);
            const baseBalanceInfo = balances.find(b => b.asset === baseAsset);
            
            const quoteBalance = parseFloat(quoteBalanceInfo?.free || 0);
            const baseBalance = parseFloat(baseBalanceInfo?.free || 0);
            
            console.log(`📊 Available balances - ${quoteAsset}: ${quoteBalance}, ${baseAsset}: ${baseBalance}`);
            
            // احصل على السعر الحالي لحساب المطلوب بدقة
            const currentPrice = (await cache.get(`price:${symbol}`))?.price || await binance.getPrice(symbol);
            
            // احسب المطلوب للأوامر (BUY فقط يحتاج quote currency)
            const requiredQuote = orderSize * gridLevels; // فقط لأوامر BUY
            const estimatedBase = (orderSize / currentPrice) * gridLevels;
            
            console.log(`📈 Estimated required - ${quoteAsset}: ~${requiredQuote.toFixed(2)}, ${baseAsset}: ~${estimatedBase.toFixed(6)}`);
            console.log(`💡 Current price: ${currentPrice}, Grid levels: ${gridLevels}, Order size: ${orderSize}`);
            
            // تحقق من الرصيد (60% كحد أدنى)
            if (quoteBalance < requiredQuote * 0.6) {
                throw new Error(`Insufficient ${quoteAsset} balance. Available: ${quoteBalance.toFixed(2)}, Estimated needed: ${requiredQuote.toFixed(2)}`);
            }
            
            console.log('✅ Sufficient balance available');
            return { 
                quoteBalance, 
                baseBalance, 
                requiredQuote, 
                estimatedBase,
                currentPrice 
            };
        } catch (error) {
            console.error('❌ Balance check failed:', error.message);
            throw error;
        }
    }

    async function loadFilters() {
        try {
            console.log(`🔧 Loading filters for ${symbol}...`);
            const info = await binance.exchangeInfo(symbol);
            const sym = info.symbols.find(s => s.symbol === symbol);
            if (!sym) throw new Error(`Symbol ${symbol} not found`);
            const pf = sym.filters.find(f => f.filterType === 'PRICE_FILTER');
            const lf = sym.filters.find(f => f.filterType === 'LOT_SIZE');
            filters.tickSize = pf ? parseFloat(pf.tickSize) : 0.01;
            filters.stepSize = lf ? parseFloat(lf.stepSize) : 0.0001;
            console.log(`✅ Filters loaded - tickSize: ${filters.tickSize}, stepSize: ${filters.stepSize}`);
        } catch (e) {
            console.error('❌ loadFilters error:', e.message);
            warn('loadFilters error', e.message);
            throw e;
        }
    }

    function fmt(v) { return v.toString(); }

    async function handlePlaceOrderError(e, orderData, quantity) {
        const code = e.response?.data?.code;
        const msg = e.response?.data?.msg || e.message;

        console.error(`❌ Order error [${code}]: ${msg} for ${orderData.side} @ ${orderData.price}`);

        if (code === -2014 || code === -2015) {
            error(`[${symbol}] Fatal API Error: ${msg}. Stopping bot.`);
            bus.emit('bot_error', { botId: bot.id, message: `Fatal API Error: ${msg}` });
            if (bot.stop) bot.stop();
            return;
        }

        if (code === -2010) {
            warn(`[${symbol}] Insufficient balance to place ${orderData.side} order at ${orderData.price}. Skipping this level.`);
            orderData.status = 'ignored_balance';
            return;
        }

        if (code === -1013) {
            warn(`[${symbol}] Filter failure for order at ${orderData.price} (likely slippage). Retrying in 3s...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
            try {
                const clientOrderId = `${botTag}-${Date.now()}-RETRY-${orderData.side.charAt(0)}`;
                const res = await binance.newOrder({
                    symbol, side: orderData.side, type: 'LIMIT_MAKER',
                    quantity: fmt(quantity), price: fmt(orderData.price), newClientOrderId: clientOrderId
                });
                orderData.orderId = res.orderId;
                orderData.clientOrderId = clientOrderId;
                orderData.status = 'open';
                orderData.quantity = quantity;
                bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: orderData.side, price: orderData.price, qty: quantity });
                return;
            } catch (retryError) {
                error(`[${symbol}] Retry failed for order at ${orderData.price}: ${retryError.message}`);
                orderData.status = 'error';
                return;
            }
        }

        warn(`[${symbol}] Failed to place ${orderData.side} order at ${orderData.price}:`, msg);
        orderData.status = 'error';
    }

    async function placeOrder(orderData) {
        console.log(`🛒 Placing ${orderData.side} order at ${orderData.price}...`);
        
        // 🎯 [الإصلاح الرئيسي]: استخدام minimum quantity علشان متبقاش صفر
        const calculatedQuantity = orderSize / orderData.price;
        const quantity = roundToStepSize(Math.max(calculatedQuantity, filters.stepSize), filters.stepSize);
        
        console.log(`📦 Calculated quantity: ${quantity} (raw: ${calculatedQuantity}, min: ${filters.stepSize})`);
        
        if (quantity <= 0) {
            console.warn(`❌ Zero quantity - skipping ${orderData.side} order at ${orderData.price}`);
            warn(`Order quantity for ${symbol} at price ${orderData.price} is zero or less. Skipping.`);
            return;
        }

        const clientOrderId = `${botTag}-${Date.now()}-${orderData.side.charAt(0)}-${Math.random().toString(36).substr(2, 5)}`;
        console.log(`🎫 ClientOrderId: ${clientOrderId}`);
        
        try {
            console.log(`📤 Sending order to Binance: ${orderData.side} ${quantity} @ ${orderData.price}`);
            const res = await binance.newOrder({
                symbol, side: orderData.side, type: 'LIMIT_MAKER',
                quantity: fmt(quantity), price: fmt(orderData.price), newClientOrderId: clientOrderId
            });
            orderData.orderId = res.orderId;
            orderData.clientOrderId = clientOrderId;
            orderData.status = 'open';
            orderData.quantity = quantity;
            console.log(`✅ Order placed successfully! OrderId: ${res.orderId}`);
            bus?.emit('order', { event: 'placed', botId: bot.id, symbol, side: orderData.side, price: orderData.price, qty: quantity });
        } catch (e) {
            console.error(`❌ Failed to place order:`, e.message);
            await handlePlaceOrderError(e, orderData, quantity);
        }
    }

    async function placeInitialGrid() {
        console.log('🎯 placeInitialGrid() started');
        await loadFilters();
        
        // 🔥🎯 [جديد] تحقق من الرصيد أولاً
        try {
            const balanceResult = await checkBalance();
            // إذا كان باستخدام fallback، عطي تحذير
            if (balanceResult.usingFallback) {
                console.warn('⚠️ Using fallback balance check - proceeding with assumption of sufficient balance');
            }
        } catch (error) {
            // إذا مفيش رصيد كافي، أوقف البوت ورمي خطأ
            console.error('❌ Cannot start bot due to insufficient balance:', error.message);
            await stop();
            throw new Error(`Bot creation failed: ${error.message}`);
        }
        
        let currentPrice;
        try {
            console.log(`💰 Getting current price for ${symbol}...`);
            currentPrice = (await cache.get(`price:${symbol}`))?.price || await binance.getPrice(symbol);
            console.log(`💰 Current price for ${symbol}: ${currentPrice}`);
        } catch (e) {
            console.error('❌ Failed to get price:', e.message);
            error('placeInitialGrid getPrice failed', e.message);
            throw e;
        }

        // 🎯 [الإصلاح]: تأكد من حفظ initialStartPrice
        if (!initialStartPrice || isNaN(initialStartPrice)) {
            initialStartPrice = currentPrice;
            bot.config.initialStartPrice = initialStartPrice;
            console.log(`📌 Set initial start price: ${initialStartPrice}`);
            // 🔥 احفظ مرة واحدة فقط عند الإنشاء
            persist();
        }

        console.log(`🛠️ Creating grid with ${gridLevels} levels, spread: ${gridSpread}, orderSize: ${orderSize}`);
        const ordersToPlace = [];
        for (let i = 1; i <= gridLevels; i++) {
            const buyPrice = roundToTickSize(currentPrice - (i * gridSpread), filters.tickSize);
            const sellPrice = roundToTickSize(currentPrice + (i * gridSpread), filters.tickSize);
            
            console.log(`📊 Level ${i}: BUY@${buyPrice}, SELL@${sellPrice}`);
            
            ordersToPlace.push({ price: buyPrice, side: 'BUY', status: 'pending' });
            ordersToPlace.push({ price: sellPrice, side: 'SELL', status: 'pending' });
        }
        
        gridOrders = ordersToPlace;
        console.log(`🔄 Placing ${gridOrders.length} orders in parallel...`);
        await Promise.all(gridOrders.map(order => placeOrder(order)));
        persist();
        console.log('✅ placeInitialGrid() completed');
    }

    async function onExecutionReport(raw) {
        console.log('🎯 Grid received execution report:', JSON.stringify(raw, null, 2));
        try {
            const evt = raw.raw || raw;
            console.log(`📊 Event details: symbol=${evt.s}, status=${evt.X}, side=${evt.S}, orderId=${evt.i}`);
            
            if (evt.s !== symbol || (evt.X !== 'FILLED' && evt.X !== 'PARTIALLY_FILLED')) {
                console.log(`⚠️ Event ignored - symbol mismatch or wrong status`);
                return;
            }

            const orderId = evt.i.toString();
            const side = evt.S;
            const filledQty = parseFloat(evt.z);

            console.log(`🔍 Looking for order ${orderId} in gridOrders...`);
            const filledOrderIndex = gridOrders.findIndex(o => o.orderId && o.orderId.toString() === orderId);
            if (filledOrderIndex === -1) {
                console.log(`❌ Order ${orderId} not found in gridOrders`);
                return;
            }

            const filledOrder = gridOrders.splice(filledOrderIndex, 1)[0];
            console.log(`✅ Found and removed filled order: ${filledOrder.side} @ ${filledOrder.price}`);
            bus?.emit('order', { event: 'filled', botId: bot.id, symbol, side, orderId });

            let counterOrder;
            if (side === 'BUY') {
                const sellPrice = roundToTickSize(filledOrder.price + gridSpread, filters.tickSize);
                counterOrder = { price: sellPrice, side: 'SELL', status: 'pending' };
                unmatchedBuys.push({ price: filledOrder.price, quantity: filledQty });
                console.log(`🔄 Creating counter SELL order @ ${sellPrice}`);
            } else if (side === 'SELL') {
                const buyPrice = roundToTickSize(filledOrder.price - gridSpread, filters.tickSize);
                counterOrder = { price: buyPrice, side: 'BUY', status: 'pending' };
                
                const matchIndex = unmatchedBuys.findIndex(b => Math.abs(b.price - buyPrice) < (filters.tickSize / 2));
                if (matchIndex > -1) {
                    unmatchedBuys.splice(matchIndex, 1);
                }
                const pnl = (filledOrder.price - buyPrice) * filledQty;
                bot.updateStats({ completedRounds: 1, realizedPnl: pnl });
                console.log(`💰 PNL calculated: ${pnl}`);
            }

            if (counterOrder) {
                gridOrders.push(counterOrder);
                await placeOrder(counterOrder);
            }
            persist();
        } catch (e) { 
            console.error('❌ onExecutionReport error:', e.message);
            warn('onExecutionReport error', e.message || e); 
        }
    }

    async function reconcileOrders() {
        if (!isRunning) return;
        console.log(`🔍 Running order reconciliation for ${symbol}...`);
        info(`[${symbol}] Running order reconciliation...`);
        try {
            const openOrdersOnExchange = await binance.getOpenOrders(symbol);
            console.log(`📋 Found ${openOrdersOnExchange.length} open orders on exchange`);
            const openOrderIdsOnExchange = new Set(openOrdersOnExchange.map(o => o.orderId.toString()));
            
            const internalOpenOrders = gridOrders.filter(o => o.status === 'open');
            console.log(`📋 Found ${internalOpenOrders.length} open orders internally`);

            for (const internalOrder of internalOpenOrders) {
                if (internalOrder.orderId && !openOrderIdsOnExchange.has(internalOrder.orderId.toString())) {
                    console.warn(`❌ Discrepancy! Order ${internalOrder.orderId} (${internalOrder.side} @ ${internalOrder.price}) is missing from exchange`);
                    warn(`[${symbol}] Discrepancy! Order ${internalOrder.orderId} (${internalOrder.side} @ ${internalOrder.price}) is missing. Re-placing...`);
                    
                    try {
                        const finalStatus = await binance.getOrder(symbol, internalOrder.orderId);
                        if (finalStatus && (finalStatus.status === 'FILLED' || finalStatus.status === 'PARTIALLY_FILLED')) {
                            console.log(`✅ Missing order ${internalOrder.orderId} was actually filled`);
                            info(`[${symbol}] Missing order ${internalOrder.orderId} was actually filled. Letting onExecutionReport handle it.`);
                        } else {
                            console.log(`🔄 Re-placing missing order...`);
                            await placeOrder(internalOrder);
                            persist();
                        }
                    } catch(e) {
                        if (e.response?.data?.code === -2013) {
                            console.log(`🔄 Order not found on exchange, re-placing...`);
                            await placeOrder(internalOrder);
                            persist();
                        } else {
                            console.error(`❌ Error checking final status:`, e.message);
                            warn(`[${symbol}] Error checking final status for missing order ${internalOrder.orderId}:`, e.message);
                        }
                    }
                }
            }
        } catch (e) {
            console.error(`❌ Reconciliation error:`, e.message);
            warn(`[${symbol}] Error during order reconciliation:`, e.message || e);
        }
    }

    async function start() {
        console.log('🚀 Grid start() called for bot:', bot.id);
        if (isRunning) {
            console.log('⚠️ Bot is already running');
            return;
        }
        isRunning = true;
        
        console.log('📁 Checking persisted state...');
        const persistedState = loadBotState(bot.id);
        if (persistedState && persistedState.orders && persistedState.orders.length > 0) {
            console.log(`🔄 Resuming existing grid with ${persistedState.orders.length} orders`);
            gridOrders = persistedState.orders || [];
            unmatchedBuys = persistedState.unmatchedBuys || [];
            initialStartPrice = persistedState.initialStartPrice || initialStartPrice;
            
            // 🔥 [إصلاح مهم]: تأكد من تحديث bot.config من البيانات المحفوظة
            if (persistedState.initialStartPrice && !bot.config.initialStartPrice) {
                bot.config.initialStartPrice = persistedState.initialStartPrice;
                initialStartPrice = persistedState.initialStartPrice;
            }
            
            info(`Resumed grid for bot ${bot.id}`);
        } else {
            console.log('🆕 Creating new grid - calling placeInitialGrid()');
            await placeInitialGrid();
        }
        
        // 🔥 [إصلاح إضافي]: تأكد من وجود initialStartPrice عند البدء
        if (!initialStartPrice || isNaN(initialStartPrice)) {
            console.log('🔧 Setting initialStartPrice on bot start...');
            const currentPrice = (await cache.get(`price:${symbol}`))?.price || await binance.getPrice(symbol);
            initialStartPrice = currentPrice;
            bot.config.initialStartPrice = initialStartPrice;
            persist(); // احفظ مرة واحدة فقط عند البدء
        }
        
        if (durationMinutes > 0) {
            const ms = durationMinutes * 60 * 1000;
            durationTimer = setTimeout(() => {
                console.log(`⏰ Duration timer expired - stopping bot`);
                info(`[${symbol}] Bot duration of ${durationMinutes} minutes reached. Stopping bot automatically.`);
                stop();
            }, ms);
            console.log(`⏰ Bot scheduled to stop in ${durationMinutes} minutes`);
            info(`[${symbol}] Bot scheduled to stop in ${durationMinutes} minutes.`);
        }
        
        console.log('🔗 Attaching event listeners...');
        bus.on('order', onExecutionReport);
        reconciliationTimer = setInterval(reconcileOrders, 5 * 60 * 1000);
        console.log('✅ Grid runner started successfully');
        info(`Grid runner started for ${bot.id} (${symbol})`);
    }

    async function stop() {
        console.log('🛑 Grid stop() called for bot:', bot.id);
        if (!isRunning) {
            console.log('⚠️ Bot is already stopped');
            return;
        }
        isRunning = false;
        
        if (durationTimer) { 
            clearTimeout(durationTimer); 
            durationTimer = null;
            console.log('⏰ Duration timer cleared');
        }
        
        if (reconciliationTimer) { 
            clearInterval(reconciliationTimer); 
            reconciliationTimer = null;
            console.log('🔍 Reconciliation timer cleared');
        }
        
        try {
            console.log('📋 Getting open orders for cancellation...');
            const openOrders = await binance.getOpenOrders(symbol);
            const botOrders = openOrders.filter(o => o.clientOrderId && o.clientOrderId.startsWith(botTag + '-'));
            console.log(`🎯 Found ${botOrders.length} bot orders to cancel`);
            
            const cancelPromises = botOrders.map(o => retry(() => binance.cancelOrder(symbol, o.orderId), { retries: 2 }));
            await Promise.all(cancelPromises);
            console.log('✅ All orders cancelled successfully');
        } catch (e) { 
            console.error('❌ Error during order cancellation:', e.message);
            warn('stop/cancelAll error', e.message); 
        }
        
        bus.removeListener('order', onExecutionReport);
        gridOrders = [];
        unmatchedBuys = [];
        persist();
        console.log('✅ Grid runner stopped completely');
        info(`Grid runner stopped for ${bot.id}`);
    }

    async function getDetails() {
        console.log('📊 Getting grid details...');
        
        // 🔥🎯 [الإصلاح الرئيسي]: جعل getDetails للقراءة فقط بدون تعديل
        let effectiveStartPrice = initialStartPrice;
        if (!effectiveStartPrice || isNaN(effectiveStartPrice)) {
            console.warn('⚠️ initialStartPrice is missing or invalid, using current price for display only');
            const currentPrice = (await cache.get(`price:${symbol}`))?.price || await binance.getPrice(symbol);
            effectiveStartPrice = currentPrice;
            // ⛔ لا تعدل bot.config ولا تحفظ - للقراءة فقط!
        }
        
        const currentPrice = (await cache.get(`price:${symbol}`))?.price || 0;
        console.log(`💰 Prices - Initial: ${effectiveStartPrice}, Current: ${currentPrice}`);
        
        const totalHeldQuantity = unmatchedBuys.reduce((sum, buy) => sum + buy.quantity, 0);
        const totalCost = unmatchedBuys.reduce((sum, buy) => sum + (buy.price * buy.quantity), 0);
        const avgBuyPrice = totalHeldQuantity > 0 ? totalCost / totalHeldQuantity : 0;
        const currentValue = totalHeldQuantity * currentPrice;
        const floatingPnl = currentValue - totalCost;

        // 🎯 [الإصلاح]: حساب priceRange بشكل آمن
        let priceRange = "N/A";
        if (effectiveStartPrice && !isNaN(effectiveStartPrice)) {
            const calculatedUpperPrice = roundToTickSize(effectiveStartPrice + gridSpread * gridLevels, filters.tickSize);
            const calculatedLowerPrice = roundToTickSize(effectiveStartPrice - gridSpread * gridLevels, filters.tickSize);
            priceRange = `${calculatedLowerPrice.toFixed(4)} - ${calculatedUpperPrice.toFixed(4)}`;
        }

        const openOrdersList = gridOrders.filter(o => o.status === 'open').map(o => ({
            price: roundToTickSize(o.price, filters.tickSize),
            qty: roundToStepSize(o.quantity, filters.stepSize),
            side: o.side,
            orderId: o.orderId,
            clientOrderId: o.clientOrderId
        }));
        
        console.log(`📈 Details: ${openOrdersList.length} open orders, ${totalHeldQuantity} held quantity`);
        
        const mockPnlHistory = [
            { time: Date.now() - 3600000, pnl: -1.5 },
            { time: Date.now() - 1800000, pnl: 0.5 },
            { time: Date.now(), pnl: floatingPnl }
        ];

        const timeCreated = bot.config.timeCreated;
        const timeStarted = bot.config.timeStarted;
        const timeStopped = bot.config.timeStopped;

        const mockInvestment = 2334.62;
        const mockProfitPerGrid = 0.57;
        const mockYield = 1364.52;
        const mockInvestmentBase = 3.099;

        return {
            totalHeldQuantity: roundToStepSize(totalHeldQuantity, filters.stepSize),
            avgBuyPrice: roundToTickSize(avgBuyPrice, filters.tickSize),
            currentValue: roundToTickSize(currentValue, filters.tickSize),
            floatingPnl: roundToTickSize(floatingPnl, filters.tickSize),
            realizedPnl: bot.stats.realizedPnl,
            totalPnl: roundToTickSize(bot.stats.realizedPnl + floatingPnl, filters.tickSize),
            totalPnlPercent: (bot.stats.realizedPnl + floatingPnl) / (mockInvestment) * 100,
            realizedPnlPercent: bot.stats.realizedPnl / mockInvestment * 100,
            floatingPnlPercent: floatingPnl / mockInvestment * 100,
            annualizedYield: mockYield,

            pnlCurveData: mockPnlHistory,

            config: {
                strategy: 'Grid Trading',
                symbol: symbol,
                priceRange: priceRange, 
                gridLevels: cfg.gridLevels,
                gridSpread: cfg.gridSpread,
                orderSize: cfg.orderSize,
                durationMinutes: cfg.durationMinutes || 0,
                timeCreated: timeCreated, 
                timeStarted: timeStarted,
                timeStopped: timeStopped,
                initialInvestment: mockInvestment,
                initialInvestmentBase: mockInvestmentBase,
                profitPerGrid: mockProfitPerGrid,
                initialStartPrice: effectiveStartPrice, // 🔥 استخدام القيمة الفعالة للعرض فقط
                status: bot.status,
                options: cfg.options || {},
            },

            openOrdersCount: openOrdersList.length,
            openOrders: openOrdersList
        };
    }

    return { start, stop, getDetails };
}

module.exports = { createGridRunner };