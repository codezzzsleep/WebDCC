/**
 * 极简 ULID：26 位 Crockford base32，前 10 位时间戳、后 16 位随机。
 * 单调性不保证，但同毫秒内用随机位，足够本项目（单用户单进程）使用。
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    time = ENCODING[remaining % 32] + time;
    remaining = Math.floor(remaining / 32);
  }
  const random = new Uint8Array(16);
  globalThis.crypto.getRandomValues(random);
  let suffix = '';
  for (let i = 0; i < 16; i += 1) suffix += ENCODING[(random[i] ?? 0) % 32];
  return time + suffix;
}

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
