import { Ajv } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { McpServerElicitationRequestParams } from './schema/v2/McpServerElicitationRequestParams.js';
import type { McpServerElicitationRequestResponse } from './schema/v2/McpServerElicitationRequestResponse.js';

const invalid = (message: string): never => { throw Object.assign(new Error(message), { statusCode: 400 }); };
const options = { strictSchema: true, strictTypes: false, allErrors: true, allowUnionTypes: true };
const drafts = { legacy: new Ajv(options), modern: new Ajv2020(options), intermediate: new Ajv2019(options) };
for (const ajv of Object.values(drafts)) {
  ajv.addKeyword('isSecret'); ajv.addKeyword('enumNames');
  ajv.addFormat('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  ajv.addFormat('uri', (value: string) => { try { return Boolean(new URL(value).protocol); } catch { return false; } });
  ajv.addFormat('date', (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
  ajv.addFormat('date-time', (value: string) => /^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)));
  ajv.addFormat('password', () => true);
}

/** Validate against the native request, never a browser-supplied replacement schema. */
export function elicitationResponse(request: McpServerElicitationRequestParams, answer: unknown): McpServerElicitationRequestResponse {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return invalid('表单回应格式无效');
  const result = answer as Record<string, unknown>;
  if (!['accept', 'decline', 'cancel'].includes(String(result['action']))) return invalid('表单动作无效');
  if (Object.keys(result).some(key => !['action', 'content'].includes(key))) return invalid('表单回应包含未知字段');
  const action = result['action'] as McpServerElicitationRequestResponse['action'];
  let content: McpServerElicitationRequestResponse['content'] = null;
  if (action === 'accept' && request.mode !== 'url') {
    const schema = request.requestedSchema;
    if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return invalid('原生表单 schema 暂不可验证');
    let validate;
    const dialect = '$schema' in schema ? String(schema.$schema) : '';
    const ajv = dialect.includes('2020-12') ? drafts.modern : dialect.includes('2019-09') ? drafts.intermediate : drafts.legacy;
    try { validate = ajv.compile(schema); } catch { return invalid('原生表单 schema 暂不可验证'); }
    ajv.removeSchema(schema);
    if (!validate(result['content'])) return invalid(`表单内容不符合原生要求：${ajv.errorsText(validate.errors)}`);
    content = result['content'] as McpServerElicitationRequestResponse['content'];
  } else if (result['content'] !== null && result['content'] !== undefined) return invalid('拒绝、取消或链接回应不能包含表单内容');
  return { action, content, _meta: null };
}
