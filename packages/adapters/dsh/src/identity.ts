import { createHash } from 'node:crypto';
import { dshBaseUrl } from './host.js';

export const DSH_BASELINE_VERSION = '0.2.2-rc.1';
export interface DshHostIdentity {
  url: string;
  version?: string;
  commit?: string;
  manifestRevision?: string;
  fingerprint?: string;
  status: 'verified' | 'unknown' | 'incompatible';
  source: 'native-bootstrap';
  reason?: string;
  /** The native API does not expose the profile directory/name. */
  profile: { scope: 'current-host-profile'; identity: 'unavailable-in-api' };
}

/** Exchange only with the registered Host. The browser credential is kept
 * server-side, separate from the operator's one-socket v2 credential. */
export async function attachDshBrowser(endpoint: string | number, token: string): Promise<string> {
  const target = new URL(dshBaseUrl(endpoint));
  target.searchParams.set('token', token);
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  if (![302, 303, 307].includes(response.status) || cookie === undefined || !/^dsh-auth-[^=]+=v1\./.test(cookie)) throw Object.assign(new Error('DSH browser authentication failed; reconnect using the current Host link'), { statusCode: 401 });
  return cookie;
}

/** Parse JSON data; never evaluate any script from the native page. */
export function identityFromDshBootstrap(endpoint: string | number, html: string): DshHostIdentity {
  const identity: DshHostIdentity = { url: dshBaseUrl(endpoint), status: 'unknown', source: 'native-bootstrap', profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' } };
  const assignment = /(?:globalThis|window)(?:\["__DSH_BOOT__"\]|\.__DSH_BOOT__)\s*=\s*([^<]+)<\/script\s*>/i.exec(html);
  if (assignment?.[1] === undefined) return { ...identity, reason: 'Host bootstrap has no release identity' };
  let value: unknown;
  try { value = JSON.parse(assignment[1].trim().replace(/;\s*$/, '')); } catch { return { ...identity, reason: 'Host bootstrap identity is malformed' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ...identity, reason: 'Host bootstrap identity is malformed' };
  const graph = value as { rev?: unknown; release?: { version?: unknown; commit?: unknown }; entries?: unknown };
  if (typeof graph.rev !== 'string' || !Array.isArray(graph.entries) || typeof graph.release?.version !== 'string') return { ...identity, reason: 'Host did not publish a versioned boot manifest' };
  const version = graph.release.version;
  const commit = typeof graph.release.commit === 'string' ? graph.release.commit : undefined;
  return { ...identity, version, ...(commit === undefined ? {} : { commit }), manifestRevision: graph.rev,
    fingerprint: createHash('sha256').update(JSON.stringify({ release: graph.release, rev: graph.rev, entries: graph.entries })).digest('hex'),
    status: version === DSH_BASELINE_VERSION ? 'verified' : 'incompatible',
    ...(version === DSH_BASELINE_VERSION ? {} : { reason: `Host ${version} differs from baseline ${DSH_BASELINE_VERSION}` }),
  };
}

export async function readDshHostIdentity(endpoint: string | number, browserCookie?: string): Promise<DshHostIdentity> {
  const url = dshBaseUrl(endpoint);
  const unknown = (reason: string): DshHostIdentity => ({ url, status: 'unknown', source: 'native-bootstrap', profile: { scope: 'current-host-profile', identity: 'unavailable-in-api' }, reason });
  if (browserCookie === undefined || browserCookie === '') return unknown('Browser credential is unavailable; reconnect to verify this Host');
  const response = await fetch(url, { redirect: 'manual', headers: { cookie: browserCookie }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return unknown(`Host bootstrap HTTP ${response.status}`);
  const reader = response.body?.getReader();
  if (reader === undefined) return unknown('Host bootstrap is empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > 4 * 1024 * 1024) return unknown('Host bootstrap exceeds the identity limit');
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return identityFromDshBootstrap(url, Buffer.concat(chunks).toString('utf8'));
}

export function requireDshBaseline(identity: DshHostIdentity): void {
  if (identity.status !== 'verified') throw Object.assign(new Error(identity.reason ?? 'DSH Host version is unverified'), { statusCode: 409, code: 'dsh-host-version-blocked' });
}
