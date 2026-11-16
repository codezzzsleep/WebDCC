import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiagnosticFileWriter, diagnosticWriteQueueBytes, configureDiagnosticWriteQueueBudget } from '../diagnostic-writer.js';
import type * as WriterModule from '../diagnostic-writer.js';

const copy = await import(new URL('../diagnostic-writer.ts?independent-copy', import.meta.url).href) as typeof WriterModule;
const root = process.argv[2]!;
const a = new DiagnosticFileWriter({ maxActiveQueuedBytes: 8 });
const b = new copy.DiagnosticFileWriter();
const errors: string[] = [];
const first = a.write(join(root, 'first.jsonl'), '汉字');
const rejected = b.write(join(root, 'second.jsonl'), 'four', 'append', error => errors.push(error.message));
const pending = [diagnosticWriteQueueBytes(), copy.diagnosticWriteQueueBytes()];
await Promise.all([first, rejected]);
await Promise.all([a.flush(), b.flush()]);
configureDiagnosticWriteQueueBudget(16);
await b.write(join(root, 'second.jsonl'), 'recovered');
process.send?.({ independent: copy.DiagnosticFileWriter !== DiagnosticFileWriter, pending, released: [diagnosticWriteQueueBytes(), copy.diagnosticWriteQueueBytes()], errors,
  contents: [await readFile(join(root, 'first.jsonl'), 'utf8'), await readFile(join(root, 'second.jsonl'), 'utf8')] }, () => process.disconnect?.());
