import { hkdfSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth';
import { loadConfig } from '../src/config';
import { decrypt, encrypt, parseEncryptionKey } from '../src/crypto';
import type { Repos } from '../src/repos';

// Throwaway values only. They are distinctive so a leak into a warning or error message is detectable.
const SESSION = 'S3SS10N-sentinel-' + 'x'.repeat(32);
const PROXY = 'PR0XY-sentinel-' + 'y'.repeat(24);
const PW12 = 'Sentinel-pw-12!';
const HEX64 = randomBytes(32).toString('hex');
const ADMIN_HASH = bcrypt.hashSync('hash-route-password', 4);
const VIEWER_HASH = bcrypt.hashSync('viewer-password', 4);

const prod = (over: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  SESSION_SECRET: SESSION,
  ADMIN_PASSWORD_HASH: ADMIN_HASH,
  PROXY_SHARED_SECRET: PROXY,
  DATABASE_URL: 'postgresql://user:pw@db.example.invalid:5432/app?sslmode=require',
  ...over,
});

const throwsMessage = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected loadConfig to throw');
};

const fakeRepos = { audit: async () => {} } as unknown as Repos;

describe('CREDENTIAL_ENCRYPTION_KEY', () => {
  it('still accepts base64 of exactly 32 bytes and uses the decoded bytes unchanged', () => {
    const raw = randomBytes(32);
    const std = raw.toString('base64'); // 44 chars with "="
    expect(std).toHaveLength(44);
    for (const form of [std, std.replace(/=+$/, ''), std.replace(/\+/g, '-').replace(/\//g, '_'), `  ${std}\n`]) {
      expect(loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: form })).encryptionKey?.equals(raw)).toBe(true);
    }
  });

  it('derives a 32-byte key with HKDF-SHA256 from a 64-character hex secret', () => {
    const cfg = loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: HEX64 }));
    const expected = Buffer.from(hkdfSync('sha256', Buffer.from(HEX64, 'utf8'), Buffer.alloc(0), 'cryptoalgo/credential-encryption-key/v1', 32));
    expect(cfg.encryptionKey).toHaveLength(32);
    expect(cfg.encryptionKey!.equals(expected)).toBe(true);
    // not the lenient base64 decoding of the hex text, and deterministic across restarts
    expect(cfg.encryptionKey!.equals(Buffer.from(HEX64, 'base64').subarray(0, 32))).toBe(false);
    expect(loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: HEX64 })).encryptionKey!.equals(expected)).toBe(true);
  });

  it('derives from any other secret of at least 32 characters, and different secrets give different keys', () => {
    const a = parseEncryptionKey('correct horse battery staple, 4 words!');
    const b = parseEncryptionKey('correct horse battery staple, 5 words!');
    const edge = parseEncryptionKey('z'.repeat(32));
    expect([a.length, b.length, edge.length]).toEqual([32, 32, 32]);
    expect(a.equals(b)).toBe(false);
  });

  it('round-trips credentials with a derived key', () => {
    const key = loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: HEX64 })).encryptionKey!;
    expect(decrypt(encrypt('api-secret-value', key, 'row-1'), key, 'row-1')).toBe('api-secret-value');
  });

  it('rejects secrets shorter than 32 characters with a clear message that does not echo the value', () => {
    const short = 'SHORT-sentinel-secret-31-chars!'; // 31
    expect(short).toHaveLength(31);
    const msg = throwsMessage(() => loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: short })));
    expect(msg).toContain('CREDENTIAL_ENCRYPTION_KEY');
    expect(msg).toMatch(/at least 32 characters/);
    expect(msg).not.toContain(short);
  });

  it('treats an empty value as unset: production warns that dashboard-stored credentials are disabled', () => {
    const cfg = loadConfig(prod({ CREDENTIAL_ENCRYPTION_KEY: '' }));
    expect(cfg.encryptionKey).toBeNull();
    expect(cfg.warnings.join('\n')).toMatch(/CREDENTIAL_ENCRYPTION_KEY not set/);
  });
});

