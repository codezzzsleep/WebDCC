import { DiagnosticFileWriter } from '../diagnostic-writer.js';
const file = process.argv[2]!;
const many = process.argv[3] === 'many';
process.send?.({ ready: true });
process.once('message', async () => {
  const writer = new DiagnosticFileWriter({ maxFileBytes: many ? 1024 * 1024 : 64 });
  const errors: string[] = [];
  const count = many ? 3000 : 1;
  const writes = Array.from({ length: count }, () => writer.write(file, 'x'.repeat(64), 'append', error => errors.push(error.message)));
  await Promise.all(writes); await writer.flush();
  process.send?.({ done: true, errors, pendingBytes: writer.pendingBytes }, () => process.disconnect?.());
});
