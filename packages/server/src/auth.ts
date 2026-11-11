import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

/** 过渡期的固定 Cookie 名：同名 Cookie 不区分端口，同机多实例会互相覆盖（F18） */
export const LEGACY_COOKIE_NAME = 'wdcc-auth';
const COOKIE_PREFIX = 'wdcc-auth-';
const COOKIE_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

function encodeBase64Url(value: Buffer): string {
  return value.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

/**
 * Cookie 名由请求的 Host（含端口）派生（SPEC-M8 F18）。
 * 与 DSH 的 `cookieName(authority)` 同一做法：前缀 + base64url(sha256(authority))。
 */
export function cookieNameFor(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest());
}

/** 请求的 authority（Host 头，含端口）；缺失时退回给定的监听地址 */
export function requestAuthority(headers: IncomingHttpHeaders, fallback: string): string {
  const host = headers.host;
  if (typeof host === 'string' && host.trim() !== '') return host.trim().toLowerCase();
  return fallback;
}

export function authorityOf(headers: IncomingHttpHeaders, fallbackHost: string, fallbackPort: number): string {
  return requestAuthority(headers, `${fallbackHost}:${fallbackPort}`);
}

/** 签名密钥由 token 派生：更换 token 即让旧 Cookie 失效（SPEC 12.1） */
function signingKey(token: string): Buffer {
  return createHmac('sha256', 'webdcc-cookie-v1').update(token).digest();
}

function sign(token: string, payload: string): string {
  return createHmac('sha256', signingKey(token)).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function issueCookie(token: string, ttlDays = COOKIE_TTL_DAYS): string {
  const payload = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + ttlDays * DAY_MS })).toString('base64url');
  return `v1.${payload}.${sign(token, payload)}`;
}

export function verifyCookie(token: string, value: string | undefined): boolean {
  if (value === undefined || value === '') return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  const [version, payload, signature] = parts as [string, string, string];
  if (version !== 'v1') return false;
  if (!safeEqual(signature, sign(token, payload))) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { v?: number; exp?: number };
    return decoded.v === 1 && typeof decoded.exp === 'number' && decoded.exp > Date.now();
  } catch {
    return false;
  }
}

/** 常量时间比较访问 token */
export function tokenEquals(expected: string, candidate: string | undefined): boolean {
  if (candidate === undefined) return false;
  return safeEqual(sign(expected, 'cmp'), sign(candidate, 'cmp'));
}

export function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '') out[name] = decodeURIComponent(value);
  }
  return out;
}

export type AuthKind = 'named' | 'legacy' | 'none';

/** 认证结果：区分"按 Host 派生的新 Cookie"和过渡期的旧 Cookie */
export function authState(token: string, cookieHeader: string | undefined, authority: string): AuthKind {
  const cookies = parseCookieHeader(cookieHeader);
  if (verifyCookie(token, cookies[cookieNameFor(authority)])) return 'named';
  if (verifyCookie(token, cookies[LEGACY_COOKIE_NAME])) return 'legacy';
  return 'none';
}

export function isAuthenticated(token: string, cookieHeader: string | undefined, authority = ''): boolean {
  return authState(token, cookieHeader, authority) !== 'none';
}

export function cookieHeaderValue(name: string, cookie: string, secure = false): string {
  const maxAge = COOKIE_TTL_DAYS * 24 * 60 * 60;
  return `${name}=${cookie}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
