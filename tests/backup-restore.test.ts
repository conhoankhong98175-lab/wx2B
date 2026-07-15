import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('加密备份与恢复', () => {
  it('完成在线备份、完整性校验和原子恢复且不残留明文临时库', () => {
    const directory = mkdtempSync(join(tmpdir(), 'diangao-backup-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'diangao.db');
    const backupDirectory = join(directory, 'backups');
    const secret = 'independent-backup-secret-for-tests';
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES ('before-backup')");
    database.close();

    const backup = spawnSync(process.execPath, [resolve('scripts/backup.mjs')], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        DB_PATH: databasePath,
        BACKUP_DIR: backupDirectory,
        BACKUP_SECRET: secret,
      },
      encoding: 'utf8',
    });
    expect(backup.status, backup.stderr).toBe(0);
    const files = readdirSync(backupDirectory);
    const encryptedName = files.find((name) => name.endsWith('.db.enc'));
    expect(encryptedName).toBeTruthy();
    expect(files).toContain(`${encryptedName}.sha256`);
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false);

    const changed = new DatabaseSync(databasePath);
    changed.prepare("UPDATE marker SET value = 'after-backup'").run();
    changed.close();

    const restore = spawnSync(
      process.execPath,
      [resolve('scripts/restore.mjs'), join(backupDirectory, encryptedName!), '--confirm'],
      {
        cwd: resolve('.'),
        env: { ...process.env, DB_PATH: databasePath, BACKUP_SECRET: secret },
        encoding: 'utf8',
      },
    );
    expect(restore.status, restore.stderr).toBe(0);
    const restored = new DatabaseSync(databasePath, { readOnly: true });
    expect(restored.prepare('SELECT value FROM marker').get()?.value).toBe('before-backup');
    restored.close();
    expect(readdirSync(directory).some((name) => name.includes('.restore'))).toBe(false);
  });
});
