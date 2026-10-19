/** Dotted paths whose values differ between two JSON documents (a missing group counts as an empty one). */
export function diffPaths(a: unknown, b: unknown, prefix = ''): string[] {
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (isObj(b) && (a === undefined || a === null)) a = {};
  if (isObj(a) && (b === undefined || b === null)) b = {};
  if (!isObj(a) || !isObj(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out.push(...diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k));
  }
  return out;
}
