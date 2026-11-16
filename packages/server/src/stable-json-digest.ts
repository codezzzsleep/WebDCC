import { createHash } from 'node:crypto';

/** Versioned JSON encoding is independent of Intl locale. Array order and
 * ordinary JSON conversion retain the command digest's existing semantics. */
export function stableJsonDigest(value: unknown): string {
  const canonical = JSON.stringify(value, (_key, child: unknown) => child !== null && typeof child === 'object' && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : child);
  return 'sha256-json-v2:' + createHash('sha256').update(canonical).digest('hex');
}
