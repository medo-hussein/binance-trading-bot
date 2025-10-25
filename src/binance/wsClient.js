// src/binance/wsClient.js
const WebSocket = require('ws');
const axios = require('axios');
const EventEmitter = require('events');

class BinanceWS extends EventEmitter {
  /**
   * options:
   *  - binanceClient: instance of your BinanceClient (for REST endpoints like userDataStream)
   *  - bus: EventEmitter for app-level events (optional)
   *  - cache: cache service with set/get (optional)
   *  - redisClient: optional
   */
  constructor({ binanceClient, bus, cache, baseURL }) {
    super();
    this.binance = binanceClient;
    this.bus = bus;
    this.cache = cache;
    this.baseURL = baseURL || (this.binance && this.binance.baseURL) || 'https://api.binance.com';
    this.userListenKey = null;
    this.userWs = null;
    this.marketWss = new Map(); // key: stream -> ws
    this.reconnectDelay = 1000;
    this._keepAliveTimer = null;
    this.closed = false;
  }

  async startUserStream() {
    try {
      const res = await axios.post(`${this.baseURL}/api/v3/userDataStream`, null, {
        headers: { 'X-MBX-APIKEY': this.binance.apiKey }
      });
      this.userListenKey = res.data.listenKey;
      this._openUserWS();
      // keepalive every 30s
      this._keepAliveTimer = setInterval(() => this._keepAlive().catch(err => this.emit('error', err)), 30_000);
      this.emit('info', 'userStream_started');
      if (this.bus) this.bus.emit('ws', { event: 'userStream_started' });
    } catch (e) {
      this.emit('error', { source: 'startUserStream', error: e });
    }
  }

  async _keepAlive() {
    if (!this.userListenKey) return;
    try {
      await axios.put(`${this.baseURL}/api/v3/userDataStream`, null, {
        params: { listenKey: this.userListenKey },
        headers: { 'X-MBX-APIKEY': this.binance.apiKey }
      });
    } catch (e) {
      this.emit('error', { source: 'keepalive', error: e });
    }
  }

  _openUserWS() {
    if (!this.userListenKey) return;
    const url = `wss://stream.binance.com:9443/ws/${this.userListenKey}`;
    this.userWs = new WebSocket(url);
    this.userWs.on('open', () => this.emit('info', 'userWs open'));
    this.userWs.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        // examples: executionReport, accountUpdate
        this._handleUserEvent(data);
      } catch (e) {
        this.emit('error', { source: 'userWs_parse', error: e });
      }
    });
    this.userWs.on('close', () => {
      this.emit('info', 'userWs closed, reconnecting...');
      this.userWs = null;
      setTimeout(() => this._recreateUserStream(), this.reconnectDelay);
    });
    this.userWs.on('error', (e) => this.emit('error', { source: 'userWs', error: e }));
  }

  async _recreateUserStream() {
    if (this.closed) return;
    try {
      // create a new listenKey
      await this.startUserStream();
    } catch (e) {
      setTimeout(() => this._recreateUserStream(), this.reconnectDelay);
    }
  }

  _handleUserEvent(evt) {
    // Execution reports and account updates
    // Emit on bus and update cache if needed
    try {
      if (this.bus) this.bus.emit('userEvent', evt);
      this.emit('userEvent', evt);

      // account updates: update balances cache
      if (evt.e === 'outboundAccountInfo' || evt.e === 'outboundAccountPosition' || evt.e.eventType === 'ACCOUNT_UPDATE' || evt.e === 'outboundAccountPosition') {
        // Some streams use different shapes; normalize where possible
        const balances = {}; // asset -> { free, locked }
        // For account update style
        if (evt.balances || evt.B) {
          const arr = evt.balances || evt.B;
          arr.forEach(b => { balances[b.asset] = { free: parseFloat(b.free||0), locked: parseFloat(b.locked||0) }; });
        }
        // set to cache
        if (this.cache) this.cache.set('account:balances', balances);
      }

      // execution report: order updates
      if (evt.e === 'executionReport' || evt.e === 'ORDER_TRADE_UPDATE' || evt.eventType === 'executionReport') {
        // standardize payload
        const payload = {
          type: 'executionReport',
          data: evt
        };
        if (this.bus) this.bus.emit('order', payload);
        this.emit('order', payload);
      }
    } catch (e) {
      this.emit('error', { source: 'handleUserEvent', error: e });
    }
  }

  subscribeMarketSymbol(symbol, streamType = 'trade') {
    // streamType can be 'trade', 'ticker' or 'kline_1m' etc
    const stream = `${symbol.toLowerCase()}@${streamType}`;
    if (this.marketWss.has(stream)) return;
    const url = `wss://stream.binance.com:9443/ws/${stream}`;
    const ws = new WebSocket(url);
    ws.on('open', () => this.emit('info', `marketWs open ${symbol}`));
    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        // example: trade event has p = price
        let price = null;
        if (data.p) price = Number(data.p);
        if (data.k && data.k.c) price = Number(data.k.c);
        if (price !== null) {
          // update cache with latest price
          if (this.cache) this.cache.set(`price:${symbol}`, { price, ts: Date.now() });
          // emit market event
          const m = { symbol, price, raw: data };
          if (this.bus) this.bus.emit('market', m);
          this.emit('market', m);
        } else {
          // still emit raw
          if (this.bus) this.bus.emit('market_raw', { symbol, raw: data });
          this.emit('market_raw', { symbol, raw: data });
        }
      } catch (e) { this.emit('error', { source: 'market_parse', error: e, stream }); }
    });
    ws.on('close', () => {
      this.marketWss.delete(stream);
      setTimeout(() => this.subscribeMarketSymbol(symbol, streamType), this.reconnectDelay);
    });
    ws.on('error', (e) => this.emit('error', { source: 'market_ws', error: e, stream }));
    this.marketWss.set(stream, ws);
  }

  async closeAll() {
    this.closed = true;
    try {
      if (this.userWs) try { this.userWs.close(); } catch(_) {}
      for (const ws of this.marketWss.values()) try { ws.terminate(); } catch(_) {}
      this.marketWss.clear();
      if (this._keepAliveTimer) clearInterval(this._keepAliveTimer);
      this.userListenKey = null;
    } catch (e) { /* ignore */ }
  }
}

module.exports = { BinanceWS };
