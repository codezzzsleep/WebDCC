import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readNativeProjection } from '../packages/server/src/native-projection-reader.js';

const { values } = parseArgs({ options: { database: { type: 'string' }, output: { type: 'string' }, session: { type: 'string' }, after: { type: 'string' }, limit: { type: 'string' } } });
if (!values.database || !values.output) throw new Error('Usage: --database <SQLite file> --output <artifact.json> [--session <Web session ID>] [--after <raw ID>] [--limit <1..500>]');
const sourcePath = resolve(values.database); const output = resolve(values.output);
const comparable = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
const sourceTargets = [sourcePath, await realpath(sourcePath)];
let outputTarget = output;
try { outputTarget = join(await realpath(dirname(output)), basename(output)); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (sourceTargets.flatMap(path => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`])
  .some(path => [output, outputTarget].some(target => comparable(path) === comparable(target)))) throw new Error('Projection artifact cannot replace its source database or journal');
const report = readNativeProjection(sourcePath, { sessionId: values.session, after: values.after === undefined ? undefined : Number(values.after), limit: values.limit === undefined ? undefined : Number(values.limit) });
const content = JSON.stringify(report) + '\n';
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const temporary = `${output}.${randomUUID()}.tmp`;
try { await writeFile(temporary, content, { flag: 'wx', mode: 0o600 }); await rename(temporary, output); }
finally { await rm(temporary, { force: true }); }
process.stdout.write(JSON.stringify({ output, sha256: createHash('sha256').update(content).digest('hex'), projectionVersion: report.projectionVersion,
  items: report.items.length, records: report.records.length, next: report.next, hasMore: report.hasMore, complete: report.complete }) + '\n');
