import bcrypt from 'bcryptjs';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApi } from '../src/api';
import { closeSharedDb, makeHarness, type Harness } from './harness';

let h: Harness;
let app: Awaited<ReturnType<typeof buildApi>>;
let admin = '';
let viewer = '';
let extraHeaders: Record<string, string> = {};
let ipCounter = 0;
const PW = 'correct horse battery';
const VPW = 'viewer passphrase 123';
const PHRASE = 'ENABLE TESTNET TRADING'; // the mock endpoints are non-real-money

async function boot(env: Record<string, string> = {}, opts: { withCredentials?: boolean } = {}) {
  extraHeaders = env.PROXY_SHARED_SECRET ? { 'x-proxy-secret': env.PROXY_SHARED_SECRET } : {};
  h = await makeHarness({ env: { VIEWER_PASSWORD_HASH: bcrypt.hashSync(VPW, 4), ...env }, ...opts });
  await h.rt.bot.init();
  app = await buildApi(h.rt);
  await app.ready();
  h.rt.bot.workerActive = true; // the harness does not start timers/feeds; allow commands
  admin = await login('admin', PW);
  viewer = await login('viewer', VPW);
  h.feed.push(2999.95, 3000.05);
}
async function login(username: string, password: string) {
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password }, headers: extraHeaders, remoteAddress: nextIp() });
  return r.statusCode === 200 ? (r.json() as any).token : '';
}
// every call comes from a different client IP so per-IP rate limits (tested separately) do not interfere
const nextIp = () => `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${(ipCounter++ & 255) || 1}`;
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, token?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload: payload as any, remoteAddress: nextIp(), headers: { ...extraHeaders, ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

afterEach(async () => {
  await app?.close();
  await h?.stop();
});
afterAll(closeSharedDb);

describe('authentication & roles', () => {
  beforeEach(() => boot());

  it('health is public; everything else requires a valid session', async () => {
    expect((await call('GET', '/api/health')).statusCode).toBe(200);
    for (const url of ['/api/state', '/api/settings', '/api/trades?mode=demo', '/api/analytics?mode=demo', '/api/credentials', '/api/backtests']) {
      expect((await call('GET', url)).statusCode, url).toBe(401);
    }
    expect((await call('GET', '/api/state', 'garbage.token.here')).statusCode).toBe(401);
  });

  it('rejects wrong passwords and locks out after 5 failures', async () => {
    const ip = '203.0.113.9';
    const bad = () => app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'nope' }, remoteAddress: ip });
    for (let i = 0; i < 5; i++) expect((await bad()).statusCode).toBe(401);
    expect((await bad()).statusCode).toBe(423);
    // even the right password is refused while locked
    const good = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: PW }, remoteAddress: ip });
    expect(good.statusCode).toBe(423);
    const audit = await h.rt.repos.listAudit(50, 'login_failed');
    expect(audit.length).toBeGreaterThanOrEqual(5);
  });

  it('rate limits the login endpoint per IP', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'x', password: 'y' }, remoteAddress: '198.51.100.7' })).statusCode);
    expect(codes).toContain(429);
  });

  it('viewer can read but cannot change anything; forbidden attempts are audited', async () => {
    expect((await call('GET', '/api/state', viewer)).statusCode).toBe(200);
    const attempts: [string, string, unknown?][] = [
      ['POST', '/api/mode', { mode: 'demo' }],
      ['POST', '/api/kill-switch', { engage: true }],
      ['POST', '/api/bot/stop'],
      ['PUT', '/api/settings', { position: { leverage: 20 } }],
      ['POST', '/api/live/preflight'],
      ['POST', '/api/live/activate', { token: 'x'.repeat(20), phrase: PHRASE, acknowledged: true, password: VPW }],
      ['PUT', '/api/credentials', { apiKey: 'abcdefgh', apiSecret: 'abcdefgh', password: VPW }],
      ['POST', '/api/demo/reset', {}],
      ['GET', '/api/audit'],
    ];
    for (const [m, u, p] of attempts) expect((await call(m as any, u, viewer, p)).statusCode, `${m} ${u}`).toBe(403);
    expect((await h.rt.repos.listAudit(50, 'forbidden')).length).toBe(attempts.length);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
  });

  it('never leaks secrets in any readable response', async () => {
    const urls = ['/api/state', '/api/settings', '/api/credentials', '/api/trades?mode=live', '/api/analytics?mode=demo', '/api/backtests'];
    for (const u of urls) {
      const body = (await call('GET', u, admin)).body;
      expect(body).not.toContain('test-secret');
      expect(body).not.toContain(PW);
    }
    expect((await call('GET', '/api/audit', admin)).body).not.toContain('test-secret');
    expect(h.logs.join('\n')).not.toContain('test-secret');
    const cred = (await call('GET', '/api/credentials', admin)).json() as any;
    expect(cred).toMatchObject({ configured: true, source: 'environment' });
    expect(cred.keyHint).toMatch(/••••/);
    expect(Object.keys(cred)).not.toContain('apiSecret');
  });
});

