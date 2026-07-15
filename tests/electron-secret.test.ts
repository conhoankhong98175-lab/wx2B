import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { getOrCreateLocalSecret } = require('../electron/secret.cjs') as {
  getOrCreateLocalSecret: (
    userDataPath: string,
    options?: {
      databasePath?: string;
      safeStorage?: {
        isEncryptionAvailable: () => boolean;
        encryptString: (value: string) => Buffer;
        decryptString: (value: Buffer) => string;
      };
    },
  ) => string;
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), '店告 密钥-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('Electron local secret', () => {
  it('creates once and reuses the same secret', () => {
    const directory = temporaryDirectory();

    const first = getOrCreateLocalSecret(directory);
    const second = getOrCreateLocalSecret(directory);

    expect(first).toHaveLength(64);
    expect(second).toBe(first);
    expect(readFileSync(join(directory, '.local-secret'), 'utf8')).toBe(first);
  });

  it('fails closed when an existing secret file is invalid', () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, '.local-secret'), '');

    expect(() => getOrCreateLocalSecret(directory)).toThrow('本地密钥文件无效');
  });

  it('does not replace a missing key when a database already exists', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'data', 'diangao.db');
    mkdirSync(join(directory, 'data'));
    writeFileSync(databasePath, 'existing database', { flag: 'wx' });

    expect(() => getOrCreateLocalSecret(directory, { databasePath })).toThrow(
      '数据库存在但密钥文件缺失',
    );
  });

  it('reuses the key when both the key and database already exist', () => {
    const directory = temporaryDirectory();
    const databasePath = join(directory, 'diangao.db');
    const first = getOrCreateLocalSecret(directory, { databasePath });
    writeFileSync(databasePath, 'existing database', { flag: 'wx' });

    expect(getOrCreateLocalSecret(directory, { databasePath })).toBe(first);
  });

  it('stores new secrets with the supplied operating-system protector', () => {
    const directory = temporaryDirectory();
    const safeStorage = {
      isEncryptionAvailable: () => true,
      encryptString: (value: string) => Buffer.from(`protected:${value}`),
      decryptString: (value: Buffer) => value.toString().replace(/^protected:/, ''),
    };

    const first = getOrCreateLocalSecret(directory, { safeStorage });
    const stored = readFileSync(join(directory, '.local-secret'), 'utf8');
    const second = getOrCreateLocalSecret(directory, { safeStorage });

    expect(stored).toMatch(/^safe\.v1\./);
    expect(stored).not.toContain(first);
    expect(second).toBe(first);
  });
});
