import { openDb } from '../../src/db.js';

process.once('message', () => {
  const samples: unknown[] = [];
  for (let i = 0; i < 20; i++) {
    try {
      const db = openDb(process.argv[2]!);
      try { samples.push({ i, ok: true, version: db.pragma('user_version', { simple: true }),
        counts: { commands: db.prepare('SELECT count(*) AS n FROM command_journal').get(), inputs: db.prepare('SELECT count(*) AS n FROM input_queue').get() } }); }
      finally { db.close(); }
    } catch (error) {
      const failure = error as { code?: string; message: string; stack?: string };
      samples.push({ i, ok: false, code: failure.code, message: failure.message, stack: failure.stack });
    }
  }
  process.send!({ phase: 'finished', pid: process.pid, samples }, () => process.disconnect());
});
process.send!({ phase: 'ready' });
