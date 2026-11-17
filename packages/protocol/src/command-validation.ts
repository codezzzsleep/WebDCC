import type { ClientMessage, Command } from './sync.js';
import { isInputContent } from './input.js';
import { isDshQuestionAnswers } from './dsh-question-replies.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
const opaqueId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 65536;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 32 && value.every(id);
const sequence = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const retry = (value: unknown): boolean => record(value) && Object.keys(value).every(key => ['commandId', 'revision'].includes(key))
  && id(value['commandId']) && typeof value['revision'] === 'string' && /^[a-f0-9]{64}$/.test(value['revision']);

export function isCommand(value: unknown): value is Command {
  if (!record(value) || !id(value['clientCommandId'])) return false;
  const op = value['op'];
  if (op !== 'create-session' && !id(value['sessionId'])) return false;
  switch (op) {
    case 'send': return typeof value['text'] === 'string' && (value['images'] === undefined || strings(value['images']))
      && (value['contentParts'] === undefined || isInputContent(value['contentParts'], value['text']))
      && !(value['contentParts'] !== undefined && Array.isArray(value['images']) && value['images'].length > 0)
      && (value['intent'] === undefined || ['send', 'queue', 'steer'].includes(String(value['intent'])))
      && (value['expectedTurnId'] === undefined || id(value['expectedTurnId']));
    case 'approve': return opaqueId(value['approvalId']) && opaqueId(value['optionId'])
      && (value['retryOf'] === undefined || retry(value['retryOf']));
    case 'answer': return opaqueId(value['questionId']) && value['answer'] !== undefined
      && (value['retryOf'] === undefined || retry(value['retryOf']) && value['intent'] === undefined && value['expectedTurnId'] === undefined
        && record(value['answer']) && Object.keys(value['answer']).length === 1 && isDshQuestionAnswers(value['answer']['answers']))
      && (value['intent'] === undefined || ['send', 'queue', 'steer'].includes(String(value['intent'])))
      && (value['expectedTurnId'] === undefined || id(value['expectedTurnId']));
    case 'interrupt': return sequence(value['createdAt']);
    case 'rename': return typeof value['title'] === 'string';
    case 'pin': return typeof value['pinned'] === 'boolean';
    case 'archive': return typeof value['archived'] === 'boolean';
    case 'set-access-mode': return id(value['accessMode']);
    case 'set-model': return id(value['model']);
    case 'set-reasoning-effort': return id(value['reasoningEffort']);
    case 'create-session': return id(value['workspaceId']) && ['codex', 'claude-code', 'dsh'].includes(String(value['agent']))
      && ['model', 'reasoningEffort', 'accessMode', 'parentId'].every(key => value[key] === undefined || id(value[key]))
      && (value['providerId'] === undefined || value['providerId'] === null || id(value['providerId']))
      && (value['draftText'] === undefined || typeof value['draftText'] === 'string');
    default: return false;
  }
}

export function isClientMessage(value: unknown): value is ClientMessage {
  if (!record(value)) return false;
  const subscriptions = (items: unknown): boolean => Array.isArray(items) && items.length <= 32 && items.every(item => record(item) && id(item['sessionId']) && sequence(item['afterSeq']));
  switch (value['op']) {
    case 'command': return isCommand(value['command']);
    case 'hello': return id(value['clientId']) && sequence(value['feedAfter']) && subscriptions(value['subscribe']);
    case 'subscribe': return subscriptions(value['subscribe']);
    case 'unsubscribe': return strings(value['sessionIds']);
    case 'pong': return true;
    case 'dsh-question-wait': return id(value['requestId']) && id(value['sessionId']) && opaqueId(value['questionId'])
      && (value['action'] === 'claim' && Object.keys(value).every(key => ['op', 'requestId', 'sessionId', 'questionId', 'action'].includes(key))
        || ['timeout', 'release'].includes(String(value['action'])) && id(value['claimId'])
          && Object.keys(value).every(key => ['op', 'requestId', 'sessionId', 'questionId', 'action', 'claimId'].includes(key)));
    default: return false;
  }
}
