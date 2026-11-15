import { expect, it } from 'vitest';
import { initialPermissions, nativeAccessMode, observePermissions } from '../src/permissions.js';

it('NP-07 keeps requested permissions separate from the currently observed native policy', () => {
  expect(nativeAccessMode('inherit')).toBeUndefined();
  expect(initialPermissions()).toMatchObject({ requested: null, effective: null, phase: 'inherit' });
  const pending = initialPermissions('read-only');
  const actual = observePermissions(pending, { effective: 'workspace', scope: 'thread', source: 'thread/start' });
  expect(actual).toMatchObject({ requested: 'read-only', effective: 'workspace', phase: 'pending' });
  expect(observePermissions(actual, { effective: ':read-only', scope: 'turn', source: 'turn/start' })).toMatchObject({ requested: 'read-only', effective: ':read-only', phase: 'observed' });
});

it('NP-07 stale native snapshots cannot revert a newer effective policy or hide a failed downgrade', () => {
  const actual = observePermissions(initialPermissions('read-only'), { effective: 'read-only', nativeSeq: 10, source: 'projection', scope: 'session' });
  expect(observePermissions(actual, { effective: 'danger-full-access', nativeSeq: 5, source: 'snapshot', scope: 'session' })).toBe(actual);
  const failed = { ...initialPermissions('read-only'), effective: 'workspace', phase: 'failed' as const, error: 'denied' };
  expect(observePermissions(failed, { effective: 'workspace', source: 'init', scope: 'query' })).toMatchObject({ phase: 'failed', error: 'denied', requested: 'read-only' });
});

it('NP-07 missing native readback clears stale policy instead of confirming requested or inherited settings', () => {
  const actual = observePermissions(initialPermissions('read-only'), { effective: 'workspace', source: 'thread/start', scope: 'thread' });
  expect(observePermissions(actual, { effective: null, source: 'unconfirmed', scope: 'turn' })).toMatchObject({ requested: 'read-only', effective: null, phase: 'pending' });
  expect(observePermissions({ ...actual, requested: null }, { effective: null, source: 'unconfirmed', scope: 'turn' })).toMatchObject({ requested: null, effective: null, phase: 'unknown' });
});
