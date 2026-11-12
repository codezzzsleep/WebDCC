import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DshHomePatchUpdate {
  providerKey: string;
  baseURL: string;
  model: string;
  previousModel?: string;
  reasoning?: string;
  reasoningEfforts?: string[];
  contextWindow?: number;
  maxTokens?: number;
  apiKeyEnv?: string;
}

function yamlScalar(value: string | number): string {
  const text = String(value);
  return /^[A-Za-z0-9._~:/-]+$/.test(text) ? text : JSON.stringify(text);
}

function removeYamlField(lines: string[], field: string, indent: number): string[] {
  const start = lines.findIndex((line) => new RegExp(`^ {${indent}}${field}:`).test(line));
  if (start < 0) return lines;
  let end = start + 1;
  while (end < lines.length && (lines[end]?.trim() === '' || (lines[end]?.startsWith(' '.repeat(indent + 2)) ?? false))) end += 1;
  return [...lines.slice(0, start), ...lines.slice(end)];
}

function setYamlScalarField(lines: string[], field: string, value: string | number, indent: number): string[] {
  const line = `${' '.repeat(indent)}${field}: ${yamlScalar(value)}`;
  const index = lines.findIndex((item) => new RegExp(`^ {${indent}}${field}:`).test(item));
  if (index >= 0) return [...lines.slice(0, index), line, ...lines.slice(index + 1)];
  const anchor = lines.findIndex((item) => new RegExp(`^ {${indent}}models:`).test(item));
  const last = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
  const insertAt = anchor >= 0 ? anchor : last;
  return [...lines.slice(0, insertAt), line, ...lines.slice(insertAt)];
}

function setYamlMapField(lines: string[], field: string, entries: string[], indent: number): string[] {
  const without = removeYamlField(lines, field, indent);
  if (entries.length === 0) return without;
  const index = without.findIndex((item) => new RegExp(`^ {${indent}}(?:${field}|models):`).test(item));
  const at = index >= 0 ? index : without.length;
  return [
    ...without.slice(0, at),
    `${' '.repeat(indent)}${field}:`,
    ...entries.map((entry) => `${' '.repeat(indent + 2)}${yamlScalar(entry)}: ${yamlScalar(entry)}`),
    ...without.slice(at),
  ];
}

function updateModelBlock(providerBlock: string, update: DshHomePatchUpdate): string {
  let lines = providerBlock.split('\n');
  const modelStarts = lines
    .map((line, index) => /^ {10}- id:\s*(.*)$/.exec(line)?.[1] === undefined ? -1 : index)
    .filter((index) => index >= 0);
  if (modelStarts.length === 0) throw new Error('DSH Provider patch 缺少 models');
  const wanted = update.previousModel ?? update.model;
  let modelIndex = modelStarts.find((index) => lines[index]?.trim().slice(5).trim() === wanted);
  if (modelIndex === undefined) modelIndex = modelStarts.find((index) => lines[index]?.trim().slice(5).trim() === update.model);
  if (modelIndex === undefined) {
    const last = modelStarts[modelStarts.length - 1] ?? lines.length - 1;
    let end = last + 1;
    while (end < lines.length && (lines[end]?.trim() === '' || (lines[end]?.startsWith(' '.repeat(12)) ?? false))) end += 1;
    const added = [
      `${' '.repeat(10)}- id: ${yamlScalar(update.model)}`,
      `${' '.repeat(12)}name: ${yamlScalar(update.model)}`,
    ];
    lines = [...lines.slice(0, end), ...added, ...lines.slice(end)];
    modelIndex = end;
  }
  const nextModelStart = lines.findIndex((line, index) => index > modelIndex && /^ {10}- id:/.test(line));
  const modelEnd = nextModelStart < 0 ? lines.length : nextModelStart;
  let model = lines.slice(modelIndex, modelEnd);
  model[0] = `${' '.repeat(10)}- id: ${yamlScalar(update.model)}`;
  const nameIndex = model.findIndex((line) => /^ {12}name:/.test(line));
  if (nameIndex >= 0) model[nameIndex] = `${' '.repeat(12)}name: ${yamlScalar(update.model)}`;
  else model.splice(1, 0, `${' '.repeat(12)}name: ${yamlScalar(update.model)}`);
  model = setYamlMapField(model, 'reasoningEfforts', update.reasoningEfforts ?? [], 12);
  if (update.contextWindow !== undefined) model = setYamlScalarField(model, 'contextWindow', update.contextWindow, 12);
  if (update.maxTokens !== undefined) model = setYamlScalarField(model, 'maxTokens', update.maxTokens, 12);
  return [...lines.slice(0, modelIndex), ...model, ...lines.slice(modelEnd)].join('\n');
}

/**
 * Update the user home patch when DSH reports that settings are overridden by
 * that patch. DSH itself documents this layer as the owner of profile-level
 * provider/default-model configuration; the edit is deliberately limited to
 * the two fields WebDCC exposes and preserves every other line/comment.
 */
