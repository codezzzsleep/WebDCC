import { Ajv, type ValidateFunction } from 'ajv';
import catalog from '../../../../fixtures/dsh/host-api-catalog.json' with { type: 'json' };

export interface DshSessionAddress { kind: 'session'; sessionId: string }
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
  request: { requestId: string; parentSessionId: string; childSessionId: string; mode: 'continuable'; delivery: 'queue' | 'steer'; content: { type: 'text'; text: string }[] };
}
export interface DshSubagentInterrupt { childSessionId: string; parentSessionId: string; mode: 'continuable' }

interface Descriptor { parameters: { name: string; jsonSchema?: object }[]; result?: object }
const endpoints = catalog.endpoints as Record<string, Descriptor>;
const ajv = new Ajv({ strict: false, allErrors: true });
const requests = new Map<string, ValidateFunction>();
const responses = new Map<string, ValidateFunction>();
const eventsResult = {
  type: 'object', properties: {
    clientId: { type: 'string', minLength: 1 }, eventId: { type: 'string', minLength: 1 },
    outcome: { oneOf: [
      { type: 'object', properties: { kind: { const: 'next' } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { const: 'result' }, value: {} }, required: ['kind', 'value'], additionalProperties: false },
    ] },
  }, required: ['clientId', 'eventId', 'outcome'], additionalProperties: false,
};

/** Validate the frozen Host catalog at the transport boundary. Remote event
 * forwarding has a separate envelope because it is not a catalog endpoint. */
export function validateDshArgs(endpoint: string, args: unknown): void {
  let validate = requests.get(endpoint);
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
      validate = ajv.compile({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
    }
    requests.set(endpoint, validate);
  }
  if (!validate(args)) throw new Error(`Invalid DSH ${endpoint} args: ${ajv.errorsText(validate.errors)}`);
}

export function validateDshResult(endpoint: string, result: unknown): void {
  const schema = endpoints[endpoint]?.result;
  // Native dictionaries with unconstrained JSON do not have an exported
  // result schema. Preserve that limitation rather than inventing a schema.
  if (schema === undefined || 'spec' in schema) return;
  let validate = responses.get(endpoint);
  if (validate === undefined) { validate = ajv.compile(schema); responses.set(endpoint, validate); }
  if (!validate(result)) throw new Error(`Invalid DSH ${endpoint} result: ${ajv.errorsText(validate.errors)}`);
}
