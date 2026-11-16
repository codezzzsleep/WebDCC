import '../../src/native-http-recorder.js';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
// Hold the isolated child's real FS workers before it reads the ordinary
// context file. This keeps context I/O pending without accepting a FIFO as
// context or changing the native HTTP request/response reader.
const held = process.argv[3] === undefined ? [] : Array.from({ length: 4 }, (_, i) => open(join(process.argv[3]!, `hold-${i}`), 'r').then(handle => handle.close()));
if (held.length > 0) await new Promise<void>(resolve => setTimeout(resolve, 20));
const response = await fetch(process.argv[2]!, { headers: { 'x-webdcc-native-session': 'native-fixture' } });
let bytes = 0; const reader = response.body!.getReader();
for (;;) {
  const next = await reader.read(); if (next.done) break;
  bytes += next.value.length; process.send?.({ read: true });
}
process.send?.({ done: true, bytes }); process.disconnect();
await Promise.all(held);
