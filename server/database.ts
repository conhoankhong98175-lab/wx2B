import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { decryptText, encryptText } from './security.ts';

interface Migration {
  version: number;
  apply: (database: DatabaseSync, appSecret?: string) => void;
}

function hasColumn(database: DatabaseSync, table: string, column: string): boolean {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => String(row.name) === column);
}

function hasTable(database: DatabaseSync, table: string): boolean {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function encryptMigrationBackup(plain: Buffer, appSecret: string): Buffer {
  const iv = randomBytes(12);
  const key = createHash('sha256').update(`diangao-migration-backup:${appSecret}`).digest();
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from('DGMIG1'), iv, cipher.getAuthTag(), body]);
}

function verifyExistingEncryptedValues(database: DatabaseSync, appSecret: string): void {
  const candidates: Array<{ table: string; column: string }> = [
    { table: 'products', column: 'cost_price' },
    { table: 'merchants', column: 'contact_phone_encrypted' },
    { table: 'merchants', column: 'contact_wechat_encrypted' },
    { table: 'quotes', column: 'customer_contact_encrypted' },
    { table: 'quotes', column: 'draft_encrypted' },
    { table: 'quote_versions', column: 'snapshot_encrypted' },
    { table: 'quote_actions', column: 'message_encrypted' },
  ];
  for (const candidate of candidates) {
    if (!hasTable(database, candidate.table)) continue;
    if (!hasColumn(database, candidate.table, candidate.column)) continue;
    const row = database
      .prepare(
        `SELECT ${candidate.column} AS encrypted_value FROM ${candidate.table}
         WHERE ${candidate.column} IS NOT NULL AND ${candidate.column} <> '' LIMIT 1`,
      )
      .get();
    if (!row) continue;
    const value = String(row.encrypted_value);
    if (candidate.column === 'cost_price' && !value.startsWith('v1.')) continue;
    try {
      decryptText(value, appSecret);
    } catch {
      throw new Error('APP_SECRET 与现有加密数据不匹配，请恢复正确密钥后重试');
    }
  }
}