describe('ADMIN_PASSWORD in production', () => {
  it('is accepted at 12 characters or more, with a warning that recommends ADMIN_PASSWORD_HASH', () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PW12 }));
    expect(cfg.isProd).toBe(true);
    expect(cfg.ADMIN_PASSWORD).toBe(PW12);
    expect(cfg.warnings.some((w) => w.includes('ADMIN_PASSWORD') && w.includes('ADMIN_PASSWORD_HASH') && /hashed/.test(w))).toBe(true);
  });

  it('is rejected below 12 characters and the message does not echo it', () => {
    const eleven = 'abcdefghijk';
    expect(eleven).toHaveLength(11);
    const msg = throwsMessage(() => loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: eleven })));
    expect(msg).toMatch(/ADMIN_PASSWORD must be at least 12 characters/);
    expect(msg).not.toContain(eleven);
  });

  it('is ignored when ADMIN_PASSWORD_HASH is also set (the hash wins) and a warning says so', () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD: PW12 }));
    expect(cfg.warnings.some((w) => /ADMIN_PASSWORD is ignored because ADMIN_PASSWORD_HASH is set/.test(w))).toBe(true);
  });

  it('still requires one of the two: nothing set is an error, and an empty string counts as not set', () => {
    expect(throwsMessage(() => loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined })))).toMatch(/ADMIN_PASSWORD_HASH must be set in production/);
    expect(throwsMessage(() => loadConfig(prod({ ADMIN_PASSWORD_HASH: '', ADMIN_PASSWORD: '' })))).toMatch(/ADMIN_PASSWORD_HASH must be set in production/);
  });

  it('rejects an ADMIN_PASSWORD_HASH that is not a bcrypt hash (a pasted plain password) without echoing it', () => {
    const msg = throwsMessage(() => loadConfig(prod({ ADMIN_PASSWORD_HASH: PW12 })));
    expect(msg).toMatch(/does not look like a bcrypt hash/);
    expect(msg).not.toContain(PW12);
    expect(throwsMessage(() => loadConfig(prod({ VIEWER_PASSWORD_HASH: PW12 })))).toMatch(/VIEWER_PASSWORD_HASH does not look like a bcrypt hash/);
    expect(loadConfig(prod({ VIEWER_PASSWORD_HASH: VIEWER_HASH })).VIEWER_PASSWORD_HASH).toBe(VIEWER_HASH);
  });

  it('warns about leading or trailing spaces without printing the password', () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: `${PW12} ` }));
    expect(cfg.warnings.some((w) => /starts or ends with a space/.test(w))).toBe(true);
    expect(JSON.stringify(cfg.warnings)).not.toContain(PW12);
  });

  it('keeps the development behaviour: plain ADMIN_PASSWORD of any length is fine outside production', () => {
    const cfg = loadConfig({ NODE_ENV: 'development', ADMIN_PASSWORD: 'short' });
    expect(cfg.isProd).toBe(false);
  });
});

describe('AuthService with a plain ADMIN_PASSWORD in production', () => {
  it('hashes it at startup and logs in with it; wrong passwords are refused', async () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PW12 }));
    const auth = new AuthService(cfg, fakeRepos);
    const ok = await auth.login('admin', PW12, '10.0.0.1');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.role).toBe('admin');
      expect((await auth.verify(ok.token))?.username).toBe('admin');
    }
    expect((await auth.login('admin', PW12 + 'x', '10.0.0.1')).ok).toBe(false);
    expect(auth.generatedAdminPassword).toBeNull();
  });

  it('prefers ADMIN_PASSWORD_HASH when both are set', async () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD: PW12 }));
    const auth = new AuthService(cfg, fakeRepos);
    expect((await auth.login('admin', 'hash-route-password', '10.0.0.2')).ok).toBe(true);
    expect((await auth.login('admin', PW12, '10.0.0.2')).ok).toBe(false);
  });

  it('refuses to build a login from a short production password even if config validation was bypassed', () => {
    const cfg = { ...loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PW12 })), ADMIN_PASSWORD: 'short' };
    expect(() => new AuthService(cfg, fakeRepos)).toThrow(/at least 12 characters/);
  });

  it('keeps the login lockouts: five failures lock the (ip, user) pair even with a correct password afterwards', async () => {
    const cfg = loadConfig(prod({ ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PW12 }));
    const auth = new AuthService(cfg, fakeRepos);
    for (let i = 0; i < 5; i++) expect((await auth.login('admin', 'wrong-' + i, '10.0.0.3')).ok).toBe(false);
    const locked = await auth.login('admin', PW12, '10.0.0.3');
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.status).toBe(423);
  });
});

