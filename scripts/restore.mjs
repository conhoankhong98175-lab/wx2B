import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [backupArgument, confirmation] = process.argv.slice(2);
if (!backupArgument || confirmation !== '--confirm') {
  throw new Error('用法：npm run restore -- <备份.db.enc> --confirm；恢复前必须停止服务');
}
const source = resolve(backupArgument);
const target = resolve(process.env.DB_PATH ?? './data/diangao.db');
const temporary = `${target}.restore.tmp`;
const rollback = `${target}.restore-rollback.tmp`;
const encrypted = await readFile(source);
const format = encrypted.subarray(0, 6).toString();
let iv;
let tag;
let body;
let key;
if (format === 'DGBAK1') {
  const secret = process.env.BACKUP_SECRET;
  if (!secret) throw new Error('请配置创建备份时使用的 BACKUP_SECRET');
  const salt = encrypted.subarray(6, 22);
  iv = encrypted.subarray(22, 34);
  tag = encrypted.subarray(34, 50);
  body = encrypted.subarray(50);
  key = scryptSync(secret, salt, 32);
} else if (format === 'DGMIG1') {
  const secret = process.env.APP_SECRET;
  if (!secret) throw new Error('恢复迁移前备份必须配置原 APP_SECRET');
  iv = encrypted.subarray(6, 18);
  tag = encrypted.subarray(18, 34);
  body = encrypted.subarray(34);
  key = createHash('sha256').update(`diangao-migration-backup:${secret}`).digest();
} else {
  throw new Error('备份文件格式无效');
}

const decipher = createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const plain = Buffer.concat([decipher.update(body), decipher.final()]);
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
await rm(temporary, { force: true });
await rm(rollback, { force: true });
try {
  await writeFile(temporary, plain, { mode: 0o600, flag: 'wx', flush: true });
  const database = new DatabaseSync(temporary, { readOnly: true });
  try {
    const check = database.prepare('PRAGMA quick_check').get();
    if (check?.quick_check !== 'ok') throw new Error('备份数据库完整性检查失败');
  } finally {
    database.close();
  }

  let originalMoved = false;
  try {
    await rename(target, rollback);
    originalMoved = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    if (originalMoved) await rename(rollback, target);
    throw error;
  }
  if (originalMoved) await rm(rollback, { force: true });
} finally {
  plain.fill(0);
  await rm(temporary, { force: true });
  await rm(rollback, { force: true });
}
console.log(`恢复完成：${target}`);
