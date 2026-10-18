import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { generateSignature } from '../signing';

/**
 * ⚠ MOCK EXCHANGE — NOT DELTA EXCHANGE.
 *
 * A local test double that implements the documented Delta REST + WebSocket behaviour closely
 * enough to exercise the adapter and the live executor end-to-end WITHOUT touching a real exchange:
 *   - HMAC signature verification (method+timestamp+path+query+body), 5-second expiry, User-Agent check
 *   - products / tickers / L2 book / candles, balances, positions, orders, fills, leverage
 *   - a tiny matching engine: market, IOC and GTC limit, reduce-only, stop-market, partial fills
 *   - 429 rate limiting with X-RATE-LIMIT-RESET, failure injection (timeouts, 500s, "processed but
 *     connection dropped") and websocket channels (ob_l1, trades, candlestick_1m, mark_price,
 *     funding_rate, plus authenticated positions/orders/margins/user_trades) with heartbeats
 *   - an optional model of Delta's "Scalper Offer" (`scalperOffer`, OFF by default): a fill that closes a
 *     position opened at most `windowMs` earlier (mock clock) reports commission 0
 * It is used by the automated tests and by `npm run dev:mock`. It never talks to the internet.
 */

/** Model of Delta's Scalper Offer inside the mock: closing fills within `windowMs` of the position opening are free. */
export interface MockScalperOffer {
  enabled: boolean;
  windowMs: number;
}

export interface MockOptions {
  port?: number;
  apiKey?: string;
  apiSecret?: string;
  productId?: number;
  symbol?: string;
  contractValue?: number;
  tickSize?: number;
  makerRate?: number;
  takerRate?: number;
  initialMarginPct?: number;
  maintenanceMarginPct?: number;
  startingBalance?: number;
  startPrice?: number;
  /** Fraction of an order that fills immediately (1 = full). Remainder of IOC orders is cancelled. */
  partialFillRatio?: number;
  /** Heartbeat interval for websocket clients that enable it. */
  heartbeatMs?: number;
  tradingStatus?: string;
  /** Require the User-Agent header like the real CDN does. */
  requireUserAgent?: boolean;
  allowedSkewSec?: number;
  /**
   * Model of Delta's "Scalper Offer" (a LOCAL stand-in: nothing here was verified against the real exchange).
   * When enabled, a fill that CLOSES (reduces) a position that was opened at most `windowMs` earlier on the mock
   * clock pays no commission; opening fills and closes outside the window pay the normal fee. Default: disabled,
   * so existing tests keep their meaning.
   */
  scalperOffer?: MockScalperOffer;
}

type FailMode = 'timeout' | 'http500' | 'drop-after-process' | 'drop-before-process' | 'http429';

interface MockOrder {
  id: number;
  client_order_id: string | null;
  product_id: number;
  product_symbol: string;
  side: 'buy' | 'sell';
  size: number;
  unfilled_size: number;
  order_type: string;
  limit_price: string | null;
  stop_price: string | null;
  stop_order_type: string | null;
  time_in_force: string;
  reduce_only: boolean;
  state: 'open' | 'pending' | 'closed' | 'cancelled';
  average_fill_price: string | null;
  paid_commission: string;
  cancellation_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockFill {
  id: string;
  order_id: string;
  product_id: number;
  product_symbol: string;
  side: 'buy' | 'sell';
  size: number;
  price: string;
  role: 'maker' | 'taker';
  commission: string;
  fill_type: 'normal';
  created_at: string;
}

export class MockDeltaExchange {
  readonly opts: Required<MockOptions>;
  server!: http.Server;
  wss!: WebSocketServer;
  port = 0;

  bid: number;
  ask: number;
  last: number;
  mark: number;
  fundingRate = 0.01; // percent per 8h, like the docs sample

  orders = new Map<number, MockOrder>();
  fills: MockFill[] = [];
  position = { size: 0, entry: 0 };
  balance: number;
  realizedPnl = 0;
  /** Cumulative realised funding shown on the position (signed cashflow, negative = paid). */
  realizedFunding = 0;
  leverage = 10;
  candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  requestLog: { method: string; path: string; query: string; body: string; authed: boolean; status: number }[] = [];
  /** Orders accepted by POST /v2/orders (for assertions that "no order was placed"). */
  placedOrderRequests: any[] = [];
  /** Mock-clock time at which the current position was opened (null while flat). */
  positionOpenedAt: number | null = null;
  /** Total commission waived by the modelled Scalper Offer so far (USD). */
  scalperWaivedUsd = 0;

