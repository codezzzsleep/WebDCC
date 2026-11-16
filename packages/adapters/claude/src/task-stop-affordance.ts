import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import verification from './task-stop-verification.json' with { type: 'json' };

let cached: { identity: string; supported: boolean } | undefined;
/** The declaration changes SDK interrupt behavior. Enable it only for the
 * exact native artifact whose real per-task control chain was accepted. */
export function taskStopAffordance(cli: string | undefined, sdkVersion: string): boolean {
  if (!verification.verified || cli === undefined || sdkVersion !== verification.sdkVersion
    || process.platform !== verification.os || process.arch !== verification.arch) return false;
  try {
    const stat = statSync(cli);
    const identity = JSON.stringify([cli, stat.dev, stat.ino, stat.size, stat.mtimeMs, verification.nativeBinarySha256]);
    if (cached?.identity === identity) return cached.supported;
    const supported = createHash('sha256').update(readFileSync(cli)).digest('hex') === verification.nativeBinarySha256;
    cached = { identity, supported };
    return supported;
  } catch { return false; }
}
