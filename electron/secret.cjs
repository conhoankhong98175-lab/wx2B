const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');

function encodeSecret(secret, safeStorage) {
  if (!safeStorage?.isEncryptionAvailable()) return secret;
  return `safe.v1.${safeStorage.encryptString(secret).toString('base64')}`;
}

function decodeSecret(value, safeStorage) {
  if (!value.startsWith('safe.v1.')) return value;
  if (!safeStorage?.isEncryptionAvailable()) {
    throw new Error('系统安全存储当前不可用，无法读取本地密钥');
  }
  return safeStorage.decryptString(Buffer.from(value.slice('safe.v1.'.length), 'base64'));
}

function readSecret(path, safeStorage) {
  const stored = readFileSync(path, 'utf8').trim();
  const secret = decodeSecret(stored, safeStorage);
  if (secret.length < 32) throw new Error('本地密钥文件无效，请从备份恢复数据后重试');
  if (!stored.startsWith('safe.v1.') && safeStorage?.isEncryptionAvailable()) {
    const temporaryPath = `${path}.protect-${process.pid}`;
    try {
      writeFileSync(temporaryPath, encodeSecret(secret, safeStorage), {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      renameSync(temporaryPath, path);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return secret;
}

function getOrCreateLocalSecret(userDataPath, options = {}) {
  mkdirSync(userDataPath, { recursive: true });
  const path = join(userDataPath, '.local-secret');
  const { databasePath, safeStorage } = options;
  if (existsSync(path)) return readSecret(path, safeStorage);
  if (databasePath && existsSync(databasePath)) {
    throw new Error('本地数据库存在但密钥文件缺失，请恢复 .local-secret 后重试');
  }
  const secret = randomBytes(48).toString('base64url');
  try {
    writeFileSync(path, encodeSecret(secret, safeStorage), {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
      flush: true,
    });
    return secret;
  } catch (error) {
    if (error && error.code === 'EEXIST') return readSecret(path, safeStorage);
    throw error;
  }
}

module.exports = { getOrCreateLocalSecret };
