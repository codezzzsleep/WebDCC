import { expect, it } from 'vitest';
import { claudeBlockOrigin, orderClaudeBlocks, type ClaudeBlockOrigin } from './claude-content.js';

const origin = (blockIndex: number, changes: Partial<ClaudeBlockOrigin> = {}): ClaudeBlockOrigin => ({ agent: 'claude-code',
  queryId: 'query', nativeSessionId: 'native', nativeMessageId: 'message', parentToolUseId: null, blockIndex, ...changes });
const row = (id: string, blockIndex: number, changes: Partial<ClaudeBlockOrigin> = {}) => ({ id, data: { claudeBlock: origin(blockIndex, changes) } });

it('restores native block order across completed and still-live rows while preserving unrelated row positions', () => {
  const input = [row('before', 0), row('after', 2), { id: 'other-agent', data: {} }, row('late-tool', 1)];
  const ordered = orderClaudeBlocks(input);
  expect(ordered.map(item => item.id)).toEqual(['before', 'late-tool', 'other-agent', 'after']);
  expect(input.map(item => item.id)).toEqual(['before', 'after', 'other-agent', 'late-tool']);
  expect(ordered[1]).toBe(input[3]);
});

it('never joins different query, session, message or parent identities with equal block indices', () => {
  const input = [row('main-late', 2), row('old-query', 1, { queryId: 'old' }), row('other-session', 1, { nativeSessionId: 'other' }),
    row('other-message', 1, { nativeMessageId: 'other' }), row('child', 1, { parentToolUseId: 'spawn' }), row('main-early', 0)];
  expect(orderClaudeBlocks(input).map(item => item.id)).toEqual(['main-early', 'old-query', 'other-session', 'other-message', 'child', 'main-late']);
});

it('retains missing and malformed legacy identities in receive order instead of guessing native positions', () => {
  const input = [{ id: 'legacy', data: { text: 'old', claudeActor: { blockIndex: 2 } } },
    row('no-query', 2, { queryId: undefined }), row('no-message', 1, { nativeMessageId: undefined }),
    { id: 'invalid-index', data: { claudeBlock: { ...origin(0), blockIndex: -1 } } },
    { id: 'invalid-parent', data: { claudeBlock: { ...origin(0), parentToolUseId: undefined } } }];
  expect(orderClaudeBlocks(input)).toEqual(input);
  expect(claudeBlockOrigin(input[3]!)).toBeUndefined(); expect(claudeBlockOrigin(input[4]!)).toBeUndefined();
});

it('supports task-output rows and preserves distinct rows sharing the same native block position', () => {
  const input = [{ id: 'later', claudeBlock: origin(2) }, { id: 'tool', claudeBlock: origin(1) }, { id: 'tool-extra', claudeBlock: origin(1) }];
  expect(orderClaudeBlocks(input).map(item => item.id)).toEqual(['tool', 'tool-extra', 'later']);
});
