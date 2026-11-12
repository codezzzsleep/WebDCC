import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(tmpdir(), `wdcc-accept-build-${Date.now().toString(36)}-${process.pid}`);
const web = join(root, 'web');
const server = join(root, 'server', 'main.js');
mkdirSync(web, { recursive: true });
execFileSync('pnpm', ['--filter', '@webdcc/web', 'build'], { stdio: 'inherit', env: { ...process.env, WDCC_BUILD_DIR: web } });
execFileSync('pnpm', ['tsx', 'scripts/build-server.ts'], { stdio: 'inherit', env: { ...process.env, WDCC_SERVER_OUT: server } });
writeFileSync(join(root, 'build.json'), JSON.stringify({ root, web, server }) + '\n');
process.stdout.write(`${root}\n`);
