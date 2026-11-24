import { Ajv, type ValidateFunction } from 'ajv';
import type { ClientRequest } from './schema/ClientRequest.js';
import type { InitializeResponse } from './schema/InitializeResponse.js';
import type { ThreadStartResponse } from './schema/v2/ThreadStartResponse.js';
import type { ThreadResumeResponse } from './schema/v2/ThreadResumeResponse.js';
import type { TurnStartResponse } from './schema/v2/TurnStartResponse.js';
import type { TurnSteerResponse } from './schema/v2/TurnSteerResponse.js';
import type { TurnInterruptResponse } from './schema/v2/TurnInterruptResponse.js';
import type { PermissionProfileListResponse } from './schema/v2/PermissionProfileListResponse.js';
import type { ThreadReadResponse } from './schema/v2/ThreadReadResponse.js';
import type { ThreadTurnsListResponse } from './schema/v2/ThreadTurnsListResponse.js';
import type { ModelListResponse } from './schema/v2/ModelListResponse.js';
import type { ConfigReadResponse } from './schema/v2/ConfigReadResponse.js';
import type { ThreadSettingsUpdatedNotification } from './schema/v2/ThreadSettingsUpdatedNotification.js';
import type { CollaborationMode } from './schema/CollaborationMode.js';
import type { CollaborationModeListParams } from './schema-experimental/v2/CollaborationModeListParams.js';
import type { CollaborationModeListResponse } from './schema-experimental/v2/CollaborationModeListResponse.js';
import questionModeSchema from './schema-experimental/question-modes.schemas.json' with { type: 'json' };
import protocolSchema from './json-schema/codex_app_server_protocol.schemas.json' with { type: 'json' };
import compatibilitySchema from './json-schema/compatibility-0.169.0.schemas.json' with { type: 'json' };
import compatibility172Schema from './json-schema/compatibility-0.172.0.schemas.json' with { type: 'json' };
import type { JsonRpcStdio } from './rpc.js';
import { nativeControlResultRefs, type NativeControlResults } from './native-results.js';

type Method = ClientRequest['method'] | 'collaborationMode/list';
export type NativeParams<M extends Method> = M extends 'collaborationMode/list' ? CollaborationModeListParams
  : M extends 'turn/start' ? Extract<ClientRequest, { method: M }>['params'] & { collaborationMode?: CollaborationMode | null }
  : Extract<ClientRequest, { method: M }>['params'];
interface Results extends NativeControlResults {
  initialize: InitializeResponse;
  'thread/start': ThreadStartResponse;
  'thread/resume': ThreadResumeResponse;
  'turn/start': TurnStartResponse;
  'turn/steer': TurnSteerResponse;
  'turn/interrupt': TurnInterruptResponse;
  'permissionProfile/list': PermissionProfileListResponse;
  'thread/read': ThreadReadResponse;
  'thread/turns/list': ThreadTurnsListResponse;
  'model/list': ModelListResponse;
  'config/read': ConfigReadResponse;
  'collaborationMode/list': CollaborationModeListResponse;
}

