import '../../src/native-http-recorder.js';

const response = await fetch(process.argv[2]!, { method: 'POST', headers: { authorization: 'Bearer header-secret', 'x-webdcc-native-session': 'native-fixture', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nested-secret', prompt: 'native input unchanged' }) });
const text = await response.text();
process.send?.({ text });
process.disconnect();
