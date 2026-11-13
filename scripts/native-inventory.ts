import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const codexPath = 'packages/adapters/codex/src/json-schema/codex_app_server_protocol.schemas.json';
const dshPath = 'fixtures/dsh/host-api-catalog.json';
const sdkPath = join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'sdk.d.ts');
const [codexText, dshText, sdkText] = await Promise.all([readFile(codexPath, 'utf8'), readFile(dshPath, 'utf8'), readFile(sdkPath, 'utf8')]);
type Entry = { agent: string; method: string; role: 'action' | 'observation' | 'internal'; capabilityId: string; reason?: string };
const entries: Entry[] = [];
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const codex = JSON.parse(codexText) as { definitions: Record<string, { oneOf?: { properties: { method: { enum: string[] } } }[] }> };
for (const [name, role] of [['ClientRequest', 'action'], ['ServerRequest', 'action'], ['ServerNotification', 'observation']] as const) {
  for (const branch of codex.definitions[name]?.oneOf ?? []) {
    const method = branch.properties.method.enum[0];
    if (method === undefined) throw new Error(`Missing method in ${name}`);
    const internal = ['initialize', 'attestation/generate', 'account/chatgptAuthTokens/refresh'].includes(method);
    entries.push({ agent: 'codex', method, role: internal ? 'internal' : role, capabilityId: `codex.${method.split('/')[0]}`, ...(internal ? { reason: 'Transport or managed authentication helper; no separate user action.' } : {}) });
  }
}
const dsh = JSON.parse(dshText) as { endpoints: Record<string, { description?: string }> };
for (const method of Object.keys(dsh.endpoints)) entries.push({ agent: 'dsh', method, role: 'action', capabilityId: `dsh.${method.split('/')[0]}` });
const sdk = ts.createSourceFile(sdkPath, sdkText, ts.ScriptTarget.Latest, true);
for (const statement of sdk.statements) {
  const members = ts.isInterfaceDeclaration(statement) ? statement.members : ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type) ? statement.type.members : undefined;
  if (members !== undefined && (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && ['Query', 'Options'].includes(statement.name.text)) {
    for (const member of members) {
      if (member.name === undefined || !ts.isIdentifier(member.name)) continue;
      const method = `${statement.name.text}.${member.name.text}`;
      entries.push({ agent: 'claude-code', method, role: 'action', capabilityId: `claude-code.${statement.name.text === 'Options' ? 'configuration' : member.name.text}` });
    }
  } else if (ts.isFunctionDeclaration(statement) && statement.name !== undefined && statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
    const method = statement.name.text;
    entries.push({ agent: 'claude-code', method, role: 'action', capabilityId: `claude-code.${method}` });
  }
}
for (const agent of ['codex', 'claude-code']) entries.push({ agent, method: 'native-cli-surface', role: 'action', capabilityId: `${agent}.native-cli` });
entries.push({ agent: 'dsh', method: 'native-web-surface', role: 'action', capabilityId: 'dsh.native-web' });
const inventory = {
  formatVersion: 1,
  baseline: { codex: '0.167.0', 'claude-code': '0.3.322', claudeCli: '2.1.322', dsh: '0.2.2-rc.1', os: 'linux' },
  sources: { codex: { path: codexPath, sha256: hash(codexText) }, dsh: { path: dshPath, sha256: hash(dshText) }, claude: { path: '@anthropic-ai/claude-agent-sdk/sdk.d.ts', sha256: hash(sdkText) } },
  entries: entries.sort((a, b) => `${a.agent}:${a.method}`.localeCompare(`${b.agent}:${b.method}`)),
};
const output = JSON.stringify(inventory, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile('packages/server/src/native-inventory.json', 'utf8') !== output) throw new Error('Native inventory or schema fingerprint changed; perform an explicit compatibility review.');
} else await writeFile('packages/server/src/native-inventory.json', output);
process.stdout.write(`Frozen native inventory: ${entries.length} entries\n`);
