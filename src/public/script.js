// --- Helper Functions ---

// 🎯 [تعديل 1]: دالة تحويل مدة التشغيل (من المللي ثانية إلى h m s)
function formatDuration(ms) {
    if (ms === undefined || ms === null || ms < 1000) return '0s';
    let seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    seconds %= 3600;
    const minutes = Math.floor(seconds / 60);
    seconds %= 60;

    let parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`); 
    
    return parts.join(' ');
}

async function fetchJSON(url, options) {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
}

function $(s) { return document.querySelector(s); }

// --- Chart Variables ---
let priceChart;

// --- Chart Functions (REWRITTEN FOR CANDLESTICK) ---
function initChart() {
    const ctx = document.getElementById('priceChart').getContext('2d');
    priceChart = new Chart(ctx, {
        type: 'candlestick',
        options: {
            animation: false,
            scales: {
                x: {
                    type: 'time',
                    time: { unit: 'minute' },
                    ticks: { source: 'auto', color: '#e5ecff', maxRotation: 0, autoSkip: true, maxTicksLimit: 10 }
                },
                y: {
                    position: 'right',
                    ticks: { color: '#e5ecff' }
                }
            },
            plugins: { legend: { display: false } }
        }
    });
}

async function loadHistoricalKlines(symbol) {
    if (!priceChart || !symbol) return;
    try {
        const klines = await fetchJSON(`/api/klines?symbol=${symbol.toUpperCase()}`);
        priceChart.data.datasets = [{
            label: `${symbol} 1m`,
            data: klines.map(k => ({
                x: k.time,
                o: k.open,
                h: k.high,
                l: k.low,
                c: k.close
            }))
        }];
        priceChart.update();
    } catch (e) {
        console.error(`Failed to load historical klines for ${symbol}:`, e);
    }
}

function updateCandlestick(candle) {
    if (!priceChart || !priceChart.data.datasets?.[0]?.data) return;

    const data = priceChart.data.datasets[0].data;
    if (data.length === 0) return;

    const lastCandle = data[data.length - 1];
    const newCandleData = {
        x: candle.startTime,
        o: candle.open,
        h: candle.high,
        l: candle.low,
        c: candle.close
    };

    if (lastCandle.x === candle.startTime) {
        data[data.length - 1] = newCandleData;
    } else {
        data.push(newCandleData);
        if (data.length > 200) { // Keep a maximum of 200 candles
            data.shift();
        }
    }
    priceChart.update('none');
}

// ================== NEW: OPEN ORDERS MANAGEMENT ==================
let currentOrderWS = null;
let currentBotId = null;

// دالة جلب الطلبات المفتوحة من الـ API
async function loadOpenOrders(botId) {
    try {
        const response = await fetchJSON(`/api/bots/${botId}/orders`);
        return response.open_orders || [];
    } catch (error) {
        console.error('Failed to load open orders:', error);
        return [];
    }
}

// دالة الاشتراك في تحديثات الطلبات المباشرة
function subscribeToOrderUpdates(botId, onOrderUpdate) {
    // إلغاء أي اشتراك سابق
    if (currentOrderWS) {
        currentOrderWS.close();
    }

    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    currentOrderWS = new WebSocket(url);
    currentBotId = botId;

    currentOrderWS.onopen = () => {
        console.log('WebSocket connected for order updates');
        // طلب الاشتراك في تحديثات الطلبات
        currentOrderWS.send(JSON.stringify({
            type: 'subscribe_orders',
            botId: botId
        }));
    };

    currentOrderWS.onmessage = (event) => {
        try {
            const message = JSON.parse(event.data);
            
            if (message.type === 'order_update') {
                // تحديث مباشر للطلبات
                onOrderUpdate(message.data);
            } else if (message.type === 'subscription_confirmed') {
                console.log('Subscribed to order updates for bot:', botId);
            }
        } catch (error) {
            console.error('Error processing WebSocket message:', error);
        }
    };

    currentOrderWS.onclose = () => {
        console.log('WebSocket connection closed for order updates');
    };

    currentOrderWS.onerror = (error) => {
        console.error('WebSocket error for order updates:', error);
    };

    return currentOrderWS;
}

// دالة إلغاء الاشتراك
function unsubscribeFromOrderUpdates() {
    if (currentOrderWS) {
        currentOrderWS.send(JSON.stringify({
            type: 'unsubscribe_orders'
        }));
        currentOrderWS.close();
        currentOrderWS = null;
        currentBotId = null;
    }
}

// دالة تحديث واجهة الطلبات المفتوحة
function updateOpenOrdersDisplay(orders, baseAsset, quoteAsset) {
    const ordersContainer = document.getElementById('openOrdersContent');
    
    if (!orders || orders.length === 0) {
        ordersContainer.innerHTML = `
            <div class="no-orders">
                <i class="fas fa-inbox" style="font-size: 48px; color: #666; margin-bottom: 16px;"></i>
                <p style="color: #666; text-align: center;">No open orders</p>
            </div>
        `;
        return;
    }

    let html = `
        <div class="orders-header">
            <span>Open Orders (${orders.length})</span>
            <button onclick="refreshOpenOrders('${currentBotId}')" class="refresh-btn">
                <i class="fas fa-sync-alt"></i> Refresh
            </button>
        </div>
        <table class="orders-table">
            <thead>
                <tr>
                    <th>Type</th>
                    <th>Price (${quoteAsset})</th>
                    <th>Quantity (${baseAsset})</th>
                    <th>Filled</th>
                    <th>Status</th>
                    <th>Time</th>
                </tr>
            </thead>
            <tbody>
    `;

    orders.forEach(order => {
        const isBuy = order.type === 'BUY';
        const filledPercent = order.executed_quantity && order.quantity ? 
            ((order.executed_quantity / order.quantity) * 100).toFixed(1) : '0';
        
        html += `
            <tr class="order-row ${isBuy ? 'buy-order' : 'sell-order'}">
                <td>
                    <span class="order-type ${isBuy ? 'buy' : 'sell'}">
                        <i class="fas ${isBuy ? 'fa-arrow-up' : 'fa-arrow-down'}"></i>
                        ${order.type}
                    </span>
                </td>
                <td class="price">${parseFloat(order.price).toFixed(8)}</td>
                <td class="quantity">${parseFloat(order.quantity).toFixed(6)}</td>
                <td class="filled">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: ${filledPercent}%"></div>
                        <span class="progress-text">${filledPercent}%</span>
                    </div>
                </td>
                <td class="status">
                    <span class="status-badge ${order.status.toLowerCase()}">${order.status}</span>
                </td>
                <td class="time">${new Date(order.created_at).toLocaleTimeString()}</td>
            </tr>
        `;
    });

    html += `
            </tbody>
        </table>
    `;

    ordersContainer.innerHTML = html;
}

// دالة تحديث الطلبات يدوياً
async function refreshOpenOrders(botId) {
    try {
        const orders = await loadOpenOrders(botId);
        const details = currentBotDetails || await fetchJSON(`/api/bots/${botId}/details`);
        const baseAsset = details.config.symbol.replace(/.*(USDT|BUSD|FDUSD|BTC|ETH)$/i, '') || 'Unknown';
        const quoteAsset = details.config.symbol.replace(/(USDT|BUSD|FDUSD|BTC|ETH)$/i, '') || 'Unknown';
        
        updateOpenOrdersDisplay(orders, baseAsset, quoteAsset);
    } catch (error) {
        console.error('Failed to refresh open orders:', error);
    }
}
// ================== END OF OPEN ORDERS MANAGEMENT ==================

// --- Main Application Logic ---
async function loadHealth() {
    try {
        const h = await fetchJSON('/api/health');
        const dt = new Date(h.serverTime).toLocaleString();
        $('#serverStatus').textContent = `Server OK | Binance Time: ${dt} | Offset: ${h.timeOffset} ms`;
        $('#serverStatus').style.color = '#7CFC00';
    } catch (e) {
        $('#serverStatus').textContent = 'Server health failed';
        $('#serverStatus').style.color = '#DC143C';
    }
}

// 🎯 [إصلاح كامل]: تحويل لنظام SPA بدل Page Reload
// ================== SPA NAVIGATION START ==================
let currentBotDetails = null;

function navigateToBotDetails(botId) {
    // إخفاء الـ Dashboard وإظهار صفحة التفاصيل
    document.querySelector('main').style.display = 'none';
    document.getElementById('botDetailsContainer').style.display = 'block';
    
    // تحميل بيانات البوت
    loadBotDetailsInPage(botId);
}

// 🎯 [إصلاح كامل]: دالة العودة للـ Dashboard مع إعادة التهيئة
function navigateToDashboard() {
    try {
        console.log('Navigating back to dashboard...');
        
        // ١. إخفاء صفحة التفاصيل وإظهار الـ Dashboard
        const detailsContainer = document.getElementById('botDetailsContainer');
        const mainDashboard = document.querySelector('main');
        
        if (detailsContainer) {
            detailsContainer.style.display = 'none';
        }
        
        if (mainDashboard) {
            mainDashboard.style.display = 'block';
        }
        
        // ٢. إلغاء الاشتراك في تحديثات الطلبات
        unsubscribeFromOrderUpdates();
        
        // ٣. إعادة تحميل البيانات الأساسية
        loadBots();
        loadHealth();
        
        // ٤. 🎯 [الإصلاح الجديد] - إعادة تهيئة الـ Chart والـ Form
        setTimeout(() => {
            reinitializeDashboardComponents();
        }, 200);
        
    } catch (error) {
        console.error('Error navigating to dashboard:', error);
        // Fallback: إعادة تحميل الصفحة كحل أخير
        window.location.reload();
    }
}

// 🎯 [دالة جديدة]: إعادة تهيئة مكونات الـ Dashboard
function reinitializeDashboardComponents() {
    console.log('Reinitializing dashboard components...');
    
    // ١. إعادة تحميل بيانات السوق
    const symbolInput = $('#symbolInput');
    if (symbolInput && symbolInput.value) {
        refreshMarket().then(() => {
            console.log('Market data reloaded');
        }).catch(error => {
            console.error('Error refreshing market:', error);
        });
    }
    
    // ٢. 🎯 [الإصلاح المهم] - إعادة تهيئة الـ Chart
    reinitializePriceChart();
    
    // ٣. إعادة تهيئة الـ Form
    setTimeout(() => {
        syncVisibility();
        renderPreview();
        console.log('Form reinitialized');
    }, 300);
}

// 🎯 [دالة جديدة]: إعادة تهيئة الـ Price Chart
function reinitializePriceChart() {
    const chartCanvas = document.getElementById('priceChart');
    if (!chartCanvas) {
        console.log('Price chart canvas not found');
        return;
    }
    
    // تدمير الـ Chart القديم إذا كان موجود
    if (priceChart && typeof priceChart.destroy === 'function') {
        try {
            priceChart.destroy();
            console.log('Old price chart destroyed');
        } catch (e) {
            console.log('Error destroying old chart:', e);
        }
    }
    
    // إنشاء Chart جديد بعد تأخير بسيط
    setTimeout(() => {
        try {
            initChart();
            console.log('New price chart initialized');
            
            // تحميل البيانات التاريخية بعد ما الـ Chart يتهيأ
            const symbol = $('#symbolInput').value.trim().toUpperCase();
            if (symbol) {
                setTimeout(() => {
                    loadHistoricalKlines(symbol);
                    console.log('Historical klines loaded for:', symbol);
                }, 500);
            }
        } catch (error) {
            console.error('Error initializing new chart:', error);
        }
    }, 100);
}

async function loadBotDetailsInPage(botId) {
    try {
        const details = await fetchJSON(`/api/bots/${botId}/details`);
        currentBotDetails = details;
        
        const container = document.getElementById('botDetailsContent');
        const quoteAsset = details.config.symbol.replace(/.*(USDT|BUSD|FDUSD|BTC|ETH)$/i, '$1') || 'USD';
        const baseAsset = details.config.symbol.replace(/(USDT|BUSD|FDUSD|BTC|ETH)$/i, '');
        
        // حساب المدة الحية
        const durationMs = details.config.timeStarted ? 
            (details.config.timeStopped || Date.now()) - details.config.timeStarted : 
            details.stats?.lastDurationMs || 0;
        
        // جلب الطلبات المفتوحة
        const openOrders = await loadOpenOrders(botId);
        
        container.innerHTML = `
            <div class="bot-details-header">
                <h2>${details.config.strategy} - ${details.config.symbol}</h2>
                <button onclick="navigateToDashboard()" class="back-btn">← Back to Dashboard</button>
            </div>
            
            <div class="top-info-row">
                <div class="time-info">
                    <span><strong>Duration:</strong> ${formatDuration(durationMs)}</span>
                    <span><strong>Status:</strong> ${details.config.status || 'Unknown'}</span>
                </div>
            </div>

            <div class="pnl-section">
                <div class="pnl-summary-card">
                    <h3>Profit & Loss</h3>
                    <div class="pnl-grid">
                        <div class="pnl-item">
                            <span class="label">Total PNL</span>
                            <span class="value ${details.totalPnl >= 0 ? 'profit' : 'loss'}">
                                ${details.totalPnl >= 0 ? '+' : ''}${details.totalPnl?.toFixed(4) || '0.0000'} ${quoteAsset}
                            </span>
                        </div>
                        <div class="pnl-item">
                            <span class="label">Realized PNL</span>
                            <span class="value ${details.realizedPnl >= 0 ? 'profit' : 'loss'}">
                                ${details.realizedPnl >= 0 ? '+' : ''}${details.realizedPnl?.toFixed(4) || '0.0000'} ${quoteAsset}
                            </span>
                        </div>
                        <div class="pnl-item">
                            <span class="label">Floating PNL</span>
                            <span class="value ${details.floatingPnl >= 0 ? 'profit' : 'loss'}">
                                ${details.floatingPnl >= 0 ? '+' : ''}${details.floatingPnl?.toFixed(4) || '0.0000'} ${quoteAsset}
                            </span>
                        </div>
                        <div class="pnl-item">
                            <span class="label">Held Quantity</span>
                            <span class="value">${details.totalHeldQuantity?.toFixed(6) || '0.000000'} ${baseAsset}</span>
                        </div>
                    </div>
                </div>
            </div>

            <div class="config-section">
                <h3>Configuration</h3>
                <div class="config-grid">
                    <div class="config-item"><span>Strategy:</span> <strong>${details.config.strategy}</strong></div>
                    <div class="config-item"><span>Symbol:</span> <strong>${details.config.symbol}</strong></div>
                    <div class="config-item"><span>Grid Levels:</span> ${details.config.gridLevels || 'N/A'}</div>
                    <div class="config-item"><span>Grid Spread:</span> ${details.config.gridSpread ? details.config.gridSpread.toFixed(4) : 'N/A'}</div>
                    <div class="config-item"><span>Order Size:</span> ${details.config.orderSize ? details.config.orderSize.toFixed(4) : 'N/A'}</div>
                    <div class="config-item"><span>Take Profit:</span> ${details.config.takeProfit ? details.config.takeProfit.toFixed(4) : 'N/A'}</div>
                    <div class="config-item"><span>Duration:</span> ${details.config.durationMinutes > 0 ? details.config.durationMinutes + ' mins' : 'None'}</div>
                    <div class="config-item"><span>Created:</span> ${new Date(details.config.timeCreated).toLocaleString()}</div>
                </div>
            </div>

            <div class="orders-section">
                <h3>Open Orders</h3>
                <div id="openOrdersContent">
                    <!-- سيتم تحميل الطلبات هنا ديناميكياً -->
                </div>
            </div>
        `;
        
        // تحديث عرض الطلبات المفتوحة
        updateOpenOrdersDisplay(openOrders, baseAsset, quoteAsset);
        
        // الاشتراك في تحديثات الطلبات المباشرة
        subscribeToOrderUpdates(botId, (orderUpdate) => {
            console.log('Received order update:', orderUpdate);
            // عند تلقي تحديث، نعيد تحميل الطلبات
            refreshOpenOrders(botId);
        });
        
    } catch (error) {
        console.error('Failed to load bot details:', error);
        document.getElementById('botDetailsContent').innerHTML = `
            <div class="error-message">
                <h2>Error Loading Bot Details</h2>
                <p>${error.message}</p>
                <button onclick="navigateToDashboard()" class="back-btn">← Back to Dashboard</button>
            </div>
        `;
    }
}
// =================== SPA NAVIGATION END ===================

async function loadBots() {
    try {
        const bots = await fetchJSON('/api/bots');
        const c = $('#bots');
        c.innerHTML = '';
        if (bots.length === 0) {
            c.textContent = 'No bots have been created yet.';
            return;
        }
        bots.forEach(b => {
            // 🎯 [إصلاح الـ Duration]: استخدام حساب مباشر للوقت الحقيقي
            const durationToShowMs = b.status === 'running' && b.timeStarted ? 
                Date.now() - b.timeStarted : 
                b.stats?.lastDurationMs || 0;
                
            const durationDisplay = formatDuration(durationToShowMs);
            const pnlDisplay = b.stats?.realizedPnl?.toFixed(4) || '0.0000';

            const div = document.createElement('div');
            div.className = 'bot';
            div.innerHTML = `
                <div class="meta">
                    <strong>${b.name}</strong> <span>${b.strategy}</span> <span>${b.symbol}</span>
                    <span class="status-${b.status}">Status: ${b.status}</span>
                    <span>Rounds: ${b.stats?.completedRounds || 0}</span>
                    <span>PnL: ${pnlDisplay}</span>
                    <span>Duration: ${durationDisplay}</span>
                </div>
                <div class="actions button-column">
                    <button data-act="details" data-id="${b.id}" class="details-btn">Details</button>
                    <button data-act="start" data-id="${b.id}" class="action-start" ${b.status === 'running' ? 'disabled' : ''}>Start</button>
                    <button data-act="stop" data-id="${b.id}" class="action-stop" ${b.status !== 'running' ? 'disabled' : ''}>Stop</button>
                </div>`;
            c.appendChild(div);

            // 🎯 [التعديل]: استخدام دالة SPA الجديدة
            div.querySelector('[data-act="details"]').addEventListener('click', (e) => {
                e.preventDefault();
                navigateToBotDetails(b.id);
            });
        });
    } catch (e) { 
        console.error('Failed to load bots:', e);
        $('#bots').innerHTML = '<p style="color: #dc143c;">Error loading bots</p>';
    }
}

async function loadSymbols() {
    try {
        const symbols = await fetchJSON('/api/symbols');
        const symbolInput = $('#symbolInput');
        symbolInput.innerHTML = '';
        symbols.forEach(symbol => {
            const option = document.createElement('option');
            option.value = symbol;
            option.textContent = symbol;
            if (symbol === 'BTCFDUSD') {
                option.selected = true;
            }
            symbolInput.appendChild(option);
        });
        symbolInput.dispatchEvent(new Event('change'));
    } catch (e) {
        console.error('Failed to load symbols', e);
        $('#symbolInput').innerHTML = '<option value="">Failed to load symbols</option>';
    }
}

function initForm() {
    const form = document.getElementById('botForm');
    const strategyEl = document.getElementById('strategySelect');
    const takeProfitRow = document.getElementById('takeProfitRow');
    const gridOpts = document.querySelectorAll('.gridOpt');
    const symbolInput = $('#symbolInput');
    const currentPriceEl = $('#currentPrice');
    const useStartPriceEl = $('#useStartPrice');
    const startPriceInput = $('#startPriceInput');
    const balancesInfoEl = $('#balancesInfo');
    const capitalInput = $('#capitalInput');
    const gridLevelsInput = $('#gridLevelsInput');
    const gridSpreadInput = $('#gridSpreadInput');
    const orderSizeInput = $('#orderSizeInput');
    const formHintEl = $('#formHint');
    const pvSymbol = $('#pvSymbol'), pvBQ = $('#pvBQ'), pvPrice = $('#pvPrice'), pvLevels = $('#pvLevels'),
        pvOrderSize = $('#pvOrderSize'), pvSpread = $('#pvSpread'), pvChannel = $('#pvChannel'),
        pvProfit = $('#pvProfit'), pvTotalCost = $('#pvTotalCost'), pvCapital = $('#pvCapital'), pvMaxLevels = $('#pvMaxLevels');

    let lastSymbolMeta = { baseAsset: '-', quoteAsset: '-', tickSize: 0.01, stepSize: 0.0001 };
    let lastPrice = null;

    function syncVisibility() {
        const v = strategyEl.value;
        takeProfitRow.style.display = (v === 'dca_buy' || v === 'dca_sell') ? '' : 'none';
        gridOpts.forEach(el => { el.style.display = (v === 'grid') ? '' : 'none'; });
        document.querySelectorAll('.recenterOpt').forEach(el => { el.style.display = (v === 'grid' || v === 'dca_buy') ? '' : 'none'; });
    }
    strategyEl.addEventListener('change', syncVisibility);
    syncVisibility();

    async function refreshMarket() {
        const symbol = symbolInput.value.trim().toUpperCase();
        if (!symbol) return;
        
        await loadHistoricalKlines(symbol);

        try {
            const [p, info, bals] = await Promise.all([
                fetchJSON(`/api/price?symbol=${encodeURIComponent(symbol)}`),
                fetchJSON(`/api/symbolInfo?symbol=${encodeURIComponent(symbol)}`),
                fetchJSON(`/api/balances?symbol=${encodeURIComponent(symbol)}`)
            ]);
            lastPrice = Number(p.price);
            currentPriceEl.textContent = lastPrice?.toFixed(8) ?? '-';
            lastSymbolMeta = { baseAsset: info.baseAsset, quoteAsset: info.quoteAsset, tickSize: info.tickSize, stepSize: info.stepSize };
            balancesInfoEl.textContent = `${info.baseAsset}: ${bals.baseFree.toFixed(6)} (free) | ${info.quoteAsset}: ${bals.quoteFree.toFixed(2)} (free)`;
            if (!capitalInput.value) capitalInput.value = Number(bals.quoteFree).toFixed(2);
            renderPreview();
        } catch (e) {
            currentPriceEl.textContent = '-';
            balancesInfoEl.textContent = '-';
        }
    }

    function renderPreview() {
        const levels = Number(gridLevelsInput.value || 0);
        const spread = Number(gridSpreadInput.value || 0);
        const orderSize = Number(orderSizeInput.value || 0);
        const cap = Number(capitalInput.value || 0);
        const effectivePrice = useStartPriceEl.checked && startPriceInput.value ? Number(startPriceInput.value) : lastPrice;

        pvSymbol.textContent = symbolInput.value.trim() || '-';
        pvBQ.textContent = `${lastSymbolMeta.baseAsset}/${lastSymbolMeta.quoteAsset}`;
        pvPrice.textContent = effectivePrice ? effectivePrice.toFixed(8) : '-';
        pvLevels.textContent = levels || '-';
        pvOrderSize.textContent = orderSize || '-';
        pvSpread.textContent = spread || '-';

        if (effectivePrice && levels > 0 && spread > 0) {
            const low = effectivePrice - spread * levels;
            const high = effectivePrice + spread;
            pvChannel.textContent = `${low.toFixed(8)} ↔ ${high.toFixed(8)}`;
        } else {
            pvChannel.textContent = '-';
        }

        if (spread > 0 && orderSize > 0) {
            pvProfit.textContent = `${(spread * orderSize).toFixed(6)} ${lastSymbolMeta.quoteAsset}`;
        } else {
            pvProfit.textContent = '-';
        }
        
        let totalCost = 0;
        if (effectivePrice && levels > 0 && spread > 0 && orderSize > 0) {
            for (let i = 1; i <= levels; i++) {
                totalCost += orderSize * Math.max(0, effectivePrice - spread * i);
            }
            pvTotalCost.textContent = `${totalCost.toFixed(2)} ${lastSymbolMeta.quoteAsset}`;
        } else {
            pvTotalCost.textContent = '-';
        }

        pvCapital.textContent = cap ? `${cap.toFixed(2)} ${lastSymbolMeta.quoteAsset}` : '-';
        let maxLevels = 0;
        if (effectivePrice && spread > 0 && orderSize > 0 && cap > 0) {
            let cost = 0;
            for (let i = 1; i <= 1000; i++) {
                const add = orderSize * Math.max(0, effectivePrice - spread * i);
                if (cost + add <= cap) { cost += add; maxLevels = i; } else break;
            }
        }
        pvMaxLevels.textContent = maxLevels || '-';

        const createBtn = $('#createBtn');
        if (levels > 0 && maxLevels > 0 && levels > maxLevels) {
            formHintEl.textContent = `Levels exceed capital. Max affordable = ${maxLevels}.`;
            createBtn.disabled = true;
        } else {
            formHintEl.textContent = '';
            createBtn.disabled = false;
        }
    }

    ['input', 'change'].forEach(evt => {
        symbolInput.addEventListener(evt, refreshMarket);
        useStartPriceEl.addEventListener(evt, () => { startPriceInput.disabled = !useStartPriceEl.checked; renderPreview(); });
        [startPriceInput, capitalInput, gridLevelsInput, gridSpreadInput, orderSizeInput].forEach(el => {
            el.addEventListener(evt, renderPreview);
        });
    });

    refreshMarket();
    setInterval(() => { refreshMarket(); }, 10000);

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const payload = {
            name: fd.get('name'),
            strategy: fd.get('strategy'),
            symbol: fd.get('symbol'),
            config: {
                gridLevels: Number(fd.get('gridLevels')),
                gridSpread: Number(fd.get('gridSpread')),
                orderSize: Number(fd.get('orderSize')),
                takeProfit: fd.get('takeProfit') ? Number(fd.get('takeProfit')) : undefined,
                options: {
                    recenterEnabled: fd.get('recenterEnabled') === 'on',
                    recenterMinutes: fd.get('recenterMinutes') ? Number(fd.get('recenterMinutes')) : undefined,
                    sellOnStopEnabled: fd.get('sellOnStopEnabled') === 'on',
                    sellOnStopMinutes: fd.get('sellOnStopMinutes') ? Number(fd.get('sellOnStopMinutes')) : undefined,
                    startPrice: (useStartPriceEl.checked && startPriceInput.value) ? Number(startPriceInput.value) : undefined,
                    capital: $('#capitalInput').value ? Number($('#capitalInput').value) : undefined,
                }
            }
        };
        try {
            await fetchJSON('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            form.reset();
            strategyEl.value = 'grid';
            syncVisibility();
            refreshMarket();
            loadBots();
        } catch (err) {
            alert(`Failed to create bot: ${err.message}`);
        }
    });
}

function initWS() {
    const statusEl = document.getElementById('wsStatus');
    const listEl = document.getElementById('events');
    const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    let ws;
    function connect() {
        statusEl.textContent = 'WS: connecting...';
        ws = new WebSocket(url);
        ws.onopen = () => { statusEl.textContent = 'WS: connected'; statusEl.style.color = '#7CFC00'; };
        ws.onclose = () => { statusEl.textContent = 'WS: disconnected, retrying...'; statusEl.style.color = '#DC143C'; setTimeout(connect, 3000); };
        ws.onerror = () => { statusEl.textContent = 'WS: error'; statusEl.style.color = '#DC143C';};
        ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            const dt = new Date().toLocaleTimeString();
            
            if (msg.type === 'kline' && msg.symbol === $('#symbolInput').value.trim().toUpperCase()) {
                updateCandlestick(msg);
                $('#currentPrice').textContent = msg.close.toFixed(4);
            }

            const li = document.createElement('li');
            let shouldDisplay = false;

            if (msg.type === 'order') {
                li.textContent = `[${dt}] ORDER: ${msg.symbol} | ${msg.event?.toUpperCase()} | ${msg.side||''} @ ${msg.price||''}`;
                shouldDisplay = true;
                if (['filled', 'canceled', 'rejected'].includes(msg.event)) loadBots();
            } else if (msg.type === 'bot') {
                li.textContent = `[${dt}] BOT: Bot ${msg.botId} has ${msg.event}`;
                shouldDisplay = true;
                loadBots();
            }
            
            if (shouldDisplay) {
                listEl.prepend(li);
                while (listEl.children.length > 100) listEl.removeChild(listEl.lastChild);
            }
        };
    }
    connect();
}

// --- Initializer ---
window.addEventListener('DOMContentLoaded', () => {
    initForm();
    initChart();
    initWS();
    loadHealth();
    loadBots();
    loadSymbols();
    setInterval(loadHealth, 30000);
    
    // Event listener for all bot actions
    $('#bots').addEventListener('click', async (e) => {
        const btn = e.target.closest('button[data-id]');
        if (!btn) return;
        
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-act');

        if (act === 'details') {
            // 🎯 [الإصلاح]: استخدام نظام SPA الجديد
            navigateToBotDetails(id);
            return;
        }

        btn.disabled = true;
        try {
            await fetchJSON(`/api/bots/${id}/${act}`, { method: 'POST' });
            await loadBots();
        } catch(err) {
            alert(`Failed to ${act} bot: ${err.message}`);
            await loadBots();
        }
    });
});

// جعل الدوال متاحة globally للاستخدام في الـ HTML
window.navigateToBotDetails = navigateToBotDetails;
window.navigateToDashboard = navigateToDashboard;
window.refreshOpenOrders = refreshOpenOrders;
window.reinitializeDashboardComponents = reinitializeDashboardComponents;
window.reinitializePriceChart = reinitializePriceChart;