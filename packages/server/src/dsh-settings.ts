import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DshHomePatchUpdate {
  providerKey: string;
  baseURL: string;
  model: string;
  reasoning?: string;
  apiKeyEnv?: string;
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
  }
  if (!/^ {10}- id:/m.test(providerBlock)) throw new Error('DSH Provider patch 缺少 models');
  providerBlock = providerBlock.replace(/^ {10}- id:.*$/m, `          - id: ${update.model}`);
  providerBlock = providerBlock.replace(/^ {12}name:.*$/m, `            name: ${update.model}`);
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
