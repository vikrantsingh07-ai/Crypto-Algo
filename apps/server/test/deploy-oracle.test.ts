import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config';

/**
 * deploy/oracle/setup.sh in DRY_RUN mode: validation, .env generation and idempotency, without installing anything.
 * (The real boot of a VM was not exercised here; see docs/ORACLE_CLOUD_HINGLISH.md.)
 */

const REPO = path.resolve(__dirname, '../../..');
const GOOD = { ADMIN_PASSWORD: 'goodpassword123', PROXY_SHARED_SECRET: 'Abcdefghijklmnopqrstuvwxyz0123456789-_' };

function appDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'cryptoalgo-oracle-'));
  cpSync(path.join(REPO, 'deploy/oracle'), path.join(dir, 'deploy/oracle'), { recursive: true });
  rmSync(path.join(dir, 'deploy/oracle/.env'), { force: true });
  return dir;
}
const run = (dir: string, env: Record<string, string>) =>
  spawnSync('bash', [path.join(REPO, 'deploy/oracle/setup.sh')], {
    env: { PATH: process.env.PATH!, APP_DIR: dir, DRY_RUN: '1', PUBLIC_IP_OVERRIDE: '129.146.10.20', ...env },
    encoding: 'utf8',
  });
const readEnv = (dir: string) =>
  Object.fromEntries(
    readFileSync(path.join(dir, 'deploy/oracle/.env'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );

describe('deploy/oracle/setup.sh (dry run)', () => {
  it('the scripts are valid bash', () => {
    for (const f of ['setup.sh', 'user-data.sh']) expect(spawnSync('bash', ['-n', path.join(REPO, 'deploy/oracle', f)]).status).toBe(0);
  });

  it('refuses placeholders, short and unsafe secrets with a clear message that never echoes the value', () => {
    const dir = appDir();
    const cases: [Record<string, string>, RegExp][] = [
      [{ ADMIN_PASSWORD: 'CHANGE_ME_at_least_12_chars', PROXY_SHARED_SECRET: GOOD.PROXY_SHARED_SECRET }, /ADMIN_PASSWORD still contains CHANGE_ME/],
      [{ ADMIN_PASSWORD: 'short', PROXY_SHARED_SECRET: GOOD.PROXY_SHARED_SECRET }, /ADMIN_PASSWORD must be at least 12/],
      [{ ADMIN_PASSWORD: GOOD.ADMIN_PASSWORD, PROXY_SHARED_SECRET: 'tooShortSecret' }, /PROXY_SHARED_SECRET must be at least 32/],
      [{ ADMIN_PASSWORD: GOOD.ADMIN_PASSWORD, PROXY_SHARED_SECRET: 'has a space but is long enough to pass the length check' }, /may only contain/],
      [{ ADMIN_PASSWORD: 'pass"word$with#bad12', PROXY_SHARED_SECRET: GOOD.PROXY_SHARED_SECRET }, /may only contain/],
    ];
    for (const [env, msg] of cases) {
      const r = run(dir, env);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(msg);
      for (const v of Object.values(env)) if (v.length > 8) expect(r.stdout + r.stderr).not.toContain(v);
    }
    expect(existsSync(path.join(dir, 'deploy/oracle/.env'))).toBe(false); // nothing written for bad input
  });

  it('writes a private .env that the real server config accepts in production, and Live stays unarmed', () => {
    const dir = appDir();
    const r = run(dir, GOOD);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(GOOD.ADMIN_PASSWORD);
    expect(r.stdout + r.stderr).not.toContain(GOOD.PROXY_SHARED_SECRET);
    const envFile = path.join(dir, 'deploy/oracle/.env');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const e = readEnv(dir);
    expect(e.API_HOST).toBe('129-146-10-20.sslip.io');
    expect(e.LIVE_HARD_DISABLE).toBe('false');
    expect(e.MARKET_DATA_SOURCE).toBe('delta');
    expect(e.DELTA_API_KEY).toBeUndefined(); // no exchange credentials on the box: Demo only until the operator adds them
    expect(e.POSTGRES_PASSWORD).toMatch(/^[0-9a-f]{48}$/); // URL-safe: it is embedded in DATABASE_URL

    // exactly what compose hands to the container
    const cfg = loadConfig({ ...e, DATABASE_URL: `postgres://cryptoalgo:${e.POSTGRES_PASSWORD}@db:5432/cryptoalgo`, DATABASE_SSL: 'disable', PORT: '8080' });
    expect(cfg.isProd).toBe(true);
    expect(cfg.encryptionKey).toHaveLength(32);
    expect(cfg.warnings.join(' ')).not.toMatch(/PROXY_SHARED_SECRET not set|embedded PGlite/);
    expect(cfg.ADMIN_USERNAME).toBe('admin');
    expect(cfg.LIVE_HARD_DISABLE).toBe(false);
    expect(readFileSync(path.join(dir, 'STATUS.txt'), 'utf8')).toContain('https://129-146-10-20.sslip.io');
    expect(readFileSync(path.join(dir, 'STATUS.txt'), 'utf8')).not.toContain(GOOD.ADMIN_PASSWORD);
  });

  it('is idempotent: generated secrets never change (they protect the database and stored credentials), operator values can', () => {
    const dir = appDir();
    run(dir, GOOD);
    const first = readEnv(dir);
    const second = run(dir, { ADMIN_PASSWORD: 'anotherpassword456', PROXY_SHARED_SECRET: GOOD.PROXY_SHARED_SECRET });
    expect(second.status).toBe(0);
    const e = readEnv(dir);
    for (const k of ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY']) expect(e[k]).toBe(first[k]);
    expect(e.ADMIN_PASSWORD).toBe('anotherpassword456');
    expect(Object.keys(e).filter((k) => k === 'ADMIN_PASSWORD')).toHaveLength(1);
  });

  it('honours an own domain via API_HOST and the compose file wires the server only behind Caddy', () => {
    const dir = appDir();
    run(dir, { ...GOOD, API_HOST: 'bot.example.com' });
    expect(readEnv(dir).API_HOST).toBe('bot.example.com');
    const compose = readFileSync(path.join(REPO, 'deploy/oracle/docker-compose.yml'), 'utf8');
    expect(compose).toMatch(/expose:\s*\n\s*- '8080'/); // not published on the host
    expect(compose).not.toMatch(/- '(127\.0\.0\.1:)?8080:8080'/);
    expect(compose).toContain("- '443:443'");
    expect(readFileSync(path.join(REPO, 'deploy/oracle/Caddyfile'), 'utf8')).toContain('reverse_proxy server:8080');
  });
});
