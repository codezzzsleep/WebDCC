import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

it('NP-14 full interaction and model diagnostics require explicit opt-in', () => {
  expect(loadConfig({}).recordInteractions).toBe(false);
  expect(loadConfig({ WDCC_TRACE: '0' }).recordInteractions).toBe(false);
  expect(loadConfig({ WDCC_TRACE: '1' }).recordInteractions).toBe(true);
  expect(loadConfig({ WDCC_TRACE: '1', WDCC_TEST_HOOKS: '1' }).recordInteractions).toBe(false);
});

it('NP-14 diagnostic limits have bounded defaults and reject malformed settings only when diagnostics are enabled', () => {
  expect(loadConfig({ WDCC_TRACE: '1' }).diagnosticLimits).toEqual({ maxCaptureBytes: 8 * 1024 * 1024, maxCaptureChunks: 4096, maxFileBytes: 64 * 1024 * 1024, maxQueuedBytes: 32 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000 });
  expect(loadConfig({ WDCC_TRACE_MAX_CAPTURE_BYTES: 'invalid' }).diagnosticLimits).toBeUndefined();
  expect(() => loadConfig({ WDCC_TRACE: '1', WDCC_TRACE_MAX_CAPTURE_BYTES: '-1' })).toThrow('WDCC_TRACE_MAX_CAPTURE_BYTES');
  expect(() => loadConfig({ WDCC_TRACE: '1', WDCC_TRACE_RETENTION_MS: '0' })).toThrow('WDCC_TRACE_RETENTION_MS');
});
