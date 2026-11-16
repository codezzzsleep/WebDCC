/** Native delivery IDs are retained separately from local retry/fence IDs. */
export interface DshApprovalDelivery {
  nativeId: string;
  agentId: string;
  eventId: string;
  callId?: string;
  durableId?: string;
  hostId: string;
  hostFingerprint: string;
  clientId: string;
  /** Local comparison token for this observed delivery and connection. */
  revision: string;
}
export interface DshApprovalAttempt { delivery: DshApprovalDelivery; optionId: string }
export interface DshApprovalRetry { commandId: string; revision: string }
export type DshApprovalRecoveryView =
  | { status: 'available'; approvalId: string; optionId: string; retryOf: DshApprovalRetry }
  | { status: 'unavailable'; approvalId: string; reason: string };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 65536;
export function isDshApprovalAttempt(value: unknown): value is DshApprovalAttempt {
  if (!object(value) || !['allowed-once', 'rejected'].includes(String(value['optionId'])) || !object(value['delivery'])) return false;
  const delivery = value['delivery'];
  return ['nativeId', 'agentId', 'eventId', 'hostId', 'hostFingerprint', 'clientId', 'revision'].every(key => id(delivery[key]))
    && ['callId', 'durableId'].every(key => delivery[key] === undefined || id(delivery[key]));
}
export function sameDshApproval(original: DshApprovalDelivery, current: DshApprovalDelivery): boolean {
  return original.nativeId === current.nativeId && original.agentId === current.agentId && original.eventId === current.eventId
    && original.hostId === current.hostId && original.hostFingerprint === current.hostFingerprint
    && (original.callId === undefined || original.callId === current.callId)
    && (original.durableId === undefined || original.durableId === current.durableId);
}
