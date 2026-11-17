/** Complete native answer bytes and delivery identity, independent of local commands. */
export interface DshQuestionAnswer { id: string; selected: string[]; custom?: string }
export interface DshQuestionDelivery {
  nativeId: string;
  agentId: string;
  eventId: string;
  callId: string;
  itemIds: string[];
  /** Canonical native question schema, including its sensitive-field flags. */
  signature: string;
  timed: boolean;
  hostId: string;
  hostFingerprint: string;
  clientId: string;
  revision: string;
}
export interface DshQuestionAttempt { delivery: DshQuestionDelivery; answers: DshQuestionAnswer[] }
export interface DshQuestionRetry { commandId: string; revision: string }
export type DshQuestionRecoveryView =
  | { status: 'available'; questionId: string; items: (DshQuestionAnswer & { prompt: string })[]; retryOf: DshQuestionRetry }
  | { status: 'unavailable'; questionId: string; reason: string };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 65536;
export function isDshQuestionAnswers(value: unknown): value is DshQuestionAnswer[] {
  return Array.isArray(value) && value.length > 0 && value.every(answer => object(answer) && id(answer['id'])
    && Object.keys(answer).every(key => ['id', 'selected', 'custom'].includes(key))
    && Array.isArray(answer['selected']) && answer['selected'].every(item => typeof item === 'string')
    && (answer['custom'] === undefined || typeof answer['custom'] === 'string'))
    && new Set(value.map(answer => answer.id)).size === value.length;
}
export function isDshQuestionAttempt(value: unknown): value is DshQuestionAttempt {
  if (!object(value) || !object(value['delivery']) || !isDshQuestionAnswers(value['answers'])) return false;
  const delivery = value['delivery']; const answers = value['answers'];
  if (!['nativeId', 'agentId', 'eventId', 'callId', 'hostId', 'hostFingerprint', 'clientId', 'revision', 'signature'].every(key => id(delivery[key]))
    || typeof delivery['timed'] !== 'boolean' || !Array.isArray(delivery['itemIds'])
    || delivery['itemIds'].length !== answers.length || new Set(delivery['itemIds']).size !== answers.length
    || !delivery['itemIds'].every(item => id(item) && answers.some(answer => answer.id === item))) return false;
  try {
    const schema: unknown = JSON.parse(delivery['signature'] as string);
    return Array.isArray(schema) && schema.length === answers.length && schema.every((item, index) => object(item)
      && item['id'] === (delivery['itemIds'] as string[])[index] && typeof item['question'] === 'string' && item['isSecret'] === false);
  } catch { return false; }
}
export function sameDshQuestionDelivery(original: DshQuestionDelivery, current: DshQuestionDelivery): boolean {
  return original.nativeId === current.nativeId && original.agentId === current.agentId && original.eventId === current.eventId
    && original.callId === current.callId && original.hostId === current.hostId && original.hostFingerprint === current.hostFingerprint
    && original.signature === current.signature && original.timed === current.timed
    && JSON.stringify(original.itemIds) === JSON.stringify(current.itemIds);
}