  private nextOrderId = 1000;
  private nextFillId = 1;
  private failures: { match: RegExp; mode: FailMode; times: number }[] = [];
  private rateLimit: { remaining: number; resetMs: number } | null = null;
  private clients = new Set<{ ws: WebSocket; subs: Map<string, Set<string>>; authed: boolean; heartbeat?: NodeJS.Timeout }>();
  private nowFn: () => number = Date.now;

  constructor(opts: MockOptions = {}) {
    this.opts = {
      port: 0,
      apiKey: 'test-key',
      apiSecret: 'test-secret',
      productId: 3136,
      symbol: 'ETHUSD',
      contractValue: 0.01,
      tickSize: 0.05,
      makerRate: 0.0002,
      takerRate: 0.0005,
      initialMarginPct: 1,
      maintenanceMarginPct: 0.5,
      startingBalance: 1000,
      startPrice: 3000,
      partialFillRatio: 1,
      heartbeatMs: 300,
      tradingStatus: 'operational',
      requireUserAgent: true,
      allowedSkewSec: 5,
      scalperOffer: { enabled: false, windowMs: 30 * 60_000 },
      ...opts,
    };
    this.bid = this.opts.startPrice - 0.05;
    this.ask = this.opts.startPrice + 0.05;
    this.last = this.opts.startPrice;
    this.mark = this.opts.startPrice;
    this.balance = this.opts.startingBalance;
  }

  get restUrl() {
    return `http://127.0.0.1:${this.port}`;
  }
  get wsUrl() {
    return `ws://127.0.0.1:${this.port}`;
  }

