import { createHmac, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'wdcc-auth';
const COOKIE_TTL_DAYS = 30;
const DAY_MS = 86_400_000;

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

export function isAuthenticated(token: string, cookieHeader: string | undefined): boolean {
  const cookies = parseCookieHeader(cookieHeader);
  return verifyCookie(token, cookies[COOKIE_NAME]);
}

export function cookieHeaderValue(cookie: string, secure = false): string {
  const maxAge = COOKIE_TTL_DAYS * 24 * 60 * 60;
  return `${COOKIE_NAME}=${cookie}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}
