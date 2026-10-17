import type { Credentials, DeltaEnvName } from '@cryptoalgo/delta';
import type { AppConfig } from '../config';
import { decrypt, encrypt, fingerprint, mask } from '../crypto';
import type { Repos } from '../repos';

export interface CredentialStatus {
  configured: boolean;
  source: 'environment' | 'database' | null;
  env: DeltaEnvName;
  fingerprint: string | null;
  keyHint: string | null;
  /** Whether dashboard-stored credentials can be encrypted (CREDENTIAL_ENCRYPTION_KEY present). */
  canStoreInDatabase: boolean;
  updatedAt: string | null;
}

/**
 * Server-side credential storage.
 *  1. DELTA_API_KEY / DELTA_API_SECRET environment variables win (host secret manager).
 *  2. Otherwise the key pair saved from the dashboard, encrypted with AES-256-GCM in the database.
 * The secret is never returned by any API; the UI only sees a fingerprint and a masked key hint.
 */
export class CredentialStore {
  private cached: { creds: Credentials; source: 'environment' | 'database'; fingerprint: string; keyHint: string; updatedAt: string | null } | null = null;

  constructor(
    private readonly repos: Repos,
    private readonly cfg: AppConfig,
    private readonly env: DeltaEnvName,
  ) {}

  private aad(): string {
    return `delta-credentials:${this.env}`;
  }

  async refresh(): Promise<void> {
    if (this.cfg.DELTA_API_KEY && this.cfg.DELTA_API_SECRET) {
      this.cached = {
        creds: { apiKey: this.cfg.DELTA_API_KEY, apiSecret: this.cfg.DELTA_API_SECRET },
        source: 'environment',
        fingerprint: fingerprint(this.cfg.DELTA_API_KEY),
        keyHint: mask(this.cfg.DELTA_API_KEY),
        updatedAt: null,
      };
      return;
    }
    const row = await this.repos.getCredentialRow(this.env);
    if (row && this.cfg.encryptionKey) {
      try {
        this.cached = {
          creds: { apiKey: decrypt(row.apiKeyEnc, this.cfg.encryptionKey, this.aad()), apiSecret: decrypt(row.apiSecretEnc, this.cfg.encryptionKey, this.aad()) },
          source: 'database',
          fingerprint: row.fingerprint,
          keyHint: row.keyHint,
          updatedAt: row.updatedAt,
        };
        return;
      } catch {
        // wrong/rotated encryption key: treat as not configured rather than crash
      }
    }
    this.cached = null;
  }

  /** Synchronous provider handed to the HTTP client so rotated credentials apply without a restart. */
  provider = (): Credentials | null => this.cached?.creds ?? null;

  fingerprint(): string | null {
    return this.cached?.fingerprint ?? null;
  }

  status(): CredentialStatus {
    return {
      configured: !!this.cached,
      source: this.cached?.source ?? null,
      env: this.env,
      fingerprint: this.cached?.fingerprint ?? null,
      keyHint: this.cached?.keyHint ?? null,
      canStoreInDatabase: !!this.cfg.encryptionKey,
      updatedAt: this.cached?.updatedAt ?? null,
    };
  }

  async save(apiKey: string, apiSecret: string, by: string): Promise<void> {
    if (!this.cfg.encryptionKey) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured on the server; set DELTA_API_KEY/DELTA_API_SECRET instead');
    if (this.cfg.DELTA_API_KEY && this.cfg.DELTA_API_SECRET) throw new Error('Credentials are provided by environment variables and cannot be changed from the dashboard');
    if (apiKey.length < 8 || apiSecret.length < 8) throw new Error('API key/secret look too short');
    await this.repos.putCredentialRow(this.env, encrypt(apiKey, this.cfg.encryptionKey, this.aad()), encrypt(apiSecret, this.cfg.encryptionKey, this.aad()), fingerprint(apiKey), mask(apiKey), by);
    await this.refresh();
  }

  async clear(): Promise<void> {
    if (this.cfg.DELTA_API_KEY && this.cfg.DELTA_API_SECRET) throw new Error('Credentials are provided by environment variables');
    await this.repos.deleteCredentialRow(this.env);
    await this.refresh();
  }
}
