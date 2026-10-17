import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';
import type { AppConfig } from './config';
import { randomId, safeEqual } from './crypto';
import type { Repos } from './repos';

export type UserRole = 'admin' | 'viewer';

export interface Principal {
  username: string;
  role: UserRole;
}

interface UserRecord {
  username: string;
  role: UserRole;
  hash: string;
}

const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60_000;
// bcrypt hash of a random string: used to keep response time constant for unknown usernames
const DUMMY_HASH = bcrypt.hashSync(randomId('dummy', 8), 8);

/**
 * Authentication and session handling.
 *  - passwords are verified against bcrypt hashes configured in the server environment
 *  - sessions are short-lived signed JWTs (HS256); they are never stored in the browser by the API
 *    (the dashboard keeps them in an httpOnly cookie set by its own server-side proxy)
 *  - brute force protection: 5 failures per (ip, username) lock that pair for 15 minutes
 */
export class AuthService {
  private users: UserRecord[] = [];
  private failures = new Map<string, { count: number; lockedUntil: number }>();
  readonly generatedAdminPassword: string | null;
  private readonly key: Uint8Array;

  constructor(
    private readonly cfg: AppConfig,
    private readonly repos: Repos,
    private readonly now: () => number = Date.now,
  ) {
    this.key = new TextEncoder().encode(cfg.sessionSecret);
    let generated: string | null = null;
    if (cfg.ADMIN_PASSWORD_HASH) this.users.push({ username: cfg.ADMIN_USERNAME, role: 'admin', hash: cfg.ADMIN_PASSWORD_HASH });
    else if (cfg.ADMIN_PASSWORD && !cfg.isProd) this.users.push({ username: cfg.ADMIN_USERNAME, role: 'admin', hash: bcrypt.hashSync(cfg.ADMIN_PASSWORD, 10) });
    else if (!cfg.isProd) {
      generated = randomId('dev-', 9);
      this.users.push({ username: cfg.ADMIN_USERNAME, role: 'admin', hash: bcrypt.hashSync(generated, 10) });
    }
    if (cfg.VIEWER_PASSWORD_HASH) this.users.push({ username: cfg.VIEWER_USERNAME, role: 'viewer', hash: cfg.VIEWER_PASSWORD_HASH });
    this.generatedAdminPassword = generated;
  }

  private lockKey(ip: string, username: string) {
    return `${ip}|${username.toLowerCase()}`;
  }

  async login(username: string, password: string, ip: string): Promise<{ ok: true; token: string; role: UserRole; username: string; expiresAt: number } | { ok: false; status: 401 | 423; error: string }> {
    const key = this.lockKey(ip, username);
    const rec = this.failures.get(key);
    if (rec && rec.lockedUntil > this.now()) {
      await this.repos.audit({ actor: username, ip, action: 'login_blocked', success: false, details: { reason: 'locked' } }).catch(() => {});
      return { ok: false, status: 423, error: 'Too many failed attempts. Try again later.' };
    }
    const user = this.users.find((u) => safeEqual(u.username.toLowerCase(), username.toLowerCase()));
    const valid = await bcrypt.compare(password, user?.hash ?? DUMMY_HASH);
    if (!user || !valid) {
      const prev = rec && (rec.lockedUntil === 0 || rec.lockedUntil > this.now()) ? rec.count : 0; // an expired lock starts fresh
      const next = { count: prev + 1, lockedUntil: 0 };
      if (next.count >= MAX_FAILURES) next.lockedUntil = this.now() + LOCK_MS;
      this.failures.set(key, next);
      await this.repos.audit({ actor: username, ip, action: 'login_failed', success: false, details: { attempts: next.count } }).catch(() => {});
      return { ok: false, status: 401, error: 'Invalid credentials' };
    }
    this.failures.delete(key);
    const ttlMs = this.cfg.SESSION_TTL_HOURS * 3_600_000;
    const expiresAt = this.now() + ttlMs;
    const token = await new SignJWT({ role: user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.username)
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(Math.floor(expiresAt / 1000))
      .setJti(randomId('s_', 6))
      .sign(this.key);
    await this.repos.audit({ actor: user.username, role: user.role, ip, action: 'login', success: true }).catch(() => {});
    return { ok: true, token, role: user.role, username: user.username, expiresAt };
  }

  async verify(token: string): Promise<Principal | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: ['HS256'], currentDate: new Date(this.now()) });
      const role = payload.role;
      if (typeof payload.sub !== 'string' || (role !== 'admin' && role !== 'viewer')) return null;
      // the account must still exist with the same role (role changes / removal take effect at once)
      const u = this.users.find((x) => x.username === payload.sub);
      if (!u || u.role !== role) return null;
      return { username: payload.sub, role };
    } catch {
      return null;
    }
  }

  /** Step-up authentication for sensitive actions (live activation, credentials). */
  async verifyPassword(username: string, password: string): Promise<boolean> {
    const user = this.users.find((u) => u.username === username);
    return bcrypt.compare(password, user?.hash ?? DUMMY_HASH).then((ok) => !!user && ok);
  }
}
