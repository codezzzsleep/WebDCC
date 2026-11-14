// Use `node --import=tsx scripts/backup.ts ... --key-fd 3 3<key` in source
// checkouts. Wrappers that spawn another process may drop extra descriptors.
import { fstatSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createBackupKeyFile, createEncryptedBackup, inspectEncryptedBackup, openBackupSource, restoreEncryptedBackup } from '../packages/server/src/backup.js';

function argumentsOf(values: string[]): Map<string, string> {
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index++) {
    const key = values[index]!;
    if (!['--data-dir', '--out', '--backup', '--key-fd', '--offline', '--upgrade'].includes(key) || result.has(key)) throw new Error('无效或重复的备份参数');
    if (key === '--offline' || key === '--upgrade') result.set(key, 'true');
    else { const value = values[++index]; if (!value || value.startsWith('--')) throw new Error('备份参数缺少值'); result.set(key, value); }
  }
  return result;
}
function required(args: Map<string, string>, name: string): string { const value = args.get(name); if (!value) throw new Error(`必须显式指定 ${name}`); return value; }
function keyFromDescriptor(value: string): Buffer {
  const fd = Number(value);
  if (!Number.isSafeInteger(fd) || fd < 0) throw new Error('密钥必须来自已打开的文件描述符');
  const stat = fstatSync(fd);
  if (stat.isFile() && (stat.mode & 0o077) !== 0) throw new Error('密钥文件不得允许其他用户读取');
  const bytes = Buffer.alloc(33); let length = 0;
  try {
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (count === 0) break; length += count; }
    if (length !== 32) throw new Error('密钥输入必须恰好是 32 字节');
    return Buffer.from(bytes.subarray(0, 32));
  } finally { bytes.fill(0); }
}

const [operation, ...values] = process.argv.slice(2);
try {
  const args = argumentsOf(values);
  const allowed = operation === 'keygen' ? ['--out'] : operation === 'create' ? ['--data-dir', '--out', '--key-fd', '--offline'] : operation === 'inspect' ? ['--backup', '--key-fd'] : operation === 'restore' ? ['--backup', '--out', '--key-fd', '--upgrade'] : [];
  if ([...args.keys()].some(key => !allowed.includes(key))) throw new Error('该备份操作不接受此参数');
  if (operation === 'keygen') {
    if (args.size !== 1 || !args.has('--out')) throw new Error('keygen 只接受 --out；请将密钥保存在备份目录以外的安全位置');
    await createBackupKeyFile(required(args, '--out')); process.stdout.write('已生成独立的 0600 密钥文件；请分开保存，密钥丢失无法恢复。\n');
  } else if (['create', 'inspect', 'restore'].includes(operation ?? '')) {
    const key = keyFromDescriptor(required(args, '--key-fd'));
    try {
      if (operation === 'create') {
        if (!args.has('--offline')) throw new Error('CLI 备份必须显式指定 --offline；这由操作者保证，并不证明外部写入已停止');
        const dataDir = resolve(required(args, '--data-dir')); const db = openBackupSource(join(dataDir, 'webdcc.db'));
        try { const output = await createEncryptedBackup({ db, dataDir, destination: required(args, '--out'), key, consistency: 'operator-declared-offline', withMetadataSnapshot: capture => capture() }); process.stdout.write(JSON.stringify(output) + '\n'); }
        finally { db.close(); }
      } else if (operation === 'inspect') {
        const manifest = await inspectEncryptedBackup({ backupDir: required(args, '--backup'), key });
        process.stdout.write(JSON.stringify({ valid: true, schemaVersion: manifest.schemaVersion, entries: manifest.entries.length, consistency: manifest.consistency, excluded: manifest.scope.excluded }) + '\n');
      } else {
        const output = await restoreEncryptedBackup({ backupDir: required(args, '--backup'), destination: required(args, '--out'), key, upgradeSchema: args.has('--upgrade') }); process.stdout.write(JSON.stringify(output) + '\n');
      }
    } finally { key.fill(0); }
  } else throw new Error('用法：backup.ts keygen --out <独立密钥文件> | create --data-dir <目录> --out <备份目录> --key-fd <FD> --offline | inspect --backup <目录> --key-fd <FD> | restore --backup <目录> --out <空隔离目录> --key-fd <FD> [--upgrade]');
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : '备份操作失败'}\n`); process.exitCode = 1; }
