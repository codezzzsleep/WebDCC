/** Extract only the question-mode contract from the pinned native exporter.
 * Never modify the existing standard schema or enable native feature flags. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const arg = (name: string): string | undefined => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const binaryArg = arg('--binary');
if (!binaryArg) throw new Error('--binary must identify the isolated Codex 0.167.0');
const binary = resolve(binaryArg);
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== 'codex-cli 0.167.0') throw new Error('The question contract requires Codex 0.167.0');
const work = resolve(arg('--work-dir') ?? '.artifacts/codex-question-contract');
await mkdir(work, { recursive: true });
execFileSync(binary, ['app-server', 'generate-json-schema', '--experimental', '--out', join(work, 'json')]);
execFileSync(binary, ['app-server', 'generate-ts', '--experimental', '--out', join(work, 'ts')]);
const bundle = await readFile(join(work, 'json/codex_app_server_protocol.schemas.json'), 'utf8');
const schema = JSON.parse(bundle) as { definitions: Record<string, unknown> };
const lookup = (ref: string): unknown => {
  if (!ref.startsWith('#/definitions/')) throw new Error(`Unexpected native reference: ${ref}`);
  return ref.slice('#/definitions/'.length).split('/').reduce((value, key) => (value as Record<string, unknown>)[key], schema.definitions as unknown);
};
const turn = lookup('#/definitions/v2/TurnStartParams') as { properties: Record<string, unknown> };
if (turn.properties['collaborationMode'] === undefined) throw new Error('Native exporter did not expose collaborationMode');
const definitions: Record<string, unknown> = {};
const pending = ['#/definitions/v2/CollaborationModeListParams', '#/definitions/v2/CollaborationModeListResponse'];
const visited = new Set<string>();
const scan = (value: unknown): void => {
  if (value !== null && typeof value === 'object') {
    if ('$ref' in value && typeof value.$ref === 'string') pending.push(value.$ref);
    for (const child of Object.values(value)) scan(child);
  }
};
scan(turn.properties['collaborationMode']);
while (pending.length) {
  const ref = pending.shift()!;
  if (visited.has(ref)) continue;
  visited.add(ref);
  const definition = lookup(ref);
  if (definition === undefined) throw new Error(`Missing native definition ${ref}`);
  const path = ref.slice('#/definitions/'.length).split('/');
  let parent = definitions;
  for (const key of path.slice(0, -1)) parent = (parent[key] ??= {}) as Record<string, unknown>;
  parent[path.at(-1)!] = definition;
  scan(definition);
}
const contract = {
  provenance: { nativeVersion: '0.167.0', nativeBinarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    nativeSchemaSha256: createHash('sha256').update(bundle).digest('hex'), command: 'codex app-server generate-json-schema --experimental',
    scope: 'Original collaborationMode field and its referenced definitions; original collaborationMode/list request and response.' },
  collaborationMode: turn.properties['collaborationMode'], definitions,
};
const destination = 'packages/adapters/codex/src/schema-experimental';
await mkdir(join(destination, 'v2'), { recursive: true });
const files = ['ModeKind.ts', 'ReasoningEffort.ts', 'v2/CollaborationModeMask.ts', 'v2/CollaborationModeListParams.ts', 'v2/CollaborationModeListResponse.ts'];
const generated = [{ path: join(destination, 'question-modes.schemas.json'), content: JSON.stringify(contract, null, 2) + '\n' }];
for (const path of files) generated.push({ path: join(destination, path), content: await readFile(join(work, 'ts', path), 'utf8') });
for (const file of generated) {
  if (process.argv.includes('--check')) {
    if (await readFile(file.path, 'utf8') !== file.content) throw new Error(`Stale exported question contract: ${file.path}`);
  } else await writeFile(file.path, file.content);
}
process.stdout.write(`Question-mode native contract ${process.argv.includes('--check') ? 'verified' : 'exported'}: ${generated.length} files, ${visited.size} original definitions\n`);
