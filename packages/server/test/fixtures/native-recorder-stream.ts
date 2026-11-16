import '../../src/native-http-recorder.js';
const response = await fetch(process.argv[2]!, { headers: { 'x-webdcc-native-session': 'native-fixture' } });
let bytes = 0; const reader = response.body!.getReader();
for (;;) {
  const next = await reader.read(); if (next.done) break;
  bytes += next.value.length; process.send?.({ read: true });
}
process.send?.({ done: true, bytes }); process.disconnect();
