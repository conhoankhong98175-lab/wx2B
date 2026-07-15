import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';

import { AppDatabase } from '../server/database.ts';
import { decryptText, encryptText } from '../server/security.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createLegacyDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'diangao-migration-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'legacy.db');
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO schema_migrations(version, applied_at) VALUES (1, '2025-01-01T00:00:00.000Z');

    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      cost_price TEXT
    ) STRICT;
    INSERT INTO products(id, cost_price) VALUES ('product-1', '15.25');

    CREATE TABLE quotes (
      id TEXT PRIMARY KEY,
      draft_encrypted TEXT,
      current_version INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE quote_versions (
      id TEXT PRIMARY KEY,
      quote_id TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      snapshot_encrypted TEXT NOT NULL,
      calculation_schema_version INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      total_fen INTEGER NOT NULL,
      valid_until TEXT NOT NULL,
      token_nonce TEXT NOT NULL,
      published_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE quote_actions (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      request_id TEXT NOT NULL,
      anonymous_id_hash TEXT NOT NULL DEFAULT '',
      message_encrypted TEXT NOT NULL DEFAULT '',
      user_agent_summary TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    ) STRICT;
  `);
  database.close();
  return { directory, path };
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

describe('database migrations', () => {
  it('backs up and upgrades a legacy v1 database without losing cost data', () => {
    const { directory, path } = createLegacyDatabase();
    const secret = 'migration-test-secret-that-is-longer-than-32-bytes';

    const database = new AppDatabase(path, secret);
    try {
      const encrypted = String(
        database.raw.prepare("SELECT cost_price FROM products WHERE id = 'product-1'").get()
          ?.cost_price,
      );

      expect(columnNames(database.raw, 'quotes')).toContain('draft_revision');
      expect(columnNames(database.raw, 'quote_actions')).toContain('request_hash');
      expect(
        database.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      ).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }]);
      expect(encrypted).toMatch(/^v1\./);
      expect(decryptText(encrypted, secret)).toBe('15.25');
      expect(database.migrationBackupPath).toBeTruthy();
    } finally {
      database.close();
    }

    expect(() => new AppDatabase(path, 'wrong-secret-that-is-still-long-enough')).toThrow(
      'APP_SECRET 与数据库不匹配',
    );

    const backupName = readdirSync(directory).find((name) => name.endsWith('.bak.enc'));
    expect(backupName).toBeTruthy();
    const backup = readFileSync(join(directory, backupName!));
    expect(backup.subarray(0, 6).toString()).toBe('DGMIG1');
    expect(backup.includes(Buffer.from('15.25'))).toBe(false);
  });

  it('rolls back structural changes when plaintext migration has no secret', () => {
    const { directory, path } = createLegacyDatabase();

    expect(() => new AppDatabase(path)).toThrow('必须提供 APP_SECRET');

    const database = new DatabaseSync(path);
    expect(columnNames(database, 'quotes')).not.toContain('draft_revision');
    expect(database.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
    ]);
    expect(
      database.prepare("SELECT cost_price FROM products WHERE id = 'product-1'").get()?.cost_price,
    ).toBe('15.25');
    database.close();
    expect(readdirSync(directory).some((name) => name.endsWith('.bak'))).toBe(false);
  });

  it('rejects a wrong secret before migrating a legacy database with encrypted drafts', () => {
    const { directory, path } = createLegacyDatabase();
    const correctSecret = 'correct-legacy-secret-that-is-longer-than-32-bytes';
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE products SET cost_price = NULL WHERE id = 'product-1'").run();
    legacy
      .prepare('INSERT INTO quotes(id, draft_encrypted, current_version) VALUES (?, ?, 0)')
      .run('quote-1', encryptText('{"customerName":"legacy"}', correctSecret));
    legacy.close();

    expect(() => new AppDatabase(path, 'wrong-legacy-secret-that-is-longer-than-32-bytes')).toThrow(
      'APP_SECRET 与现有加密数据不匹配',
    );

    const unchanged = new DatabaseSync(path);
    expect(unchanged.prepare('SELECT version FROM schema_migrations').all()).toEqual([
      { version: 1 },
    ]);
    unchanged.close();
    expect(readdirSync(directory).some((name) => name.includes('.migration-'))).toBe(false);
  });
});
