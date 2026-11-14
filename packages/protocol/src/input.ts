/** Browser input references and their server-resolved native counterparts. */
export type InputIntent = 'send' | 'queue' | 'steer';
export interface InputTextElement { byteRange: { start: number; end: number }; placeholder: string | null }
export interface InputTextPart { type: 'text'; text: string; elements?: InputTextElement[] }
export interface InputAttachmentPart {
  type: 'image' | 'file' | 'audio'; fileId: string; name?: string; mime?: string; sha256?: string; size?: number;
}
export interface InputSkillPart { type: 'skill'; skillId: string; name: string }
export interface InputResourcePart { type: 'resource'; uri: string; server?: string; name?: string }
export type InputPart = InputTextPart | InputAttachmentPart | InputSkillPart | InputResourcePart;
export interface InputContent { version: 1; parts: InputPart[] }
export interface ResolvedInputAttachmentPart extends InputAttachmentPart { path: string; mime: string; name: string; sha256: string; size: number }
export interface ResolvedInputSkillPart extends InputSkillPart { path: string }
export type ResolvedInputPart = InputTextPart | ResolvedInputAttachmentPart | ResolvedInputSkillPart | InputResourcePart;
export interface ResolvedInputContent { version: 1; parts: ResolvedInputPart[] }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const allowed = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).every(key => keys.includes(key));
const controls = (value: string): boolean => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
const name = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 255 && !controls(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
function elements(value: unknown, text: string): boolean {
  const length = new TextEncoder().encode(text).byteLength;
  return Array.isArray(value) && value.length <= 64 && value.every(element => object(element) && allowed(element, ['byteRange', 'placeholder'])
    && object(element['byteRange']) && allowed(element['byteRange'], ['start', 'end'])
    && Number.isSafeInteger(element['byteRange']['start']) && Number.isSafeInteger(element['byteRange']['end'])
    && Number(element['byteRange']['start']) >= 0 && Number(element['byteRange']['start']) <= Number(element['byteRange']['end']) && Number(element['byteRange']['end']) <= length
    && (element['placeholder'] === null || typeof element['placeholder'] === 'string'));
}
/** No browser path, receipt, unknown field or rewritten text may enter a command. */
export function isInputContent(value: unknown, text?: string): value is InputContent {
  if (!object(value) || !allowed(value, ['version', 'parts']) || value['version'] !== 1 || !Array.isArray(value['parts']) || value['parts'].length > 32) return false;
  for (const part of value['parts']) {
    if (!object(part)) return false;
    switch (part['type']) {
      case 'text':
        if (!allowed(part, ['type', 'text', 'elements']) || typeof part['text'] !== 'string' || part['elements'] !== undefined && !elements(part['elements'], part['text'])) return false;
        break;
      case 'image': case 'file': case 'audio':
        if (!allowed(part, ['type', 'fileId', 'name', 'mime', 'sha256', 'size']) || !identifier(part['fileId'])
          || part['name'] !== undefined && !name(part['name'])
          || part['mime'] !== undefined && (typeof part['mime'] !== 'string' || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(part['mime']))
          || part['sha256'] !== undefined && (typeof part['sha256'] !== 'string' || !/^[a-f0-9]{64}$/.test(part['sha256']))
          || part['size'] !== undefined && (!Number.isSafeInteger(part['size']) || Number(part['size']) < 0 || Number(part['size']) > 100 * 1024 * 1024)) return false;
        break;
      case 'skill':
        if (!allowed(part, ['type', 'skillId', 'name']) || !identifier(part['skillId']) || !name(part['name'])) return false;
        break;
      case 'resource':
        if (!allowed(part, ['type', 'uri', 'server', 'name']) || typeof part['uri'] !== 'string' || part['uri'].length === 0 || part['uri'].length > 4096
          || controls(part['uri']) || part['server'] !== undefined && !name(part['server']) || part['name'] !== undefined && !name(part['name'])) return false;
        break;
      default: return false;
    }
  }
  return text === undefined || value['parts'].filter(part => part['type'] === 'text').map(part => part['text']).join('') === text;
}
export function publicInputContent(content: ResolvedInputContent): InputContent {
  return { version: content.version, parts: content.parts.map(part => {
    if (part.type === 'image' || part.type === 'file' || part.type === 'audio') {
      const { path: _path, ...reference } = part; return reference;
    }
    if (part.type === 'skill') { const { path: _path, ...reference } = part; return reference; }
    return structuredClone(part);
  }) };
}
