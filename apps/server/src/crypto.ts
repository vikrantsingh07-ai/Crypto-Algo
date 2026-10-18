import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

/** Fixed HKDF domain-separation label. Changing it changes every derived key (stored credentials become unreadable). */
const KEY_DERIVATION_INFO = 'cryptoalgo/credential-encryption-key/v1';
/** base64 (standard or URL-safe, padded or not) of exactly 32 bytes: 43 characters plus an optional "=". */
const BASE64_32_BYTES = /^[A-Za-z0-9+/_-]{43}=?$/;

/**
 * Turns the CREDENTIAL_ENCRYPTION_KEY setting into the 32-byte AES-256 key.
 *  - base64 of exactly 32 bytes (`openssl rand -base64 32`) is used as is, as it always was
 *  - any other secret of at least 32 characters (a 64-char hex string, a password manager's random string, ...)
 *    is stretched to 32 bytes with HKDF-SHA256, so a phone user does not need openssl
 * The same input always yields the same key. Error messages never contain the secret.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const secret = raw.trim();
  if (BASE64_32_BYTES.test(secret)) {
    const key = Buffer.from(secret, 'base64');
    if (key.length === 32) return key;
  }
  if (secret.length < 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY is too short (${secret.length} characters): use base64 of 32 random bytes or any random secret of at least 32 characters (for example a 64-character hex string)`,
    );
  }
  if (new Set(secret).size < 10) {
    throw new Error('CREDENTIAL_ENCRYPTION_KEY looks too repetitive to be a random secret (fewer than 10 distinct characters): generate a random one');
  }
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), KEY_DERIVATION_INFO, 32));
}

/**
 * AES-256-GCM envelope for API credentials stored in the database.
 * Format: v1.<iv b64>.<tag b64>.<ciphertext b64>. The additional authenticated data binds the
 * ciphertext to its purpose/row so blobs cannot be swapped between rows.
 */

export function encrypt(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

export function decrypt(blob: string, key: Buffer, aad: string): string {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported credential blob');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

/** Non-reversible short identifier shown in the UI instead of the key (e.g. "k_3fa9c1…"). */
export function fingerprint(apiKey: string): string {
  return 'k_' + createHash('sha256').update(apiKey).digest('hex').slice(0, 10);
}

export function mask(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-3)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function hmacHex(secret: string, data: string): string {
  return createHmac('sha256', secret).update(data).digest('hex');
}

export function randomId(prefix = '', bytes = 8): string {
  return prefix + randomBytes(bytes).toString('hex');
}
