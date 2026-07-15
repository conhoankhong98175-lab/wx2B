import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

const source = resolve(process.env.DB_PATH ?? './data/diangao.db');
const destinationDir = resolve(process.env.BACKUP_DIR ?? './backups');
const secret = process.env.BACKUP_SECRET;
if (!secret || secret.length < 16) throw new Error('请配置至少 16 字节的 BACKUP_SECRET');

await mkdir(destinationDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const temporary = resolve(destinationDir, `diangao-${stamp}.db.tmp`);
const encryptedPath = resolve(destinationDir, `diangao-${stamp}.db.enc`);
const encryptedTemporary = `${encryptedPath}.tmp`;
let database = null;
let plain = null;
try {
  await rm(temporary, { force: true });
  await rm(encryptedTemporary, { force: true });
  database = new DatabaseSync(source, { readOnly: true });
  await backup(database, temporary);
  database.close();
  database = null;
  await chmod(temporary, 0o600);

  plain = await readFile(temporary);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const output = Buffer.concat([Buffer.from('DGBAK1'), salt, iv, tag, encrypted]);
  await writeFile(encryptedTemporary, output, { mode: 0o600, flag: 'wx', flush: true });
  await rename(encryptedTemporary, encryptedPath);
  const checksum = createHash('sha256').update(output).digest('hex');
  await writeFile(`${encryptedPath}.sha256`, `${checksum}  ${basename(encryptedPath)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
} finally {
  database?.close();
  plain?.fill(0);
  await rm(temporary, { force: true });
  await rm(encryptedTemporary, { force: true });
}

const retentionDays = Number.parseInt(process.env.BACKUP_RETENTION_DAYS ?? '30', 10);
const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
for (const entry of await readdir(destinationDir, { withFileTypes: true })) {
  if (!entry.isFile() || !/^diangao-.+\.db\.enc(?:\.sha256)?$/.test(entry.name)) continue;
  const metadata = await stat(resolve(destinationDir, entry.name));
  if (metadata.mtimeMs < cutoff) {
    await rm(resolve(destinationDir, entry.name), { force: true });
  }
}

console.log(`加密备份已生成：${encryptedPath}`);
