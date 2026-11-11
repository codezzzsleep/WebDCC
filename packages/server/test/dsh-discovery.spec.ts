import { describe, expect, it } from 'vitest';
import { parseDshTokenFromJournal } from '../src/dsh-discovery.js';

describe('DSH 本机启动链接发现', () => {
  it('取 journal 中最后一次启动的 token', () => {
    const text = [
      'dsh web: http://127.0.0.1:3080/?token=old-token',
      'dsh web: http://192.168.0.119:3080/?token=current_token-123',
    ].join('\n');
    expect(parseDshTokenFromJournal(text)).toBe('current_token-123');
  });

  it('没有启动链接时返回 undefined', () => {
    expect(parseDshTokenFromJournal('dsh web: listening on 127.0.0.1')).toBeUndefined();
  });
});