describe('production guards that must not change', () => {
  it('requires SESSION_SECRET of at least 32 characters', () => {
    expect(throwsMessage(() => loadConfig(prod({ SESSION_SECRET: 'x'.repeat(31) })))).toMatch(/SESSION_SECRET must be set/);
    expect(throwsMessage(() => loadConfig(prod({ SESSION_SECRET: '' })))).toMatch(/SESSION_SECRET must be set/);
    expect(throwsMessage(() => loadConfig(prod({ SESSION_SECRET: undefined })))).toMatch(/SESSION_SECRET must be set/);
  });

  it('refuses synthetic market data', () => {
    expect(throwsMessage(() => loadConfig(prod({ MARKET_DATA_SOURCE: 'synthetic' })))).toMatch(/synthetic/);
    expect(loadConfig(prod({ MARKET_DATA_SOURCE: 'delta' })).MARKET_DATA_SOURCE).toBe('delta');
  });

  it('requires DELTA_REST_URL for DELTA_ENV=custom', () => {
    expect(throwsMessage(() => loadConfig(prod({ DELTA_ENV: 'custom' })))).toMatch(/DELTA_REST_URL/);
  });

  it('warns when PROXY_SHARED_SECRET is missing (empty means missing) and when DATABASE_URL is missing', () => {
    const w = loadConfig(prod({ PROXY_SHARED_SECRET: '', DATABASE_URL: '' })).warnings.join('\n');
    expect(w).toMatch(/PROXY_SHARED_SECRET not set/);
    expect(w).toMatch(/DATABASE_URL not set: using embedded PGlite storage/);
  });

  it('does not warn about the proxy secret or the database when both are configured', () => {
    expect(loadConfig(prod()).warnings.join('\n')).not.toMatch(/PROXY_SHARED_SECRET|DATABASE_URL/);
  });

  it('keeps Live deployment lock and defaults: LIVE_HARD_DISABLE is false unless set, DELTA_ENV defaults to production', () => {
    const cfg = loadConfig(prod());
    expect(cfg.LIVE_HARD_DISABLE).toBe(false);
    expect(cfg.DELTA_ENV).toBe('production');
    expect(loadConfig(prod({ LIVE_HARD_DISABLE: 'true' })).LIVE_HARD_DISABLE).toBe(true);
    expect(loadConfig(prod({ LIVE_HARD_DISABLE: '' })).LIVE_HARD_DISABLE).toBe(false);
  });
});

describe('PROXY_SHARED_SECRET', () => {
  it('is trimmed so a pasted trailing space or newline cannot make the proxy and the API disagree', () => {
    expect(loadConfig(prod({ PROXY_SHARED_SECRET: `  ${PROXY}\n` })).PROXY_SHARED_SECRET).toBe(PROXY);
  });

  it('a whitespace-only value counts as not set (and warns)', () => {
    const cfg = loadConfig(prod({ PROXY_SHARED_SECRET: '   ' }));
    expect(cfg.PROXY_SHARED_SECRET).toBeUndefined();
    expect(cfg.warnings.join('\n')).toMatch(/PROXY_SHARED_SECRET not set/);
  });

  it('warns about a very short secret without printing it', () => {
    const cfg = loadConfig(prod({ PROXY_SHARED_SECRET: 'tiny-s3cret' }));
    expect(cfg.warnings.some((w) => /shorter than 16 characters/.test(w))).toBe(true);
    expect(JSON.stringify(cfg.warnings)).not.toContain('tiny-s3cret');
  });
});

describe('DATABASE_URL clean-up', () => {
  const URL_ = 'postgresql://user:pw@db.example.invalid:5432/app?sslmode=require';

  it('strips surrounding whitespace and one pair of quotes', () => {
    expect(loadConfig(prod({ DATABASE_URL: `  "${URL_}"  ` })).DATABASE_URL).toBe(URL_);
    expect(loadConfig(prod({ DATABASE_URL: `'${URL_}'` })).DATABASE_URL).toBe(URL_);
    expect(loadConfig(prod({ DATABASE_URL: 'postgres://u:p@h/db' })).DATABASE_URL).toBe('postgres://u:p@h/db');
  });

  it('rejects a pasted psql command or any non-postgres string without echoing it', () => {
    for (const bad of [`psql '${URL_}'`, 'mysql://u:p@h/db', 'not a url with SECRET-pw']) {
      const msg = throwsMessage(() => loadConfig(prod({ DATABASE_URL: bad })));
      expect(msg).toMatch(/DATABASE_URL must be a single connection string/);
      expect(msg).not.toContain('pw@');
      expect(msg).not.toContain('SECRET-pw');
    }
  });
});

