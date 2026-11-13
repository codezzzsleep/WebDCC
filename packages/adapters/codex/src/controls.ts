import { Ajv, type ValidateFunction } from 'ajv';
import type { ClientRequest } from './schema/ClientRequest.js';
import type { InitializeResponse } from './schema/InitializeResponse.js';
import type { ThreadStartResponse } from './schema/v2/ThreadStartResponse.js';
import type { ThreadResumeResponse } from './schema/v2/ThreadResumeResponse.js';
import type { TurnStartResponse } from './schema/v2/TurnStartResponse.js';
import type { TurnInterruptResponse } from './schema/v2/TurnInterruptResponse.js';
import type { PermissionProfileListResponse } from './schema/v2/PermissionProfileListResponse.js';
import protocolSchema from './json-schema/codex_app_server_protocol.schemas.json' with { type: 'json' };
import type { JsonRpcStdio } from './rpc.js';

type Method = ClientRequest['method'];
export type NativeParams<M extends Method> = Extract<ClientRequest, { method: M }>['params'];
interface Results {
  initialize: InitializeResponse;
  'thread/start': ThreadStartResponse;
  'thread/resume': ThreadResumeResponse;
  'turn/start': TurnStartResponse;
  'turn/interrupt': TurnInterruptResponse;
  'permissionProfile/list': PermissionProfileListResponse;
}

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
for (const [name, minimum, maximum] of [
  ['uint', 0, Number.MAX_SAFE_INTEGER], ['uint16', 0, 65535], ['uint32', 0, 4294967295], ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['int32', -2147483648, 2147483647], ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const) ajv.addFormat(name, { type: 'number', validate: value => Number.isSafeInteger(value) && value >= minimum && value <= maximum });
const requestValidators = new Map<string, ValidateFunction>();
const responseRefs = {
  initialize: '#/definitions/InitializeResponse',
  'thread/start': '#/definitions/v2/ThreadStartResponse', 'thread/resume': '#/definitions/v2/ThreadResumeResponse',
  'turn/start': '#/definitions/v2/TurnStartResponse', 'turn/interrupt': '#/definitions/v2/TurnInterruptResponse', 'permissionProfile/list': '#/definitions/v2/PermissionProfileListResponse',
};
const responseValidators = new Map<string, ValidateFunction>();

export function validateNativeParams(method: string, params: unknown): void {
  let validate = requestValidators.get(method);
  if (validate === undefined) {
    const branch = protocolSchema.definitions.ClientRequest.oneOf.find(branch => branch.properties.method.enum[0] === method);
    if (branch === undefined) throw new Error(`Unsupported native method: ${method}`);
    const ref = branch.properties.params.$ref;
    if (ref === undefined) throw new Error(`Missing native schema: ${method}`);
    const definitions = structuredClone(protocolSchema.definitions);
    const path = ref.replace('#/definitions/', '').split('/');
    let definition: unknown = definitions;
    for (const part of path) definition = (definition as Record<string, unknown>)[part];
    // The native exporter allows extra fields in many params. Reject typos at
    // this client's outgoing boundary without modifying the generated schema.
    const parameterSchema = definition as { type?: string; properties?: object; additionalProperties?: boolean };
    if (parameterSchema?.type === 'object' && parameterSchema.properties !== undefined) parameterSchema.additionalProperties = false;
    validate = ajv.compile({ $ref: ref, definitions });
    requestValidators.set(method, validate);
  }
  if (!validate(params)) throw new Error(`Invalid ${method} params: ${ajv.errorsText(validate.errors)}`);
}

export function validateNativeResult(method: keyof Results, result: unknown): void {
  let validate = responseValidators.get(method);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: responseRefs[method], definitions: protocolSchema.definitions });
    responseValidators.set(method, validate);
  }
  if (!validate(result)) throw new Error(`Invalid ${method} result: ${ajv.errorsText(validate.errors)}`);
}

export async function nativeRequest<M extends keyof Results>(rpc: JsonRpcStdio, method: M, params: NativeParams<M>): Promise<Results[M]> {
  validateNativeParams(method, params);
  const result = await rpc.request(method, params);
  validateNativeResult(method, result);
  return result as Results[M];
}
