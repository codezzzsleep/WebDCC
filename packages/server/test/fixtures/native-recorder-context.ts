import '../../src/native-http-recorder.js';
const response = await fetch(process.argv[2]!, { headers: { 'x-webdcc-native-session': 'native-fixture' } });
process.send?.({ text: await response.text() }); process.disconnect();
