/** Export command names and presentation metadata from the pinned TUI source.
 * Execution routes remain handwritten client policy; this is not an RPC catalog. */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const index = process.argv.indexOf('--source');
if (index < 0 || !process.argv[index + 1]) throw new Error('--source must identify Codex rust-v0.167.0 tui/src/slash_command.rs');
const source = await readFile(process.argv[index + 1]!, 'utf8');
const enumeration = source.match(/pub enum SlashCommand \{([\s\S]*?)\n\}/)?.[1];
if (!enumeration) throw new Error('Pinned native SlashCommand enum missing');
const kebab = (value: string): string => value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const commands: { variant: string; name: string; aliases: string[]; description: string; availableDuringTurn: boolean; inlineArguments: boolean }[] = [];
const busy = source.match(/pub fn available_during_task\(self\) -> bool \{([\s\S]*?)\n {4}\}/)?.[1] ?? '';
const blocked = busy.split('=> false')[0] ?? '';
const inline = source.match(/pub fn supports_inline_args\(self\) -> bool \{([\s\S]*?)\n {4}\}/)?.[1] ?? '';
for (const match of enumeration.matchAll(/((?:\s*#\[[^\n]+\]\n)*?)\s*([A-Z][A-Za-z]+),/g)) {
  const attributes = match[1] ?? ''; const variant = match[2]!;
  const named = attributes.match(/to_string\s*=\s*"([^"]+)"/)?.[1];
  const aliases = [...attributes.matchAll(/serialize\s*=\s*"([^"]+)"/g)].map(match => match[1]!);
  const name = named ?? aliases[0] ?? kebab(variant);
  const descriptionMatch = source.match(new RegExp('SlashCommand::' + variant + '\\s*(?:\\|\\s*SlashCommand::[A-Za-z]+\\s*)*=>\\s*(?:\\{\\s*)?"([^"\\n]+)"'));
  commands.push({ variant, name: '/' + name, aliases: aliases.filter(alias => alias !== name).map(alias => '/' + alias),
    description: descriptionMatch?.[1] ?? '原生 ' + name + ' 指令', availableDuringTurn: !new RegExp('SlashCommand::' + variant + '\\b').test(blocked),
    inlineArguments: new RegExp('SlashCommand::' + variant + '\\b').test(inline) });
}
if (commands.length < 50 || new Set(commands.map(command => command.name)).size !== commands.length || !commands.some(command => command.name === '/goal')) throw new Error('Incomplete native command export');
const output = JSON.stringify({ nativeVersion: '0.167.0', sourceUrl: 'https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/tui/src/slash_command.rs', sourceSha256: createHash('sha256').update(source).digest('hex'), commands }, null, 2) + '\n';
const destination = 'packages/adapters/codex/src/slash-catalog.json';
if (process.argv.includes('--check')) { if (await readFile(destination, 'utf8') !== output) throw new Error('Native command export differs from pinned source'); }
else await writeFile(destination, output);
process.stdout.write('Pinned native slash commands: ' + commands.length + '\n');