const MIGRATIONS: ReadonlyArray<Migration> = [
  {
    version: 1,
    apply: (database) =>
      database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        wechat_openid TEXT UNIQUE,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE merchants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        logo_url TEXT NOT NULL DEFAULT '',
        contact_name TEXT NOT NULL DEFAULT '',
        contact_phone_encrypted TEXT NOT NULL DEFAULT '',
        contact_wechat_encrypted TEXT NOT NULL DEFAULT '',
        default_valid_days INTEGER NOT NULL DEFAULT 7 CHECK (default_valid_days BETWEEN 1 AND 365),
        default_delivery_period TEXT NOT NULL DEFAULT '',
        default_terms TEXT NOT NULL DEFAULT '',
        rounding_mode TEXT NOT NULL DEFAULT 'CENT' CHECK (rounding_mode IN ('CENT', 'JIAO', 'YUAN')),
        timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
        onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
        quote_sequence INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE memberships (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'QUOTER')),
        can_view_cost INTEGER NOT NULL DEFAULT 1 CHECK (can_view_cost IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, merchant_id)
      ) STRICT;

      CREATE TABLE product_categories (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (merchant_id, name)
      ) STRICT;

      CREATE INDEX idx_categories_merchant_sort
        ON product_categories(merchant_id, enabled, sort_order, name);

      CREATE TABLE products (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        category_id TEXT REFERENCES product_categories(id) ON DELETE SET NULL,
        code TEXT NOT NULL DEFAULT '',
        name TEXT NOT NULL,
        formula_type TEXT NOT NULL CHECK (formula_type IN ('FIXED', 'QUANTITY', 'AREA')),
        unit TEXT NOT NULL,
        sale_price TEXT NOT NULL,
        cost_price TEXT,
        minimum_charge TEXT NOT NULL DEFAULT '0',
        loss_rate TEXT NOT NULL DEFAULT '0',
        notes TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        is_demo INTEGER NOT NULL DEFAULT 0 CHECK (is_demo IN (0, 1)),
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (merchant_id, code)
      ) STRICT;

      CREATE INDEX idx_products_merchant_name
        ON products(merchant_id, enabled, name);
      CREATE INDEX idx_products_recent
        ON products(merchant_id, last_used_at DESC);

      CREATE TABLE addons (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        pricing_type TEXT NOT NULL CHECK (pricing_type IN ('FIXED', 'QUANTITY', 'AREA', 'PERCENT')),
        unit TEXT NOT NULL,
        price TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (merchant_id, name)
      ) STRICT;

      CREATE INDEX idx_addons_merchant_name
        ON addons(merchant_id, enabled, name);

      CREATE TABLE quotes (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        quote_number TEXT NOT NULL,
        customer_name TEXT NOT NULL,
        customer_contact_encrypted TEXT NOT NULL DEFAULT '',
        project_name TEXT NOT NULL DEFAULT '',
        draft_encrypted TEXT,
        draft_version INTEGER,
        current_version INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        UNIQUE (merchant_id, quote_number)
      ) STRICT;

      CREATE INDEX idx_quotes_merchant_updated
        ON quotes(merchant_id, archived_at, updated_at DESC);
      CREATE INDEX idx_quotes_search
        ON quotes(merchant_id, quote_number, customer_name, project_name);

      CREATE TABLE quote_versions (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
        version_number INTEGER NOT NULL CHECK (version_number > 0),
        state TEXT NOT NULL CHECK (state IN ('ACTIVE', 'CHANGE_REQUESTED', 'ACCEPTED', 'EXPIRED', 'WITHDRAWN', 'SUPERSEDED')),
        snapshot_encrypted TEXT NOT NULL,
        calculation_schema_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        total_fen INTEGER NOT NULL CHECK (total_fen >= 0),
        valid_until TEXT NOT NULL,
        token_nonce TEXT NOT NULL UNIQUE,
        published_at TEXT NOT NULL,
        first_viewed_at TEXT,
        last_viewed_at TEXT,
        view_count INTEGER NOT NULL DEFAULT 0 CHECK (view_count >= 0),
        accepted_at TEXT,
        superseded_by_version INTEGER,
        withdrawn_at TEXT,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (quote_id, version_number)
      ) STRICT;

      CREATE INDEX idx_versions_quote_version
        ON quote_versions(quote_id, version_number DESC);
      CREATE INDEX idx_versions_state_validity
        ON quote_versions(state, valid_until);

      CREATE TRIGGER quote_versions_immutable_snapshot
      BEFORE UPDATE OF quote_id, version_number, snapshot_encrypted,
        calculation_schema_version, content_hash, total_fen, valid_until,
        token_nonce, published_at, created_by, created_at
      ON quote_versions
      BEGIN
        SELECT RAISE(ABORT, 'PUBLISHED_QUOTE_SNAPSHOT_IS_IMMUTABLE');
      END;

      CREATE TABLE quote_actions (
        id TEXT PRIMARY KEY,
        version_id TEXT NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
        action_type TEXT NOT NULL CHECK (action_type IN ('VIEW', 'ACCEPT', 'QUESTION', 'CHANGE_REQUEST')),
        request_id TEXT NOT NULL,
        anonymous_id_hash TEXT NOT NULL DEFAULT '',
        message_encrypted TEXT NOT NULL DEFAULT '',
        user_agent_summary TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE (version_id, request_id)
      ) STRICT;

      CREATE UNIQUE INDEX idx_single_accept_per_version
        ON quote_actions(version_id, action_type)
        WHERE action_type = 'ACCEPT';
      CREATE INDEX idx_actions_version_created
        ON quote_actions(version_id, created_at DESC);

      CREATE TABLE notifications (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
        version_id TEXT NOT NULL REFERENCES quote_versions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        read_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_notifications_merchant_unread
        ON notifications(merchant_id, read_at, created_at DESC);

      CREATE TABLE audit_logs (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
        actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX idx_audit_merchant_created
        ON audit_logs(merchant_id, created_at DESC);

    `),
  },
  {
    version: 2,
    apply: (database) => {
      if (!hasColumn(database, 'quotes', 'draft_revision')) {
        database.exec('ALTER TABLE quotes ADD COLUMN draft_revision INTEGER NOT NULL DEFAULT 1');
      }
      if (!hasColumn(database, 'quote_actions', 'request_hash')) {
        database.exec("ALTER TABLE quote_actions ADD COLUMN request_hash TEXT NOT NULL DEFAULT ''");
      }
      database.exec(`
        CREATE TABLE IF NOT EXISTS addon_products (
          addon_id TEXT NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
          PRIMARY KEY (addon_id, product_id)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS idx_addon_products_merchant
          ON addon_products(merchant_id, addon_id);

        CREATE TABLE IF NOT EXISTS deletion_context (
          id INTEGER PRIMARY KEY CHECK (id = 1)
        ) STRICT;

        CREATE TRIGGER IF NOT EXISTS quote_versions_prevent_delete
        BEFORE DELETE ON quote_versions
        WHEN NOT EXISTS (SELECT 1 FROM deletion_context WHERE id = 1)
        BEGIN
          SELECT RAISE(ABORT, 'PUBLISHED_QUOTE_VERSION_DELETE_FORBIDDEN');
        END;

        CREATE TABLE IF NOT EXISTS deletion_receipts (
          id TEXT PRIMARY KEY,
          merchant_id TEXT NOT NULL,
          merchant_name_hash TEXT NOT NULL,
          requested_by TEXT NOT NULL,
          deleted_at TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    apply: (database, appSecret) => {
      const rows = database
        .prepare('SELECT id, cost_price FROM products WHERE cost_price IS NOT NULL')
        .all();
      for (const row of rows) {
        const value = String(row.cost_price);
        if (value.startsWith('v1.')) {
          if (appSecret) {
            try {
              decryptText(value, appSecret);
            } catch {
              throw new Error('APP_SECRET 与现有加密数据不匹配，请恢复正确密钥后重试');
            }
          }
          continue;
        }
        if (!appSecret) {
          throw new Error('数据库包含旧版明文成本价，升级时必须提供 APP_SECRET');
        }
        database
          .prepare('UPDATE products SET cost_price = ? WHERE id = ?')
          .run(encryptText(value, appSecret), String(row.id));
      }
    },
  },
  {
    version: 4,
    apply: (database, appSecret) => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
      if (appSecret) {
        database
          .prepare('INSERT OR IGNORE INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)')
          .run(
            'encryption_sentinel',
            encryptText('diangao-encryption-key-check-v1', appSecret),
            new Date().toISOString(),
          );
      }
    },
  },
  {
    version: 5,
    apply: (database) => {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS quote_actions_prevent_update
        BEFORE UPDATE ON quote_actions
        BEGIN
          SELECT RAISE(ABORT, 'QUOTE_ACTION_IS_IMMUTABLE');
        END;

        CREATE TRIGGER IF NOT EXISTS quote_actions_prevent_delete
        BEFORE DELETE ON quote_actions
        WHEN NOT EXISTS (SELECT 1 FROM deletion_context WHERE id = 1)
        BEGIN
          SELECT RAISE(ABORT, 'QUOTE_ACTION_DELETE_FORBIDDEN');
        END;
      `);
    },
  },
];

export class AppDatabase {
  readonly raw: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private readonly databasePath: string;
  private readonly appSecret: string | undefined;
  private readonly existedBeforeOpen: boolean;
  private lastMigrationBackupPath: string | null = null;

  constructor(path: string, appSecret?: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.databasePath = path;
    this.appSecret = appSecret;
    this.existedBeforeOpen = path !== ':memory:' && existsSync(path);
    this.raw = new DatabaseSync(path);
    try {
      this.raw.exec('PRAGMA foreign_keys = ON');
      this.raw.exec('PRAGMA journal_mode = WAL');
      this.raw.exec('PRAGMA synchronous = NORMAL');
      this.raw.exec('PRAGMA busy_timeout = 5000');
      this.migrate();
      this.validateEncryptionSecret();
    } catch (error) {
      this.raw.close();
      throw error;
    }
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    const applied = new Set(
      this.raw
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((row) => Number(row.version)),
    );
    const pending = MIGRATIONS.filter((migration) => !applied.has(migration.version));
    if (pending.length === 0) return;

    if (this.appSecret) verifyExistingEncryptedValues(this.raw, this.appSecret);

    if (this.existedBeforeOpen && applied.size > 0 && this.appSecret) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = join(
        dirname(this.databasePath),
        `${basename(this.databasePath)}.migration-${timestamp}.bak.enc`,
      );
      const temporaryPath = `${backupPath}.tmp`;
      const escapedPath = temporaryPath.replaceAll("'", "''");
      let plain: Buffer | null = null;
      try {
        this.raw.exec(`VACUUM INTO '${escapedPath}'`);
        chmodSync(temporaryPath, 0o600);
        plain = readFileSync(temporaryPath);
        writeFileSync(backupPath, encryptMigrationBackup(plain, this.appSecret), {
          mode: 0o600,
          flag: 'wx',
          flush: true,
        });
        this.lastMigrationBackupPath = backupPath;
      } finally {
        plain?.fill(0);
        rmSync(temporaryPath, { force: true });
      }
    }

    this.transaction(() => {
      for (const migration of pending) {
        migration.apply(this.raw, this.appSecret);
        this.raw
          .prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)')
          .run(migration.version, new Date().toISOString());
      }
    });
  }

  private validateEncryptionSecret(): void {
    if (!hasTable(this.raw, 'app_metadata')) return;
    const row = this.raw
      .prepare("SELECT value FROM app_metadata WHERE key = 'encryption_sentinel'")
      .get();
    if (!row) {
      if (!this.appSecret) return;
      this.raw
        .prepare('INSERT INTO app_metadata(key, value, updated_at) VALUES (?, ?, ?)')
        .run(
          'encryption_sentinel',
          encryptText('diangao-encryption-key-check-v1', this.appSecret),
          new Date().toISOString(),
        );
      return;
    }
    if (!this.appSecret) throw new Error('打开现有数据库必须提供 APP_SECRET');
    try {
      const value = decryptText(String(row.value), this.appSecret);
      if (value !== 'diangao-encryption-key-check-v1') throw new Error('sentinel mismatch');
    } catch {
      throw new Error('APP_SECRET 与数据库不匹配，请恢复正确密钥后重试');
    }
  }

  prepare(sql: string): StatementSync {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const statement = this.raw.prepare(sql);
    this.statements.set(sql, statement);
    return statement;
  }

  get migrationBackupPath(): string | null {
    return this.lastMigrationBackupPath;
  }

  transaction<T>(operation: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.statements.clear();
    this.raw.close();
  }
}