export async function updateDshHomePatch(update: DshHomePatchUpdate): Promise<void> {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh');
  const file = join(home, 'cordis.patch.yml');
  const source = await readFile(file, 'utf8');
  const llmStart = source.indexOf('- id: llm-pi-ai');
  const defaultStart = source.indexOf('- id: agent-default-model');
  if (llmStart < 0 || defaultStart < 0 || defaultStart <= llmStart) {
    throw new Error('找不到 DSH 的 llm-pi-ai / agent-default-model home patch');
  }
  const llmBlock = source.slice(llmStart, defaultStart);
  let providerStart = llmBlock.indexOf(`      ${update.providerKey}:`);
  let providerBlockEnd: number;
  let providerBlock: string;
  if (providerStart < 0) {
    const providersLine = llmBlock.indexOf('\n    providers:');
    if (providersLine < 0) throw new Error('DSH home patch 缺少 providers');
    const insertAt = llmBlock.indexOf('\n', providersLine + 1) + 1;
    if (insertAt <= 0) throw new Error('DSH home patch 的 providers 格式无效');
    const apiKeyEnv = update.apiKeyEnv ?? 'OPENAI_API_KEY';
    providerBlock = `      ${update.providerKey}:\n        displayName: ${update.providerKey}\n        apiKeyEnv: ${apiKeyEnv}\n        api: openai-completions\n        baseURL: ${update.baseURL}\n        reasoning: ${update.reasoning ?? 'low'}\n        models:\n          - id: ${update.model}\n            name: ${update.model}\n`;
    providerStart = insertAt;
    providerBlockEnd = insertAt;
  } else {
    const providerTail = llmBlock.slice(providerStart + 1);
    const providerNext = providerTail.search(/\n {6}\S/);
    providerBlockEnd = providerNext < 0 ? llmBlock.length : providerStart + 1 + providerNext + 1;
    providerBlock = llmBlock.slice(providerStart, providerBlockEnd);
  }
  if (update.apiKeyEnv !== undefined) {
    if (/^ {8}apiKeyEnv:/m.test(providerBlock)) providerBlock = providerBlock.replace(/^ {8}apiKeyEnv:.*$/m, `        apiKeyEnv: ${update.apiKeyEnv}`);
    else providerBlock = providerBlock.replace(/^( {8}baseURL:.*)$/m, `        apiKeyEnv: ${update.apiKeyEnv}\n$1`);
  }
  if (!/^ {8}baseURL:/m.test(providerBlock)) throw new Error('DSH Provider patch 缺少 baseURL');
  providerBlock = providerBlock.replace(/^ {8}baseURL:.*$/m, `        baseURL: ${update.baseURL}`);
  if (update.reasoning !== undefined && update.reasoning !== '') {
    providerBlock = providerBlock.replace(/^ {8}reasoning:.*$/m, `        reasoning: ${update.reasoning}`);
    const effortPattern = new RegExp(`^ {10}${update.reasoning.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`, 'm');
    if (!effortPattern.test(providerBlock)) {
      if (/^ {8}reasoningEfforts:/m.test(providerBlock)) {
        providerBlock = providerBlock.replace(/^( {8}reasoningEfforts:\n)/m, `$1          ${update.reasoning}: ${update.reasoning}\n`);
      } else {
        providerBlock = providerBlock.replace(/^( {8}models:)/m, `        reasoningEfforts:\n          ${update.reasoning}: ${update.reasoning}\n$1`);
      }
    }
  }
  if (update.contextWindow !== undefined) {
    const providerLines = setYamlScalarField(providerBlock.split('\n'), 'defaultContextWindow', update.contextWindow, 8);
    providerBlock = providerLines.join('\n');
  }
  if (update.maxTokens !== undefined) {
    const providerLines = setYamlScalarField(providerBlock.split('\n'), 'defaultMaxTokens', update.maxTokens, 8);
    providerBlock = providerLines.join('\n');
  }
  if (update.reasoningEfforts !== undefined) providerBlock = setYamlMapField(providerBlock.split('\n'), 'reasoningEfforts', update.reasoningEfforts, 8).join('\n');
  providerBlock = updateModelBlock(providerBlock, update);
  const nextLlmBlock = `${llmBlock.slice(0, providerStart)}${providerBlock}${llmBlock.slice(providerBlockEnd)}`;
  const defaultBlock = source.slice(defaultStart);
  const nextDefaultBlock = defaultBlock
    .replace(/^ {4}provider:.*$/m, `    provider: ${update.providerKey}`)
    .replace(/^ {4}model:.*$/m, `    model: ${update.model}`);
  const next = `${source.slice(0, llmStart)}${nextLlmBlock}${nextDefaultBlock}`;
  const temp = `${file}.webdcc-${process.pid}.tmp`;
  await writeFile(temp, next, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
  await unlink(temp).catch(() => undefined);
  await chmod(file, 0o600);
}