const ajv = new Ajv({ strict: false, allErrors: true, allowUnionTypes: true });
for (const [name, minimum, maximum] of [
  ['uint', 0, Number.MAX_SAFE_INTEGER], ['uint8', 0, 255], ['uint16', 0, 65535], ['uint32', 0, 4294967295], ['uint64', 0, Number.MAX_SAFE_INTEGER],
  ['int32', -2147483648, 2147483647], ['int64', Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const) ajv.addFormat(name, { type: 'number', validate: value => Number.isSafeInteger(value) && value >= minimum && value <= maximum });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
const requestValidators = new Map<string, ValidateFunction>();
const responseRefs = {
  ...nativeControlResultRefs,
  initialize: '#/definitions/InitializeResponse',
  'thread/start': '#/definitions/v2/ThreadStartResponse', 'thread/resume': '#/definitions/v2/ThreadResumeResponse',
  'turn/start': '#/definitions/v2/TurnStartResponse', 'turn/interrupt': '#/definitions/v2/TurnInterruptResponse', 'permissionProfile/list': '#/definitions/v2/PermissionProfileListResponse',
  'turn/steer': '#/definitions/v2/TurnSteerResponse',
  'thread/read': '#/definitions/v2/ThreadReadResponse', 'thread/turns/list': '#/definitions/v2/ThreadTurnsListResponse',
  'model/list': '#/definitions/v2/ModelListResponse',
  'config/read': '#/definitions/v2/ConfigReadResponse',
  'collaborationMode/list': '#/definitions/v2/CollaborationModeListResponse',
};
const responseValidators = new Map<string, ValidateFunction>();
const serverValidators = new Map<string, ValidateFunction>();
const modeDefinitions = structuredClone(questionModeSchema.definitions);
for (const name of ['CollaborationMode', 'Settings'] as const) Object.assign(modeDefinitions.v2[name], { additionalProperties: false });
const collaborationModeValidator = ajv.compile({ ...questionModeSchema.collaborationMode, definitions: modeDefinitions });
const settingsValidators = new Map<string, ValidateFunction>();

function incomingSchema(nativeVersion?: string) {
  return nativeVersion === '0.172.0' ? compatibility172Schema : compatibilitySchema;
}

function validatorKey(method: string, nativeVersion?: string): string {
  return `${nativeVersion === '0.172.0' ? '0.172.0' : '0.169.0'}:${method}`;
}

export function nativeSettingsNotification(params: unknown, nativeVersion?: string): ThreadSettingsUpdatedNotification {
  const key = validatorKey('thread/settings/updated', nativeVersion);
  let settingsValidator = settingsValidators.get(key);
  if (settingsValidator === undefined) {
    settingsValidator = ajv.compile({ $ref: '#/definitions/v2/ThreadSettingsUpdatedNotification', definitions: incomingSchema(nativeVersion).definitions });
    settingsValidators.set(key, settingsValidator);
  }
  if (!settingsValidator(params)) throw new Error(`Invalid thread/settings/updated: ${ajv.errorsText(settingsValidator.errors)}`);
  return params as ThreadSettingsUpdatedNotification;
}

export function validateNativeServerParams(method: string, params: unknown, nativeVersion?: string): void {
  const key = validatorKey(method, nativeVersion);
  const schema = incomingSchema(nativeVersion);
  let validate = serverValidators.get(key);
  if (validate === undefined) {
    const branch = schema.definitions.ServerRequest.oneOf.find(branch => branch.properties.method.enum[0] === method);
    if (branch === undefined) throw Object.assign(new Error('Unknown native reverse request'), { code: -32601 });
    validate = ajv.compile({ $ref: branch.properties.params.$ref, definitions: schema.definitions });
    serverValidators.set(key, validate);
  }
  if (!validate(params)) throw Object.assign(new Error(`Invalid ${method} native request: ${ajv.errorsText(validate.errors)}`), { code: -32602 });
}

export function validateNativeParams(method: string, params: unknown): void {
  if (method === 'turn/start' && params !== null && typeof params === 'object' && 'collaborationMode' in params) {
    const { collaborationMode, ...standard } = params;
    validateNativeParams(method, standard);
    if (!collaborationModeValidator(collaborationMode)) throw new Error(`Invalid native collaborationMode: ${ajv.errorsText(collaborationModeValidator.errors)}`);
    return;
  }
  let validate = requestValidators.get(method);
  if (validate === undefined) {
    if (method === 'collaborationMode/list') {
      validate = ajv.compile({ $ref: '#/definitions/v2/CollaborationModeListParams', definitions: questionModeSchema.definitions,
        // The native params are empty; this client must not send arbitrary fields.
        maxProperties: 0 });
      requestValidators.set(method, validate);
    } else {
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
  }
  if (!validate(params)) throw new Error(`Invalid ${method} params: ${ajv.errorsText(validate.errors)}`);
}

export function validateNativeResult(method: keyof Results, result: unknown, nativeVersion?: string): void {
  const key = validatorKey(method, nativeVersion);
  let validate = responseValidators.get(key);
  if (validate === undefined) {
    validate = ajv.compile({ $ref: responseRefs[method], definitions: method === 'collaborationMode/list' ? questionModeSchema.definitions : incomingSchema(nativeVersion).definitions });
    responseValidators.set(key, validate);
  }
  if (!validate(result)) throw new Error(`Invalid ${method} result: ${ajv.errorsText(validate.errors)}`);
}

export async function nativeRequest<M extends keyof Results>(rpc: JsonRpcStdio, method: M, params: NativeParams<M>, timeoutMs?: number): Promise<Results[M]> {
  validateNativeParams(method, params);
  const result = timeoutMs === undefined ? await rpc.request(method, params) : await rpc.request(method, params, timeoutMs);
  validateNativeResult(method, result, rpc.nativeVersion);
  return result as Results[M];
}