describe('secrets never appear in warnings or error messages', () => {
  it('a fully configured production environment leaks no secret value', () => {
    const secrets = { SESSION_SECRET: SESSION, CREDENTIAL_ENCRYPTION_KEY: HEX64, PROXY_SHARED_SECRET: PROXY, DELTA_API_KEY: 'KEY-sentinel-abcdef', DELTA_API_SECRET: 'SECRET-sentinel-abcdef' };
    const cfg = loadConfig(prod({ ...secrets, ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: PW12 }));
    const text = JSON.stringify(cfg.warnings);
    for (const v of [...Object.values(secrets), PW12, ADMIN_HASH]) expect(text).not.toContain(v);
  });

  it('every failure message is free of the configured secret values', () => {
    const secrets = { SESSION_SECRET: SESSION, PROXY_SHARED_SECRET: PROXY, DELTA_API_SECRET: 'SECRET-sentinel-abcdef' };
    const cases: Array<Record<string, string | undefined>> = [
      { CREDENTIAL_ENCRYPTION_KEY: 'too-short-sentinel' },
      { ADMIN_PASSWORD_HASH: PW12 },
      { ADMIN_PASSWORD_HASH: undefined, ADMIN_PASSWORD: 'abc-senti' },
      { ADMIN_PASSWORD_HASH: undefined },
      { MARKET_DATA_SOURCE: 'synthetic' },
      { SESSION_SECRET: 'short-sentinel' },
    ];
    for (const c of cases) {
      const msg = throwsMessage(() => loadConfig(prod({ ...secrets, ...c })));
      for (const v of [...Object.values(secrets), ...Object.values(c)]) if (v && v !== 'synthetic') expect(msg).not.toContain(v);
    }
  });
});

describe('documentation stays in sync with config.ts', () => {
  const read = (rel: string) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const documented = (file: string) => new Set([...read(file).matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1]));

  it('.env.example documents every variable the server reads', () => {
    const fromSchema = [...read('../src/config.ts').matchAll(/^  ([A-Z][A-Z0-9_]+): (?:z\.|bool\()/gm)].map((m) => m[1]);
    expect(fromSchema.length).toBeGreaterThan(20);
    const other = [...read('../src/db/db.ts').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g), ...read('../src/runtime.ts').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]);
    const docs = documented('../../../.env.example');
    for (const name of [...fromSchema, ...other]) expect(docs.has(name), `${name} missing from .env.example`).toBe(true);
  });

  it('.env.example lists no setting the server does not read (no stale names)', () => {
    const known = new Set([
      ...[...read('../src/config.ts').matchAll(/^  ([A-Z][A-Z0-9_]+): (?:z\.|bool\()/gm)].map((m) => m[1]),
      ...[...read('../src/db/db.ts').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
      ...[...read('../src/runtime.ts').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
      ...[...read('../src/cli/dev-mock.ts').matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
      'POSTGRES_PASSWORD', // docker-compose.yml
    ]);
    for (const name of documented('../../../.env.example')) expect(known.has(name), `${name} in .env.example is not read anywhere`).toBe(true);
  });

  it('the dashboard .env.example documents exactly what the dashboard reads', () => {
    const web = documented('../../web/.env.example');
    expect([...web].sort()).toEqual(['BACKEND_URL', 'PROXY_SHARED_SECRET']);
    expect(read('../../web/lib/server.ts')).toMatch(/process\.env\.BACKEND_URL/);
    expect(read('../../web/lib/server.ts')).toMatch(/process\.env\.PROXY_SHARED_SECRET/);
  });

  it('render.yaml asks only for the two prompts and generates the other secrets', () => {
    const yml = read('../../../render.yaml');
    for (const key of ['SESSION_SECRET', 'CREDENTIAL_ENCRYPTION_KEY', 'PROXY_SHARED_SECRET']) {
      expect(yml, key).toMatch(new RegExp(`- key: ${key}\\s+(#[^\\n]*\\s+)?generateValue: true`));
    }
    for (const key of ['DATABASE_URL', 'ADMIN_PASSWORD']) expect(yml, key).toMatch(new RegExp(`- key: ${key}[^\\n]*\\s+sync: false`));
    expect(yml).toMatch(/healthCheckPath: \/api\/health/);
    expect(yml).toMatch(/numInstances: 1/);
    expect(yml).not.toMatch(/plan:\s*free/);
  });
});
