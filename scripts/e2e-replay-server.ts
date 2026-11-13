/** L2 server: the production WebDCC stack with every available trace-backed
 * adapter. It is intentionally separate from scripts/e2e-server.ts, whose
 * FakeAdapter scenarios cover the fast M1/M2 checks. */
import { mkdtempSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReplayAdapter, type ReplayScript } from '../packages/testing/fake-adapter/src/replay.js';
import type { TraceFrame } from '../packages/protocol/src/index.js';
import { CodexAdapter } from '../packages/adapters/codex/src/adapter.js';
import { ClaudeAdapter } from '../packages/adapters/claude/src/adapter.js';
import { DshAdapter } from '../packages/adapters/dsh/src/adapter.js';
import { loadConfig } from '../packages/server/src/config.js';
import { start } from '../packages/server/src/main.js';
import { isolatedEnv } from '../packages/server/src/test-isolation.js';

const { env } = isolatedEnv(process.env, 'wdcc-m9-replay');
process.env['HOME'] = env['HOME'] as string;
process.env['CODEX_HOME'] = env['CODEX_HOME'] as string;
process.env['CLAUDE_CONFIG_DIR'] = env['CLAUDE_CONFIG_DIR'] as string;
process.env['DSH_HOME'] = env['DSH_HOME'] as string;
process.env['WDCC_DATA_DIR'] = env['WDCC_DATA_DIR'] as string;
process.env['WDCC_TEST_HOOKS'] = '1';

const root = process.cwd();
const replayRoot = join(root, 'fixtures', 'traces');
const workspaceDir = mkdtempSync(join(tmpdir(), 'wdcc-m9-replay-workspace-'));
mkdirSync(workspaceDir, { recursive: true });

function framesFor(path: string): TraceFrame[] {
  return readFileSync(join(path, 'native.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as TraceFrame);
}

function scriptsFor(agent: 'codex' | 'claude-code' | 'dsh'): ReplayScript[] {
  const agentRoot = join(replayRoot, agent, 'default');
  const scripts: ReplayScript[] = [];
  for (const scenario of ['S01', 'S02', 'S03', 'S04', 'S05', 'S06', 'S07', 'S08', 'S09', 'S10', 'S11']) {
    const path = join(agentRoot, scenario);
    const meta = JSON.parse(readFileSync(join(path, 'meta.json'), 'utf8')) as { prompt?: string };
    const frames = framesFor(path);
    scripts.push({ key: scenario, prompt: meta.prompt, frames, translate: () => [], createHandler: sessionId => {
      if (agent === 'codex') { const replay = CodexAdapter.replay(sessionId); return { feed: replay.feed, respond: decision => replay.adapter.respond(sessionId, decision), answer: (id, answer) => replay.adapter.answer(sessionId, id, answer) }; }
      if (agent === 'claude-code') { const replay = ClaudeAdapter.replay(sessionId); return { feed: replay.feed, respond: decision => replay.adapter.respond(sessionId, decision), answer: (id, answer) => replay.adapter.answer(sessionId, id, answer) }; }
      const replay = DshAdapter.replay(sessionId); return { feed: replay.feed, respond: decision => replay.adapter.respond(sessionId, decision), answer: (id, answer) => replay.adapter.answer(sessionId, id, answer) };
    } });
  }
  return scripts;
}

const codex = scriptsFor('codex');
const claude = scriptsFor('claude-code');
const dsh = scriptsFor('dsh');
const speed = Number(process.env['WDCC_REPLAY_SPEED'] ?? '20');
const adapters = [
  new ReplayAdapter({ id: 'codex', frames: codex[0]?.frames ?? [], translate: codex[0]?.translate ?? (() => []), replays: codex, speed }),
  new ReplayAdapter({ id: 'claude-code', frames: claude[0]?.frames ?? [], translate: claude[0]?.translate ?? (() => []), replays: claude, speed }),
  new ReplayAdapter({ id: 'dsh', frames: dsh[0]?.frames ?? [], translate: dsh[0]?.translate ?? (() => []), replays: dsh, speed }),
];

const server = await start(loadConfig(), { adapters });
if (server.store.listWorkspaces().length === 0) server.store.createWorkspace('M9 录像工作区', workspaceDir);
process.stdout.write(`m9 replay server: ${server.url}\n`);

const stop = (): void => { void server.close().then(() => process.exit(0)); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