  setClock(fn: () => number) {
    this.nowFn = fn;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this.onWsConnection(ws));
    await new Promise<void>((r) => this.server.listen(this.opts.port, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    return this.restUrl;
  }

  async stop() {
    for (const c of this.clients) {
      if (c.heartbeat) clearInterval(c.heartbeat);
      c.ws.terminate();
    }
    this.clients.clear();
    this.wss.close();
    await new Promise<void>((r) => {
      this.server.closeAllConnections?.();
      this.server.close(() => r());
    });
  }

  // ---------------- failure / limit injection ----------------
  failNext(match: RegExp, mode: FailMode, times = 1) {
    this.failures.push({ match, mode, times });
  }
  clearFailures() {
    this.failures = [];
  }
  limitRequests(remaining: number, resetMs = 1000) {
    this.rateLimit = { remaining, resetMs };
  }
  dropWsConnections() {
    for (const c of this.clients) c.ws.terminate();
  }
  get wsClientCount() {
    return this.clients.size;
  }

  // ---------------- market state ----------------
  setQuote(bid: number, ask: number, last?: number) {
    this.bid = bid;
    this.ask = ask;
    this.last = last ?? (bid + ask) / 2;
    this.mark = this.last;
    this.broadcast('ob_l1', this.opts.symbol, { type: 'ob_l1', ap: String(ask), as: '100', bp: String(bid), bs: '100', lts: this.ts(), sy: this.opts.symbol, ts: this.ts() });
    this.broadcast('trades', this.opts.symbol, { type: 'trades', p: String(this.last), r: 't', s: 1, sy: this.opts.symbol, t: this.ts(), ts: this.ts() });
    this.broadcast('mark_price', `MARK:${this.opts.symbol}`, { type: 'mark_price', p: String(this.mark), sy: `MARK:${this.opts.symbol}`, ts: this.ts() });
    this.matchResting();
  }

  pushCandleUpdate(c: { o: number; h: number; l: number; c: number; v: number }, tsMs = this.nowFn()) {
    this.broadcast('candlestick_1m', this.opts.symbol, { type: 'candlestick_1m', ...c, res: '1m', sy: this.opts.symbol, ts: tsMs * 1000 });
  }

  pushFunding() {
    this.broadcast('funding_rate', this.opts.symbol, { type: 'funding_rate', fi: 28800, fr: this.fundingRate, nfr: 0, sy: this.opts.symbol, ts: this.ts() });
  }

  private ts() {
    return this.nowFn() * 1000;
  }

  // ---------------- HTTP ----------------
  private json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), Date: new Date(this.nowFn()).toUTCString(), ...headers });
    res.end(text);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const method = (req.method ?? 'GET').toUpperCase();
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const queryString = url.search; // raw "?a=b&c=d" as sent
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const log = { method, path, query: queryString, body, authed: false, status: 0 };
    this.requestLog.push(log);
    const done = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      log.status = status;
      this.json(res, status, payload, headers);
    };

    if (this.opts.requireUserAgent && !req.headers['user-agent']) {
      return done(403, { error: 'Forbidden', message: 'Request blocked by CDN' });
    }

    // injected failures
    const f = this.failures.find((x) => x.times > 0 && x.match.test(`${method} ${path}`));
    let afterProcessDrop = false;
    if (f) {
      f.times--;
      if (f.mode === 'timeout') return; // never answer
      if (f.mode === 'http500') return done(500, { success: false, error: { code: 'internal_error' } });
      if (f.mode === 'http429') return done(429, { success: false, error: { code: 'rate_limited' } }, { 'X-RATE-LIMIT-RESET': '300' });
      if (f.mode === 'drop-before-process') return void req.socket.destroy();
      if (f.mode === 'drop-after-process') afterProcessDrop = true;
    }

    if (this.rateLimit) {
      if (this.rateLimit.remaining <= 0) return done(429, { success: false, error: { code: 'rate_limited' } }, { 'X-RATE-LIMIT-RESET': String(this.rateLimit.resetMs) });
      this.rateLimit.remaining--;
    }

    let parsed: any = null;
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      return done(400, { success: false, error: { code: 'invalid_json' } });
    }

    const isPublic = /^\/v2\/(products|tickers|l2orderbook|history\/candles|assets|settings)/.test(path) && method === 'GET' && !/\/orders\/leverage$/.test(path);
    if (!isPublic) {
      const authError = this.checkAuth(req, method, path, queryString, body);
      if (authError) return done(authError.status, authError.body);
      log.authed = true;
    }

    try {
      const out = this.route(method, path, url.searchParams, parsed);
      if (afterProcessDrop) return void req.socket.destroy();
      return done(out.status ?? 200, out.body);
    } catch (e: any) {
      return done(400, { success: false, error: { code: e?.code ?? 'bad_request', context: e?.context ?? {} } });
    }
  }

  private checkAuth(req: http.IncomingMessage, method: string, path: string, query: string, body: string): { status: number; body: unknown } | null {
    const key = req.headers['api-key'];
    const ts = req.headers['timestamp'];
    const sig = req.headers['signature'];
    if (!key || !ts || !sig) return { status: 401, body: { success: false, error: { code: 'invalid_api_key' } } };
    if (key !== this.opts.apiKey) return { status: 401, body: { success: false, error: { code: 'invalid_api_key' } } };
    const skew = Math.abs(this.nowFn() / 1000 - Number(ts));
    if (!(skew <= this.opts.allowedSkewSec)) return { status: 401, body: { error: 'SignatureExpired', message: 'your signature has expired' } };
    const expected = generateSignature(this.opts.apiSecret, method + String(ts) + path + query + body);
    if (expected !== sig) return { status: 401, body: { success: false, error: { code: 'Signature Mismatch' } } };
    return null;
  }

  private productJson() {
    const o = this.opts;
    return {
      id: o.productId,
      symbol: o.symbol,
      description: 'Ethereum Perpetual futures (MOCK)',
      notional_type: 'vanilla',
      initial_margin: String(o.initialMarginPct),
      maintenance_margin: String(o.maintenanceMarginPct),
      contract_value: String(o.contractValue),
      contract_unit_currency: 'ETH',
      tick_size: String(o.tickSize),
      state: 'live',
      trading_status: o.tradingStatus,
      default_leverage: '50',
      taker_commission_rate: String(o.takerRate),
      maker_commission_rate: String(o.makerRate),
      contract_type: 'perpetual_futures',
      position_size_limit: 100000,
      underlying_asset: { id: 1, symbol: 'ETH' },
      quoting_asset: { id: 14, symbol: 'USD' },
      settling_asset: { id: 14, symbol: 'USD' },
    };
  }

  private route(method: string, path: string, q: URLSearchParams, b: any): { status?: number; body: unknown } {
    const ok = (result: unknown, meta?: unknown) => ({ body: { success: true, result, ...(meta ? { meta } : {}) } });
    const sym = this.opts.symbol;
    const pid = this.opts.productId;

    if (method === 'GET' && path === `/v2/products/${sym}`) return ok(this.productJson());
    if (method === 'GET' && path === `/v2/tickers/${sym}`)
      return ok({ symbol: sym, product_id: pid, close: this.last, mark_price: String(this.mark), spot_price: String(this.last), quotes: { best_bid: String(this.bid), best_ask: String(this.ask), bid_size: '100', ask_size: '100' }, timestamp: this.ts(), volume: 1000 });
    if (method === 'GET' && path === `/v2/l2orderbook/${sym}`)
      return ok({ symbol: sym, buy: [{ price: String(this.bid), size: 100, depth: '100' }], sell: [{ price: String(this.ask), size: 100, depth: '100' }], last_updated_at: this.ts() });
    if (method === 'GET' && path === '/v2/history/candles') {
      const start = Number(q.get('start'));
      const end = Number(q.get('end'));
      return ok(this.candles.filter((c) => c.time >= start && c.time <= end).slice(0, 2000).reverse()); // docs do not promise order; return descending
    }

    if (method === 'GET' && path === '/v2/wallet/balances') return ok(this.walletJson(), undefined);
    if (method === 'GET' && path === '/v2/positions') return ok(this.positionJson());
    if (method === 'GET' && path === '/v2/positions/margined') return ok(this.position.size === 0 ? [] : [this.positionJson()]);
    if (method === 'GET' && path === '/v2/orders') {
      const states = (q.get('states') ?? 'open,pending').split(',');
      return ok([...this.orders.values()].filter((o) => states.includes(o.state)));
    }
    if (method === 'POST' && path === '/v2/orders') return ok(this.placeOrder(b));
    if (method === 'DELETE' && path === '/v2/orders') return ok(this.cancelOrder(b));
    const byId = /^\/v2\/orders\/(\d+)$/.exec(path);
    if (method === 'GET' && byId) {
      const o = this.orders.get(Number(byId[1]));
      if (!o) throw Object.assign(new Error('nf'), { code: 'order_not_found' });
      return ok(o);
    }
    const byCid = /^\/v2\/orders\/client_order_id\/(.+)$/.exec(path);
    if (method === 'GET' && byCid) {
      const cid = decodeURIComponent(byCid[1]);
      const o = [...this.orders.values()].find((x) => x.client_order_id === cid);
      if (!o) return { status: 404, body: { success: false, error: { code: 'order_not_found' } } };
      return ok(o);
    }
    if (method === 'GET' && path === '/v2/fills') return ok([...this.fills].reverse(), { after: null, before: null });
    if (path === `/v2/products/${pid}/orders/leverage`) {
      if (method === 'GET') return ok({ leverage: this.leverage, order_margin: '0', product_id: pid });
      if (method === 'POST') {
        const lev = Number(b?.leverage);
        const max = 100 / this.opts.initialMarginPct;
        if (!(lev >= 1)) throw Object.assign(new Error('min'), { code: 'min_leverage_exceeded' });
        if (lev > max) throw Object.assign(new Error('max'), { code: 'max_leverage_exceeded' });
        this.leverage = lev;
        return ok({ leverage: lev, order_margin: '0', product_id: pid });
      }
    }
    return { status: 404, body: { success: false, error: { code: 'not_found' } } };
  }

  // ---------------- trading engine ----------------
  private walletJson() {
    const used = (Math.abs(this.position.size) * this.opts.contractValue * (this.position.entry || 0)) / this.leverage;
    return [
      {
        asset_id: 14,
        asset_symbol: 'USD',
        balance: String(this.balance.toFixed(8)),
        available_balance: String((this.balance - used).toFixed(8)),
        blocked_margin: String(used.toFixed(8)),
        order_margin: '0',
        position_margin: String(used.toFixed(8)),
      },
    ];
  }

  private positionJson() {
    const p = this.position;
    const liqFrac = Math.max(0, 1 / this.leverage - this.opts.maintenanceMarginPct / 100);
    return {
      product_id: this.opts.productId,
      product_symbol: this.opts.symbol,
      size: p.size,
      entry_price: p.size === 0 ? null : String(p.entry),
      margin: String(((Math.abs(p.size) * this.opts.contractValue * p.entry) / this.leverage).toFixed(8)),
      liquidation_price: p.size === 0 ? null : String(p.size > 0 ? p.entry * (1 - liqFrac) : p.entry * (1 + liqFrac)),
      bankruptcy_price: null,
      mark_price: String(this.mark),
      realized_pnl: String(this.realizedPnl),
      realized_funding: String(this.realizedFunding),
      commission: '0',
      updated_at: new Date(this.nowFn()).toISOString(),
    };
  }

  private scalperWindowOpen(): boolean {
    const so = this.opts.scalperOffer;
    return so.enabled && this.positionOpenedAt !== null && this.nowFn() - this.positionOpenedAt <= so.windowMs;
  }

  private err(code: string, context: unknown = {}): never {
    throw Object.assign(new Error(code), { code, context });
  }

  private placeOrder(r: any): MockOrder {
    this.placedOrderRequests.push(r);
    const o = this.opts;
    if (Number(r.product_id) !== o.productId && r.product_symbol !== o.symbol) this.err('invalid_contract');
    const size = Number(r.size);
    if (!Number.isInteger(size) || size <= 0) this.err('less_than_order_min_size');
    if (!['buy', 'sell'].includes(r.side)) this.err('invalid_side');
    if (r.client_order_id) {
      if (String(r.client_order_id).length > 32) this.err('client_order_id_too_long');
      const dup = [...this.orders.values()].find((x) => x.client_order_id === r.client_order_id && (x.state === 'open' || x.state === 'pending'));
      if (dup) this.err('duplicate_client_order_id');
    }
    const reduceOnly = r.reduce_only === true || r.reduce_only === 'true';
    const buy = r.side === 'buy';
    if (reduceOnly) {
      if (this.position.size === 0) this.err('no_position_for_reduce_only');
      if ((buy && this.position.size > 0) || (!buy && this.position.size < 0)) this.err('close_order_position_unavailable');
    } else {
      const notional = size * o.contractValue * (buy ? this.ask : this.bid);
      const avail = Number(this.walletJson()[0].available_balance);
      if (notional / this.leverage > avail) this.err('insufficient_margin', { available_balance: String(avail) });
    }
    const now = String(this.ts());
    const order: MockOrder = {
      id: this.nextOrderId++,
      client_order_id: r.client_order_id ?? null,
      product_id: o.productId,
      product_symbol: o.symbol,
      side: r.side,
      size,
      unfilled_size: size,
      order_type: r.order_type,
      limit_price: r.limit_price ?? null,
      stop_price: r.stop_price ?? null,
      stop_order_type: r.stop_order_type ?? null,
      time_in_force: r.time_in_force ?? 'gtc',
      reduce_only: reduceOnly,
      state: 'open',
      average_fill_price: null,
      paid_commission: '0',
      cancellation_reason: null,
      created_at: now,
      updated_at: now,
    };
    this.orders.set(order.id, order);

    if (order.stop_price) {
      order.state = 'pending';
      this.notifyOrder(order);
      return { ...order };
    }
    this.tryMatch(order, true);
    return { ...order };
  }

  private cancelOrder(r: any): MockOrder {
    const order = this.orders.get(Number(r.id));
    if (!order) this.err('order_not_found');
    if (order.state === 'open' || order.state === 'pending') {
      order.state = 'cancelled';
      order.cancellation_reason = 'cancelled_by_user';
      order.updated_at = String(this.ts());
      this.notifyOrder(order);
    }
    return { ...order };
  }

  /** Attempt to match an order against the current top of book. `incoming` => taker. */
  private tryMatch(order: MockOrder, incoming: boolean) {
    const buy = order.side === 'buy';
    const px = buy ? this.ask : this.bid;
    let marketable = order.order_type === 'market_order' || order.stop_price !== null;
    if (order.order_type === 'limit_order' && order.limit_price !== null && !order.stop_price) {
      const lim = Number(order.limit_price);
      marketable = buy ? lim >= this.ask : lim <= this.bid;
    }
    if (marketable) {
      const ratio = incoming ? this.opts.partialFillRatio : 1;
      const qty = Math.max(1, Math.floor(order.unfilled_size * ratio));
      const fillQty = Math.min(order.unfilled_size, order.reduce_only ? Math.min(qty, Math.abs(this.position.size)) : qty);
      if (fillQty > 0) this.fill(order, fillQty, px, 'taker');
    } else if (incoming && order.order_type === 'limit_order' && order.time_in_force !== 'ioc') {
      // rests as open (maker)
      order.state = 'open';
    }
    if (order.unfilled_size === 0) order.state = 'closed';
    else if (order.time_in_force === 'ioc' && incoming) {
      order.state = 'cancelled';
      order.cancellation_reason = 'unfilled_ioc';
    }
    order.updated_at = String(this.ts());
    this.notifyOrder(order);
  }

  private matchResting() {
    for (const o of [...this.orders.values()]) {
      if (o.state !== 'open' && o.state !== 'pending') continue;
      const buy = o.side === 'buy';
      if (o.state === 'pending' && o.stop_price) {
        const sp = Number(o.stop_price);
        const trig = buy ? this.mark >= sp : this.mark <= sp;
        if (trig) {
          o.state = 'open';
          o.stop_price = o.stop_price; // keep for reference
          this.fillAtMarket(o);
        }
      } else if (o.state === 'open' && o.order_type === 'limit_order' && o.limit_price) {
        const lim = Number(o.limit_price);
        const crosses = buy ? this.ask <= lim : this.bid >= lim;
        if (crosses) {
          const qty = o.reduce_only ? Math.min(o.unfilled_size, Math.abs(this.position.size)) : o.unfilled_size;
          if (qty > 0) this.fill(o, qty, lim, 'maker');
          if (o.unfilled_size === 0) o.state = 'closed';
          o.updated_at = String(this.ts());
          this.notifyOrder(o);
        }
      }
    }
  }

  private fillAtMarket(o: MockOrder) {
    const buy = o.side === 'buy';
    const qty = o.reduce_only ? Math.min(o.unfilled_size, Math.abs(this.position.size)) : o.unfilled_size;
    if (qty > 0) this.fill(o, qty, buy ? this.ask : this.bid, 'taker');
    o.state = o.unfilled_size === 0 ? 'closed' : 'cancelled';
    o.updated_at = String(this.ts());
    this.notifyOrder(o);
  }

  private fill(order: MockOrder, qty: number, price: number, role: 'maker' | 'taker') {
    const o = this.opts;
    const buy = order.side === 'buy';
    const rate = role === 'maker' ? o.makerRate : o.takerRate;
    const signed = buy ? qty : -qty;
    const p = this.position;
    // Scalper Offer: only the part of the fill that CLOSES existing exposure can be waived, and only while the
    // position is young enough. The part of a flipping fill that opens the other side is charged normally.
    const closingQty = p.size !== 0 && Math.sign(p.size) !== Math.sign(signed) ? Math.min(Math.abs(p.size), qty) : 0;
    const waiveClose = closingQty > 0 && this.scalperWindowOpen();
    const chargedQty = waiveClose ? qty - closingQty : qty;
    const commission = chargedQty * o.contractValue * price * rate;
    if (waiveClose) this.scalperWaivedUsd += closingQty * o.contractValue * price * rate;
    this.balance -= commission;

    // netting
    const wasFlat = p.size === 0;
    if (p.size === 0 || Math.sign(p.size) === Math.sign(signed)) {
      p.entry = (Math.abs(p.size) * p.entry + qty * price) / (Math.abs(p.size) + qty);
      p.size += signed;
    } else {
      const closing = Math.min(Math.abs(p.size), qty);
      const pnl = (p.size > 0 ? price - p.entry : p.entry - price) * closing * o.contractValue;
      this.balance += pnl;
      this.realizedPnl += pnl;
      p.size += signed;
      if (p.size === 0) p.entry = 0;
      else if (Math.sign(p.size) === Math.sign(signed)) p.entry = price; // flipped
    }
    // a fresh position (from flat, or the new side after a flip) starts the clock; adding to or partially reducing keeps it
    if (p.size === 0) this.positionOpenedAt = null;
    else if (wasFlat || (closingQty > 0 && Math.sign(p.size) === Math.sign(signed))) this.positionOpenedAt = this.nowFn();

    const prevFilled = order.size - order.unfilled_size;
    const prevAvg = order.average_fill_price ? Number(order.average_fill_price) : 0;
    order.unfilled_size -= qty;
    order.average_fill_price = String(((prevAvg * prevFilled + price * qty) / (prevFilled + qty)).toFixed(8));
    order.paid_commission = String((Number(order.paid_commission) + commission).toFixed(8));
    if (order.unfilled_size === 0) order.state = 'closed';

    const fill: MockFill = {
      id: `fill-${this.nextFillId++}`,
      order_id: String(order.id),
      product_id: o.productId,
      product_symbol: o.symbol,
      side: order.side,
      size: qty,
      price: String(price),
      role,
      commission: commission.toFixed(8),
      fill_type: 'normal',
      created_at: new Date(this.nowFn()).toISOString(),
    };
    this.fills.push(fill);
    this.notifyPrivate('user_trades', fill);
    this.notifyPrivate('v2/user_trades', { type: 'v2/user_trades', ...fill });
    this.notifyPrivate('positions', { type: 'positions', action: this.position.size === 0 ? 'delete' : 'update', symbol: o.symbol, product_id: o.productId, size: this.position.size, entry_price: String(this.position.entry) });
    this.notifyPrivate('margins', { type: 'margins', ...this.walletJson()[0] });

    // reduce-only orders cannot outlive the position
    if (this.position.size === 0) {
      for (const x of this.orders.values()) {
        if (x.reduce_only && (x.state === 'open' || x.state === 'pending')) {
          x.state = 'cancelled';
          x.cancellation_reason = 'position_closed';
          this.notifyOrder(x);
        }
      }
    }
  }

  // ---------------- websocket ----------------
  private onWsConnection(ws: WebSocket) {
    const client = { ws, subs: new Map<string, Set<string>>(), authed: false } as {
      ws: WebSocket;
      subs: Map<string, Set<string>>;
      authed: boolean;
      heartbeat?: NodeJS.Timeout;
    };
    this.clients.add(client);
    ws.on('close', () => {
      if (client.heartbeat) clearInterval(client.heartbeat);
      this.clients.delete(client);
    });
    ws.on('message', (data) => {
      let m: any;
      try {
        m = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (m.type === 'enable_heartbeat') {
        client.heartbeat = setInterval(() => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'heartbeat' })), this.opts.heartbeatMs);
      } else if (m.type === 'key-auth') {
        const p = m.payload ?? {};
        const skew = Math.abs(this.nowFn() / 1000 - Number(p.timestamp));
        const expected = generateSignature(this.opts.apiSecret, 'GET' + String(p.timestamp) + '/live');
        if (p['api-key'] !== this.opts.apiKey) ws.send(JSON.stringify({ type: 'key-auth', success: false, status_code: 404, status: 'api_key_not_found', message: 'ApiKey not found' }));
        else if (!(skew <= this.opts.allowedSkewSec)) ws.send(JSON.stringify({ type: 'key-auth', success: false, status_code: 408, status: 'request_expired', message: 'Timestamp header outside of allowed time window' }));
        else if (expected !== p.signature) ws.send(JSON.stringify({ type: 'key-auth', success: false, status_code: 401, status: 'invalid_signature', message: 'Invalid Signature' }));
        else {
          client.authed = true;
          ws.send(JSON.stringify({ type: 'key-auth', success: true, status_code: 200, status: 'authenticated' }));
        }
      } else if (m.type === 'subscribe') {
        for (const ch of m.payload?.channels ?? []) {
          const set = client.subs.get(ch.name) ?? new Set<string>();
          (ch.symbols ?? ['*']).forEach((s: string) => set.add(s));
          client.subs.set(ch.name, set);
        }
        ws.send(JSON.stringify({ type: 'subscriptions', channels: [...client.subs.entries()].map(([name, s]) => ({ name, symbols: [...s] })) }));
      }
    });
  }

  private broadcast(channel: string, symbol: string, msg: unknown) {
    for (const c of this.clients) {
      const s = c.subs.get(channel);
      if (s && (s.has(symbol) || s.has('all') || s.has('*')) && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
    }
  }

  private notifyPrivate(channel: string, msg: unknown) {
    for (const c of this.clients) {
      if (!c.authed) continue;
      const s = c.subs.get(channel);
      if (s && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
    }
  }

  private notifyOrder(o: MockOrder) {
    this.notifyPrivate('orders', { type: 'orders', action: 'update', order: o, symbol: o.product_symbol });
  }
}
