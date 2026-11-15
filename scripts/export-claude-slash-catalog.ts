/** Read presentation metadata from the pinned native bundle without evaluating
 * it. SDK discovery remains authoritative for dynamic skills and input routes. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import ts from 'typescript';

const index = process.argv.indexOf('--binary');
if (index < 0 || !process.argv[index + 1]) throw new Error('--binary must identify the pinned Claude CLI 2.1.322');
const binary = process.argv[index + 1]!;
if (execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim() !== '2.1.322 (Claude Code)') throw new Error('Unexpected native CLI version');
const bytes = await readFile(binary); const source = bytes.toString('utf8');
const commands = new Map<string, { name: string; aliases: string[]; description: string; argumentHint?: string }>();
const offsets = new Set<number>();
for (const match of source.matchAll(/\{type:"(?:local-jsx|local)",name:"([a-z][a-z0-9-]*)"/g)) offsets.add(match.index);
// Native objects also put `name` before `type` or after their description.
// Find the enclosing top-level declaration rather than assume field order.
for (const match of source.matchAll(/name:"[a-z][a-z0-9-]*"/g)) {
  const start = Math.max(0, match.index - 5_000); const preceding = source.slice(start, match.index);
  const declaration = [...preceding.matchAll(/\bvar [\w$]+=\{/g)].at(-1);
  if (declaration) offsets.add(start + declaration.index + declaration[0].length - 1);
}
for (const offset of [...offsets].sort((a, b) => a - b)) {
  // The parser bounds each object, so metadata cannot bleed into the next
  // command. Getters and availability predicates are deliberately not run.
  const file = ts.createSourceFile('native-command.js', 'const command=' + source.slice(offset, offset + 20_000), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) throw new Error('Native command object missing');
  const object = declaration.declarationList.declarations[0]?.initializer;
  if (!object || !ts.isObjectLiteralExpression(object)) throw new Error('Native command metadata is not an object');
  const property = (key: string) => object.properties.find(value => ts.isPropertyAssignment(value) && value.name.getText(file) === key);
  const literal = (key: string): string | undefined => { const value = property(key); return value && ts.isPropertyAssignment(value) && ts.isStringLiteral(value.initializer) ? value.initializer.text : undefined; };
  const aliases = property('aliases');
  const name = literal('name'); const type = literal('type');
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name) || !['local-jsx', 'local', 'prompt'].includes(type ?? '')) continue;
  if (type === 'prompt' && literal('source') !== 'builtin') continue;
  // Prefer the first native declaration (the CLI variant precedes SDK-only
  // variants). Dynamic descriptions are labeled by their native identity.
  if (!commands.has(name)) commands.set(name, { name: '/' + name,
    aliases: aliases && ts.isPropertyAssignment(aliases) && ts.isArrayLiteralExpression(aliases.initializer) ? aliases.initializer.elements.filter(ts.isStringLiteral).map(value => '/' + value.text) : [],
    description: literal('description') ?? `Claude CLI 原生 ${name} 指令`,
    ...(literal('argumentHint') ? { argumentHint: literal('argumentHint') } : {}) });
}
if (commands.size < 80 || !['login', 'permissions', 'resume', 'theme'].every(name => commands.has(name))) throw new Error('Incomplete native CLI command export');
const output = JSON.stringify({ nativeVersion: '2.1.322', source: 'Installed official Claude CLI embedded command definitions (local/local-jsx/builtin prompt)',
  binarySha256: createHash('sha256').update(bytes).digest('hex'), availability: 'Native account/platform/configuration predicates are evaluated by the CLI', commands: [...commands.values()] }, null, 2) + '\n';
const destination = 'packages/adapters/claude/src/slash-catalog.json';
if (process.argv.includes('--check')) { if (await readFile(destination, 'utf8') !== output) throw new Error('Native command export differs from pinned binary'); }
else await writeFile(destination, output);
process.stdout.write(`Pinned Claude CLI slash commands: ${commands.size}\n`);