describe('request parsing', () => {
  beforeEach(() => boot());
  it('accepts action endpoints called with a JSON content-type and no body (what the browser sends)', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/live/preflight', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, remoteAddress: nextIp() });
    expect(r.statusCode, r.body).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/bot/stop', headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' }, payload: '{not json', remoteAddress: nextIp() });
    expect(bad.statusCode).toBe(400);
  });
});

describe('fresh install defaults & mode selector', () => {
  beforeEach(() => boot());

  it('starts in DEMO with live disarmed and an initial demo balance', async () => {
    const s = (await call('GET', '/api/state', viewer)).json() as any;
    expect(s.mode).toBe('demo');
    expect(s.liveArmed).toBe(false);
    expect(s.killSwitch).toBe(false);
    expect(s.demo.startingBalanceUsd).toBe(100);
    expect(s.deployment.liveHardDisabled).toBe(false);
    expect(s.settings.position).toMatchObject({ quantityEth: 0.2, leverage: 50 });
    expect(s.live.risk.tradingAllowed).toBe(false); // live is blocked until armed
  });

  it('selecting LIVE through the mode endpoint never arms execution', async () => {
    const r = await call('POST', '/api/mode', admin, { mode: 'live' });
    expect(r.statusCode).toBe(409);
    expect((r.json() as any).error).toBe('use_activation_workflow');
    const st = await h.rt.repos.getBotState(true);
    expect(st.mode).toBe('demo');
    expect(st.liveArmed).toBe(false);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
  });
});

