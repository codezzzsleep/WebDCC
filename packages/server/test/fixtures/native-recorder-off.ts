import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticFileWriter } from '@webdcc/model-proxy';

const nativeFetch = globalThis.fetch;
const root = await mkdtemp(join(tmpdir(), 'wdcc-recorder-off-peer-'));
const writer = new DiagnosticFileWriter({ maxActiveQueuedBytes: 8 });
try {
  const first = writer.write(join(root, 'peer.jsonl'), 'peer');
  await import('../../src/native-http-recorder.js');
  await first;
  await writer.write(join(root, 'peer.jsonl'), 'ok');
  const response = await fetch(process.argv[2]!, { headers: { 'x-webdcc-native-session': 'untouched' } });
  process.send?.({ unchanged: nativeFetch === globalThis.fetch, text: await response.text(), peerRecord: await readFile(join(root, 'peer.jsonl'), 'utf8') });
  process.disconnect();
} finally { await writer.flush(); await rm(root, { recursive: true, force: true }); }
