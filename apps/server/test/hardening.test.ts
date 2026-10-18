import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/config';
import { backendUrl } from '../../web/lib/server';
import { arm, closeSharedDb, makeHarness, type Harness } from './harness';

/** Deployer-level lock, proxy target scheme and key-derivation guards found by the review. */

let h: Harness | undefined;
afterEach(async () => {
  await h?.stop();
  h = undefined;
});
afterAll(closeSharedDb);

describe('LIVE_HARD_DISABLE is a real hard lock', () => {
  it('refuses new entries even when the database says live is armed', async () => {
    h = await makeHarness({ env: { LIVE_HARD_DISABLE: 'true' } });
    await arm(h);
    await expect(h.rt.live.assertEntryAllowed()).rejects.toThrow(/LIVE_HARD_DISABLE/);
  });

  it('disarms an already armed Live at startup (and audits it)', async () => {
    h = await makeHarness({ env: { LIVE_HARD_DISABLE: 'true' } });
    await arm(h);
    expect((await h.rt.repos.getBotState(true)).liveArmed).toBe(true);
    h = await h.restart();
    await h.rt.bot.start(); // the startup path (the harness otherwise skips it)
    const st = await h.rt.repos.getBotState(true);
    expect(st.liveArmed).toBe(false);
    expect(st.mode).toBe('demo');
    expect(st.attention.join(' ')).toMatch(/LIVE_HARD_DISABLE/);
    expect((await h.rt.repos.listAudit(10, 'live_disarmed')).length).toBeGreaterThan(0);
  });

  it('does not interfere when the lock is not set', async () => {
    h = await makeHarness();
    await arm(h);
    await expect(h.rt.live.assertEntryAllowed()).resolves.toBeTruthy();
  });
});

describe('dashboard proxy target', () => {
  const withUrl = (url: string | undefined, fn: () => void) => {
    const prev = process.env.BACKEND_URL;
    if (url === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = url;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.BACKEND_URL;
      else process.env.BACKEND_URL = prev;
    }
  };
  it('accepts https and strips a trailing slash', () => {
    withUrl('https://api.example.com/', () => expect(backendUrl()).toBe('https://api.example.com'));
  });
  it('accepts plain http only for localhost / private-network hosts', () => {
    for (const ok of ['http://localhost:8080', 'http://127.0.0.1:8080', 'http://api:8080', 'http://svc.internal:10000']) withUrl(ok, () => expect(backendUrl()).toBe(ok));
  });
  it('rejects plain http to a public host, other schemes, junk and a missing value', () => {
    for (const bad of ['http://api.example.com', 'ftp://api.example.com', 'not a url']) withUrl(bad, () => expect(() => backendUrl()).toThrow());
    withUrl(undefined, () => expect(() => backendUrl()).toThrow(/BACKEND_URL/));
  });
});

describe('credential key derivation guard', () => {
  const prod = (key: string) => ({
    NODE_ENV: 'production',
    SESSION_SECRET: randomBytes(24).toString('hex'),
    ADMIN_PASSWORD: 'a-long-enough-password',
    CREDENTIAL_ENCRYPTION_KEY: key,
  });
  it('rejects trivially repetitive secrets on the derivation path, accepts random ones', () => {
    expect(() => loadConfig(prod('a'.repeat(40)))).toThrow(/repetitive/);
    expect(() => loadConfig(prod('ab'.repeat(20)))).toThrow(/repetitive/);
    expect(loadConfig(prod(randomBytes(32).toString('hex'))).encryptionKey).not.toBeNull();
    expect(loadConfig(prod(randomBytes(32).toString('base64'))).encryptionKey).not.toBeNull();
  });
});
