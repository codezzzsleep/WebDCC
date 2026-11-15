import { resolve } from 'node:path';
import { ensureNativeTestBaseline } from './lib/native-test-baseline.js';

const args = process.argv.slice(2);
function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error(`${name} 需要路径`);
  return args[index + 1];
}
for (let index = 0; index < args.length; index += 2) if (!['--archive', '--binary', '--root'].includes(args[index]!)) throw new Error('未知基线安装参数');
const result = await ensureNativeTestBaseline({ root: resolve(option('--root') ?? '.artifacts/native-baseline'),
  archive: option('--archive'), binary: option('--binary') ?? process.env['WDCC_CODEX_BASELINE_BINARY'] });
process.stdout.write(`${JSON.stringify({ ...result, modelRequests: 'not-performed', productionCliChanged: false }, null, 2)}\n`);
