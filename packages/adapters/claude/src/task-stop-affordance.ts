import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import verification from './task-stop-verification.json' with { type: 'json' };

let cached: { identity: string; supported: boolean } | undefined;
const require = createRequire(import.meta.url);
/** The declaration changes SDK interrupt behavior. Enable it only for the
 * exact native artifact whose real per-task control chain was accepted. */
export function taskStopAffordance(cli: string | undefined, sdkVersion: string): boolean {
  if (!verification.verified || cli === undefined || sdkVersion !== verification.sdkVersion
    || process.platform !== verification.os || process.arch !== verification.arch) return false;
  try {
    const sdk = require.resolve('@anthropic-ai/claude-agent-sdk');
    const schema = join(dirname(sdk), 'sdk.d.ts');
    const files = [cli, sdk, schema];
    const identity = JSON.stringify([files.map(file => {
      const stat = statSync(file); return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs];
    }), verification.nativeBinarySha256, verification.sdkModuleSha256, verification.sdkSchemaSha256]);
    if (cached?.identity === identity) return cached.supported;
    const hashes = files.map(file => createHash('sha256').update(readFileSync(file)).digest('hex'));
    const supported = hashes[0] === verification.nativeBinarySha256 && hashes[1] === verification.sdkModuleSha256 && hashes[2] === verification.sdkSchemaSha256;
    cached = { identity, supported };
    return supported;
  } catch { return false; }
}
