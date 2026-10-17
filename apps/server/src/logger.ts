import type { Logger } from '@cryptoalgo/delta';

/**
 * Minimal structured logger with secret redaction. Never pass raw credentials, but if one slips
 * into metadata it is masked before it reaches stdout.
 */

const SECRET_KEYS = /(secret|password|passwd|token|authorization|api[-_]?key|signature|cookie|private)/i;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(level: Level = 'info', scope = 'app', sink: (line: string) => void = (l) => process.stdout.write(l + '\n')): Logger & { child(scope: string): Logger } {
  const min = LEVELS[level];
  const emit = (lvl: Level, msg: string, meta?: Record<string, unknown>) => {
    if (LEVELS[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, scope, msg, ...(meta ? (redact(meta) as object) : {}) }));
  };
  return {
    debug: (m, meta) => emit('debug', m, meta),
    info: (m, meta) => emit('info', m, meta),
    warn: (m, meta) => emit('warn', m, meta),
    error: (m, meta) => emit('error', m, meta),
    child: (s: string) => createLogger(level, `${scope}.${s}`, sink),
  };
}
