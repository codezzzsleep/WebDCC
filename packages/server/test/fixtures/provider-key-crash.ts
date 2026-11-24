import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../src/db.js';
import { Store } from '../../src/store.js';
import { ProviderRegistry } from '../../src/providers.js';
const directory = process.argv[2]!;
const store = new Store(openDb(join(directory, 'source.sqlite')));
const registry = new ProviderRegistry(store, directory); await registry.init();
const provider = await registry.create({ name: 'fixture', baseUrl: 'https://fixture.invalid', protocols: ['openai-responses'], models: [], apiKey: 'sk-wdcc-test-old' });
store.updateProvider = () => {
  writeFileSync(join(directory, 'staged.json'), JSON.stringify({ providerId: provider.id }));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('Unreachable crash fixture');
};
await registry.update(provider.id, { apiKey: 'sk-wdcc-test-new' });
