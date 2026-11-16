const nativeFetch = globalThis.fetch;
await import('../../src/native-http-recorder.js');
const response = await fetch(process.argv[2]!, { headers: { 'x-webdcc-native-session': 'untouched' } });
process.send?.({ unchanged: nativeFetch === globalThis.fetch, text: await response.text() });
process.disconnect();
