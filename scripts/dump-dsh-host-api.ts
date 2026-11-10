/**
 * 把 DSH 各包的 typert 声明（`lib/typert.host.js` 里的 TYPERT 对象）导出成一份 API 目录。
 *
 * 用途：M0 核实 DSH Host API 的方法名、参数、返回类型；M5 实现 DshAdapter 时直接查这份目录。
 * 用法：pnpm tsx scripts/dump-dsh-host-api.ts [--out fixtures/dsh/host-api-catalog.json]
 */
import { readdir, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ParameterDescriptor {
  name?: string;
  wire?: string;
  description?: string;
  jsonSchema?: unknown;
  strictCodec?: { jsonSchema?: unknown };
  source?: string;
}

interface Invocation {
  service?: string;
  namespace?: string;
  method?: string;
  id?: string;
  description?: string;
  parameters?: ParameterDescriptor[];
  result?: { description?: string; spec?: { jsonSchema?: unknown } };
  invocation?: { kind?: string };
  stream?: unknown;
  sourceLocation?: { file?: string; line?: number };
}

interface TypertModule {
  package?: string;
  invocations?: Invocation[];
}

function dshPackagesRoot(): string {
  const candidates = [
    '/opt/node-v26.13.0-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai',
    resolve(process.cwd(), 'node_modules/@deepseek-ai'),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error('找不到已安装的 DSH 包目录（先安装 dsh）');
}

async function main(): Promise<void> {
  const root = dshPackagesRoot();
  const entries = await readdir(root, { withFileTypes: true });
  const catalog: Record<string, { package: string; description?: string; kind?: string; parameters: unknown; result?: unknown; source?: unknown }> = {};
  const packages: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = join(root, entry.name, 'lib/typert.host.js');
    if (!existsSync(file)) continue;
    packages.push(entry.name);
    const mod = (await import(pathToFileURL(file).href)) as { TYPERT?: TypertModule };
    const typert = mod.TYPERT;
    if (typert === undefined) continue;
    const invocations = typert.invocations;
    if (!Array.isArray(invocations)) continue;
    for (const invocation of invocations) {
      const endpoint = `${invocation.namespace ?? '?'}/${invocation.method ?? '?'}`;
      catalog[endpoint] = {
        package: typert.package ?? entry.name,
        description: invocation.description,
        kind: invocation.invocation?.kind,
        parameters: (invocation.parameters ?? []).map((p) => ({
          name: p.wire ?? p.name,
          description: p.description,
          jsonSchema: p.strictCodec?.jsonSchema ?? p.jsonSchema,
        })),
        result: invocation.result?.spec?.jsonSchema ?? invocation.result,
        source: invocation.sourceLocation,
      };
    }
  }

  const outIndex = process.argv.indexOf('--out');
  const outPath = outIndex === -1 ? 'fixtures/dsh/host-api-catalog.json' : (process.argv[outIndex + 1] ?? 'fixtures/dsh/host-api-catalog.json');
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), packages: packages.length, endpoints: catalog }, null, 2)}\n`, 'utf8');

  const names = Object.keys(catalog).sort();
  process.stdout.write(`从 ${packages.length} 个包里导出 ${names.length} 个 Host API 端点 → ${outPath}\n`);
  process.stdout.write(`${names.join('\n')}\n`);
}

await main();
