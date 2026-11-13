import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

it('NP-14 full interaction and model diagnostics require explicit opt-in', () => {
  expect(loadConfig({}).recordInteractions).toBe(false);
  expect(loadConfig({ WDCC_TRACE: '0' }).recordInteractions).toBe(false);
  expect(loadConfig({ WDCC_TRACE: '1' }).recordInteractions).toBe(true);
  expect(loadConfig({ WDCC_TRACE: '1', WDCC_TEST_HOOKS: '1' }).recordInteractions).toBe(false);
});