describe('live activation workflow', () => {
  beforeEach(() => boot());

  const preflight = async () => (await call('POST', '/api/live/preflight', admin)).json() as any;
  const activate = (body: Record<string, unknown>, token = admin) => call('POST', '/api/live/activate', token, body);
  const expectStillDemo = async () => {
    const st = await h.rt.repos.getBotState(true);
    expect(st.mode).toBe('demo');
    expect(st.liveArmed).toBe(false);
    expect(h.ex.placedOrderRequests).toHaveLength(0);
  };

  it('preflight passes against a healthy exchange and returns a review summary', async () => {
    const p = await preflight();
    expect(p.checks.filter((c: any) => c.blocker && !c.ok), JSON.stringify(p.checks.filter((c: any) => !c.ok))).toEqual([]);
    expect(p.ok).toBe(true);
    expect(p.token).toBeTruthy();
    expect(p.requiredPhrase).toBe(PHRASE);
    expect(p.summary).toMatchObject({ contracts: 20, quantityEth: 0.2, leverage: 50, symbol: 'ETHUSD', realMoney: false });
    expect(p.summary.breakevenMoveUsd).toBeGreaterThan(2);
    expect(p.checks.map((c: any) => c.id)).toEqual(expect.arrayContaining(['credentials', 'exchange_reachable', 'contract_status', 'quantity', 'leverage', 'auth', 'trading_permission', 'balance', 'exchange_state', 'market_data_fresh', 'clock', 'risk_limits']));
    await expectStillDemo(); // preflight alone changes nothing
  });

  it('the trading-permission probe re-sends the CURRENT leverage and places no order', async () => {
    await preflight();
    expect(h.ex.placedOrderRequests).toHaveLength(0);
    expect(h.ex.requestLog.some((r) => r.method === 'POST' && /orders\/leverage/.test(r.path))).toBe(true);
    expect(h.ex.leverage).toBe(10); // unchanged (mock default)
  });

  it('activation is refused for: no token, wrong phrase, no acknowledgement, wrong password, forged/expired token, viewer', async () => {
    const p = await preflight();
    const good = { token: p.token, phrase: PHRASE, acknowledged: true, password: PW };

    expect((await activate({ ...good, token: 'x'.repeat(40) })).statusCode).toBe(400);
    expect((await activate({ ...good, phrase: 'enable live trading' })).statusCode).toBe(400);
    expect((await activate({ ...good, acknowledged: false })).statusCode).toBe(400);
    expect((await activate({ ...good, password: 'wrong' })).statusCode).toBe(403);
    expect((await activate({ ...good, token: p.token.slice(0, -4) + 'abcd' })).statusCode).toBe(400);
    expect((await activate(good, viewer)).statusCode).toBe(403);
    expect((await activate(good, '')).statusCode).toBe(401);
    expect((await activate({ phrase: PHRASE })).statusCode).toBe(400); // schema
    await expectStillDemo();

    const fails = await h.rt.repos.listAudit(50, 'live_activation_failed');
    expect(fails.length).toBeGreaterThanOrEqual(4);
    expect((await h.rt.repos.listAudit(10, 'live_activated')).length).toBe(0);
  });

  it('the review token expires after 5 minutes', async () => {
    const p = await preflight();
    h.clock.t += 6 * 60_000;
    h.feed.push(2999.95, 3000.05); // keep market data fresh so only the token age is under test
    const r = await activate({ token: p.token, phrase: PHRASE, acknowledged: true, password: PW });
    expect(r.statusCode).toBe(400);
    expect((r.json() as any).message).toMatch(/expired|changed/);
    await expectStillDemo();
  });

  it('settings changed after review invalidate the token (must re-review)', async () => {
    const p = await preflight();
    await call('PUT', '/api/settings', admin, { position: { leverage: 20 } });
    const r = await activate({ token: p.token, phrase: PHRASE, acknowledged: true, password: PW });
    expect(r.statusCode).toBe(400);
    expect((r.json() as any).message).toMatch(/changed since review/);
    await expectStillDemo();
  });

  it('successful activation arms live, is audited, and needs NO reconnect or re-entered settings', async () => {
    const credsBefore = JSON.stringify(h.rt.creds.status());
    const settingsBefore = JSON.stringify(h.rt.getSettings());
    const p = await preflight();
    const r = await activate({ token: p.token, phrase: PHRASE, acknowledged: true, password: PW });
    expect(r.statusCode, r.body).toBe(200);
    const st = await h.rt.repos.getBotState(true);
    expect(st).toMatchObject({ mode: 'live', liveArmed: true, running: true, liveArmedBy: 'admin' });
    const audit = await h.rt.repos.listAudit(10, 'live_activated');
    expect(audit).toHaveLength(1);
    expect(audit[0].details.summary.leverage).toBe(50);
    expect(JSON.stringify(h.rt.creds.status())).toBe(credsBefore); // same connection
    expect(JSON.stringify(h.rt.getSettings())).toBe(settingsBefore); // same configuration
    // still no order until a strategy signal passes the risk manager
    expect(h.ex.placedOrderRequests).toHaveLength(0);
  });

  it('switching Live -> Demo is one call, stops live entries and is audited', async () => {
    const p = await preflight();
    await activate({ token: p.token, phrase: PHRASE, acknowledged: true, password: PW });
    const r = await call('POST', '/api/mode', admin, { mode: 'demo' });
    expect(r.statusCode).toBe(200);
    expect((await h.rt.repos.getBotState(true))).toMatchObject({ mode: 'demo', liveArmed: false });
    expect((await h.rt.repos.listAudit(5, 'mode_switched_to_demo')).length).toBe(1);
  });

  it('stays disabled — and says why — when a safety check fails', async () => {
    // untracked position on the exchange
    await h.rt.client.placeOrder({ product_id: 3136, side: 'buy', size: 3, order_type: 'market_order', client_order_id: 'manual-x' });
    const p = await preflight();
    expect(p.ok).toBe(false);
    expect(p.token).toBeNull();
    const failed = p.checks.filter((c: any) => c.blocker && !c.ok).map((c: any) => c.id);
    expect(failed).toContain('exchange_state');
    const r = await activate({ token: 'x'.repeat(30), phrase: PHRASE, acknowledged: true, password: PW });
    expect([400, 412]).toContain(r.statusCode);
    await expectStillDemo().catch(() => {}); // an order WAS placed by the test itself above
    const st = await h.rt.repos.getBotState(true);
    expect(st.liveArmed).toBe(false);
  });

  it('insufficient balance blocks activation', async () => {
    h.ex.balance = 2;
    const p = await preflight();
    expect(p.checks.find((c: any) => c.id === 'balance').ok).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('an unavailable or non-operational contract blocks activation', async () => {
    h.ex.opts.tradingStatus = 'disrupted_cancel_only';
    const p = await preflight();
    expect(p.checks.find((c: any) => c.id === 'contract_status').ok).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('a rejected API key blocks activation with an explanatory message', async () => {
    h.ex.opts.apiKey = 'rotated-on-exchange';
    const p = await preflight();
    const auth = p.checks.find((c: any) => c.id === 'auth');
    expect(auth.ok).toBe(false);
    expect(auth.detail).toMatch(/invalid|environment|key/i);
    expect(p.ok).toBe(false);
  });

  it('kill switch must be released before activation', async () => {
    await call('POST', '/api/kill-switch', admin, { engage: true });
    const p = await preflight();
    expect(p.checks.find((c: any) => c.id === 'kill_switch').ok).toBe(false);
    expect(p.ok).toBe(false);
    await call('POST', '/api/kill-switch', admin, { engage: false });
    const p2 = await preflight();
    expect(p2.ok).toBe(true);
  });

  it('synthetic market data can never be used to activate live', async () => {
    (h.feed as any).synthetic = true;
    const p = await preflight();
    expect(p.checks.find((c: any) => c.id === 'market_data_real').ok).toBe(false);
    expect(p.ok).toBe(false);
  });

  it('stale market data blocks activation', async () => {
    h.clock.t += 120_000;
    const p = await preflight();
    expect(p.checks.find((c: any) => c.id === 'market_data_fresh').ok).toBe(false);
  });
});

describe('deployment hard lock', () => {
  it('LIVE_HARD_DISABLE=true makes activation impossible regardless of the dashboard', async () => {
    await boot({ LIVE_HARD_DISABLE: 'true' });
    const p = (await call('POST', '/api/live/preflight', admin)).json() as any;
    expect(p.ok).toBe(false);
    expect(p.checks.find((c: any) => c.id === 'hard_disable').ok).toBe(false);
    expect(p.token).toBeNull();
  });
});

describe('credentials & settings endpoints', () => {
  it('stores credentials ENCRYPTED, shows only a fingerprint, and disarms live when they change', async () => {
    await boot({ DELTA_API_KEY: '', DELTA_API_SECRET: '' }, { withCredentials: false });
    expect((await call('GET', '/api/credentials', admin)).json()).toMatchObject({ configured: false });
    const bad = await call('PUT', '/api/credentials', admin, { apiKey: 'test-key', apiSecret: 'test-secret', password: 'wrong' });
    expect(bad.statusCode).toBe(403);

    const ok = await call('PUT', '/api/credentials', admin, { apiKey: 'test-key', apiSecret: 'test-secret', password: PW });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ configured: true, source: 'database' });
    expect(ok.body).not.toContain('test-secret');

    const row = await h.rt.repos.getCredentialRow('custom');
    expect(row!.apiSecretEnc).not.toContain('test-secret');
    expect(row!.apiKeyEnc).not.toContain('test-key');
    expect(row!.apiSecretEnc.startsWith('v1.')).toBe(true);

    // a fresh runtime over the same database picks the credentials up with nothing re-entered
    const t = await call('POST', '/api/credentials/test', admin);
    expect((t.json() as any).ok, t.body).toBe(true);

    await h.rt.bot.save({ ...(await h.rt.repos.getBotState(true)), mode: 'live', liveArmed: true });
    await call('PUT', '/api/credentials', admin, { apiKey: 'another-key', apiSecret: 'another-secret', password: PW });
    expect(await h.rt.repos.getBotState(true)).toMatchObject({ mode: 'demo', liveArmed: false });
    expect((await h.rt.repos.listAudit(10, 'credentials_updated')).length).toBe(2);
  });

  it('refuses to override credentials provided by the environment', async () => {
    await boot();
    const r = await call('PUT', '/api/credentials', admin, { apiKey: 'abcdefgh1', apiSecret: 'abcdefgh2', password: PW });
    expect(r.statusCode).toBe(400);
  });

  it('validates settings against exchange rules and risk limits and audits changes', async () => {
    await boot();
    const tooMuch = await call('PUT', '/api/settings', admin, { position: { leverage: 150 } });
    expect(tooMuch.statusCode).toBe(422);
    expect((tooMuch.json() as any).issues.some((i: any) => i.path === 'position.leverage')).toBe(true);
    const odd = await call('PUT', '/api/settings', admin, { position: { quantityEth: 0.205 } });
    expect(odd.statusCode).toBe(422);
    const tenPlus = await call('PUT', '/api/settings', admin, { limits: { maxTradesPer24h: 11 } });
    expect(tenPlus.statusCode).toBe(422);
    const ok = await call('PUT', '/api/settings', admin, { targets: { stopLossMaxUsd: 5 }, limits: { dailyLossLimitUsd: 8 } });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as any).changed).toEqual(expect.arrayContaining(['targets.stopLossMaxUsd', 'limits.dailyLossLimitUsd']));
    expect((await h.rt.repos.listAudit(5, 'settings_changed')).filter((e) => e.actor === 'admin')).toHaveLength(1);
    // persisted
    expect((await h.rt.repos.loadSettings()).targets.stopLossMaxUsd).toBe(5);
  });

  it('kill switch API: engage then release', async () => {
    await boot();
    const e = await call('POST', '/api/kill-switch', admin, { engage: true, reason: 'test' });
    expect(e.statusCode).toBe(200);
    expect((await h.rt.repos.getBotState(true)).killSwitch).toBe(true);
    const r = await call('POST', '/api/kill-switch', admin, { engage: false });
    expect((r.json() as any).engaged).toBe(false);
    const a = (await call('GET', '/api/audit', admin)).json() as any;
    expect(a.entries.map((x: any) => x.action)).toEqual(expect.arrayContaining(['kill_switch_engaged', 'kill_switch_released']));
  });
});

describe('proxy shared secret', () => {
  it('requires the shared secret on every route except /api/health', async () => {
    await boot({ PROXY_SHARED_SECRET: 'proxy-secret-proxy-secret' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const raw = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${admin}`, ...headers }, remoteAddress: nextIp() });
    expect((await raw({})).statusCode).toBe(403);
    expect((await raw({ 'x-proxy-secret': 'wrong' })).statusCode).toBe(403);
    expect((await raw({ 'x-proxy-secret': 'proxy-secret-proxy-secret' })).statusCode).toBe(200);
  });
});
