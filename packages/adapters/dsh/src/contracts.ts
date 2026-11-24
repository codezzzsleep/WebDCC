import { Ajv, type ValidateFunction } from 'ajv';
import { dshRuntimeContract, DSH_BASELINE_VERSION } from './runtime.js';

export type DshSessionAddress = { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' | 'unknown' };
export interface DshHistoryRecord {
  type: 'event';
  event: { type: string; seq: number; time: number; data: unknown; [key: string]: unknown };
}
export interface DshPage { cursor: number; records: DshHistoryRecord[]; hasMore: boolean }
export interface DshPageRequest {
  address: DshSessionAddress;
  throughSeq?: number;
  beforeSeq?: number;
  maxMessages?: number;
}
export interface DshFollowRequest { address: DshSessionAddress; activate?: boolean; assistantStream?: true; maxMessages?: number }
export interface DshSubagentPrompt {
  request: { requestId: string; childSessionId: string; delivery: 'queue' | 'steer'; content: { type: 'text'; text: string }[]; clientTimeZone?: string };
}
export interface DshSubagentInterrupt { childSessionId: string }

const ajv = new Ajv({ strict: false, allErrors: true });
const requests = new Map<string, ValidateFunction>();
const responses = new Map<string, ValidateFunction>();
const eventsResult = {
  type: 'object', properties: {
    clientId: { type: 'string', minLength: 1 }, eventId: { type: 'string', minLength: 1 },
    outcome: { oneOf: [
      { type: 'object', properties: { kind: { const: 'next' } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'result' }, value: {} }, required: ['kind', 'value'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'rejected' }, error: {
        type: 'object', properties: { name: { type: 'string', minLength: 1 }, message: { type: 'string' }, code: { type: 'string' }, details: {} },
        required: ['name', 'message'], additionalProperties: false,
      } }, required: ['kind', 'error'], additionalProperties: false },
    ] },
  }, required: ['clientId', 'eventId', 'outcome'], additionalProperties: false,
};

/** Validate the frozen Host catalog at the transport boundary. Remote event
 * forwarding has a separate envelope because it is not a catalog endpoint. */
export function validateDshArgs(endpoint: string, args: unknown, nativeVersion: string = DSH_BASELINE_VERSION): void {
  const { endpoints } = dshRuntimeContract(nativeVersion);
  const key = `${nativeVersion}:${endpoint}`;
  let validate = requests.get(key);
  if (validate === undefined) {
    const descriptor = endpoints[endpoint];
    if (endpoint === '$events/result') validate = ajv.compile(eventsResult);
    else if (endpoint === '$events') validate = ajv.compile({ type: 'object', maxProperties: 0 });
    else {
      if (descriptor === undefined) throw new Error(`DSH endpoint is absent from frozen catalog: ${endpoint}`);
      const properties = Object.fromEntries(descriptor.parameters.map(parameter => {
        if (parameter.jsonSchema === undefined) throw new Error(`DSH parameter schema unavailable: ${endpoint}.${parameter.name}`);
        return [parameter.name, parameter.jsonSchema];
      }));
      validate = ajv.compile({ type: 'object', properties,
        required: descriptor.parameters.filter(parameter => parameter.acceptsUndefined !== true).map(parameter => parameter.name), additionalProperties: false });
    }
    requests.set(key, validate);
  }
  if (!validate(args)) throw new Error(`Invalid DSH ${endpoint} args: ${ajv.errorsText(validate.errors)}`);
}

export function validateDshResult(endpoint: string, result: unknown, nativeVersion: string = DSH_BASELINE_VERSION): void {
  const { endpoints } = dshRuntimeContract(nativeVersion);
  const schema = endpoints[endpoint]?.result;
  // Native dictionaries with unconstrained JSON do not have an exported
  // result schema. Preserve that limitation rather than inventing a schema.
  if (schema === undefined || 'spec' in schema) return;
  const key = `${nativeVersion}:${endpoint}`;
  let validate = responses.get(key);
  if (validate === undefined) { validate = ajv.compile(schema); responses.set(key, validate); }
  if (!validate(result)) throw new Error(`Invalid DSH ${endpoint} result: ${ajv.errorsText(validate.errors)}`);
}
