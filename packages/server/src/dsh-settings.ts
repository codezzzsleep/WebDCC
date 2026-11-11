import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DshHomePatchUpdate {
  providerKey: string;
  baseURL: string;
  model: string;
  reasoning?: string;
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
  const providerStart = llmBlock.indexOf(`      ${update.providerKey}:`);
  if (providerStart < 0) throw new Error(`DSH home patch 中没有 Provider：${update.providerKey}`);
  const providerTail = llmBlock.slice(providerStart + 1);
  const providerNext = providerTail.search(/\n {6}\S/);
  const providerBlockEnd = providerNext < 0 ? llmBlock.length : providerStart + 1 + providerNext + 1;
  let providerBlock = llmBlock.slice(providerStart, providerBlockEnd);
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
