const axios = require('axios');
const crypto = require('crypto');
const { info, warn, error } = require('../utils/logger');
const { retry } = require('../utils/retry');

class BinanceClient {
  constructor({ apiKey, apiSecret, baseURL }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.baseURL = baseURL || 'https://api.binance.com';
    this.http = axios.create({ baseURL: this.baseURL, timeout: 15000 });
    this.timeOffset = 0;
    this.syncTime().catch(() => {});
    this._timeSyncTimer = setInterval(() => this.syncTime().catch(()=>{}), 60_000);
  }

  async ping() {
    return retry(() => this.http.get('/api/v3/ping').then(r=>r.data), { retries: 2 });
  }

  async getServerTime() {
    const data = await retry(() => this.http.get('/api/v3/time').then(r=>r.data), { retries: 2 });
    return data.serverTime || data;
  }

  async syncTime() {
    try {
        const before = Date.now();
        const serverTime = await this.getServerTime();
        if (typeof serverTime !== 'number') {
            warn('syncTime failed: getServerTime did not return a number.');
            return;
        }
        const after = Date.now();
        const rtt = after - before;
        const localNow = after - Math.floor(rtt / 2);
        this.timeOffset = serverTime - localNow;
        info('Time sync offset(ms):', this.timeOffset);
        return this.timeOffset;
    } catch (e) {
        error('syncTime error', e.message || e);
    }
  }

  async exchangeInfo(symbol) {
    return retry(() => this.http.get('/api/v3/exchangeInfo', symbol ? { params: { symbol } } : undefined).then(r=>r.data), { retries: 2 });
  }

  _sign(params) {
    const query = new URLSearchParams(params).toString();
    return crypto.createHmac('sha256', this.apiSecret).update(query).digest('hex');
  }

  async _signedRequest(method, path, params = {}) {
    const fn = async () => {
      const timestamp = Date.now() + (this.timeOffset || 0);
      const fullParams = { ...params, timestamp };
      const signature = this._sign(fullParams);
      const headers = { 'X-MBX-APIKEY': this.apiKey };
      const config = { method, url: path, headers };
      if (method.toLowerCase() === 'get' || method.toLowerCase() === 'delete') {
        config.params = { ...fullParams, signature };
      } else {
        config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        config.data = new URLSearchParams({ ...fullParams, signature }).toString();
      }
      const { data } = await this.http.request(config);
      return data;
    };
    return retry(fn, { retries: 3, minTimeout: 300, factor: 2, onRetry: async ({ attempt, err }) => {
      warn(`_signedRequest retry ${attempt} for ${method} ${path} due to ${err && err.message}`);
    }});
  }

  // MARKET DATA
  async getPrice(symbol) {
    const { data } = await retry(() => this.http.get('/api/v3/ticker/price', { params: { symbol } }).then(r=>r), { retries: 2 });
    return parseFloat(data.price);
  }

  // ================== NEW FUNCTION START ==================
  async klines(symbol, interval, params = {}) {
    // This is a public endpoint, no signing needed.
    return retry(() => this.http.get('/api/v3/klines', { params: { symbol, interval, ...params } }).then(r => r.data), { retries: 2 });
  }
  // =================== NEW FUNCTION END ===================

  // ORDERS (SPOT)
  async newOrder(params) {
    return this._signedRequest('post', '/api/v3/order', params);
  }
  async cancelOrder(symbol, orderId) {
    return this._signedRequest('delete', '/api/v3/order', { symbol, orderId });
  }
  async cancelOrderByClientId(symbol, origClientOrderId) {
    return this._signedRequest('delete', '/api/v3/order', { symbol, origClientOrderId });
  }
  async cancelAllOrders(symbol) {
    return this._signedRequest('delete', '/api/v3/openOrders', { symbol });
  }
  async getOrder(symbol, orderId) {
    return this._signedRequest('get', '/api/v3/order', { symbol, orderId });
  }
  
  // ================== ENHANCED OPEN ORDERS FUNCTION ==================
  async getOpenOrders(symbol) {
    try {
      const orders = await this._signedRequest('get', '/api/v3/openOrders', symbol ? { symbol } : {});
      
      // تحويل البيانات إلى الصيغة المطلوبة للواجهة
      return orders.map(order => ({
        order_id: order.orderId,
        client_order_id: order.clientOrderId,
        type: order.side, // 'BUY' or 'SELL'
        price: order.price,
        quantity: order.origQty,
        executed_quantity: order.executedQty,
        symbol: order.symbol,
        status: order.status,
        time_in_force: order.timeInForce,
        created_at: new Date(order.time),
        updated_at: new Date(order.updateTime || order.time)
      }));
    } catch (err) {
      error('Error in getOpenOrders:', err.message || err);
      return [];
    }
  }
  // =================== ENHANCED OPEN ORDERS END ===================
  
  async accountInfo() {
    return this._signedRequest('get', '/api/v3/account');
  }

  // ================== NEW FUNCTION: GET ALL ORDERS ==================
  async getAllOrders(symbol, options = {}) {
    try {
      const params = { symbol, ...options };
      const orders = await this._signedRequest('get', '/api/v3/allOrders', params);
      
      return orders.map(order => ({
        order_id: order.orderId,
        client_order_id: order.clientOrderId,
        type: order.side,
        price: order.price,
        quantity: order.origQty,
        executed_quantity: order.executedQty,
        symbol: order.symbol,
        status: order.status,
        time_in_force: order.timeInForce,
        created_at: new Date(order.time),
        updated_at: new Date(order.updateTime || order.time)
      }));
    } catch (err) {
      error('Error in getAllOrders:', err.message || err);
      return [];
    }
  }
  // =================== NEW FUNCTION END ===================
}

module.exports = { BinanceClient };