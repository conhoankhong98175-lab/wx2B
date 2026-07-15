import type {
  MerchantPublicProfile,
  PublicQuoteDocument,
  QuoteCalculation,
  QuoteDraftData,
  QuoteState,
} from '../shared/contracts.ts';
import { toPublicCalculation } from '../shared/pricing.ts';
import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { notFound } from './errors.ts';
import { boolean, currentDateInTimeZone, decryptJson } from './helpers.ts';
import { decryptText } from './security.ts';

export interface QuoteSnapshot {
  schemaVersion: 1;
  quoteNumber: string;
  version: number;
  publishedAt: string;
  publishedDate?: string;
  draft: QuoteDraftData;
  calculation: QuoteCalculation;
  merchant: MerchantPublicProfile;
}

export interface VersionRow {
  id: string;
  quote_id: string;
  version_number: number;
  state: QuoteState;
  snapshot_encrypted: string;
  calculation_schema_version: number;
  content_hash: string;
  total_fen: number;
  valid_until: string;
  token_nonce: string;
  published_at: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  accepted_at: string | null;
  superseded_by_version: number | null;
  withdrawn_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function versionRow(row: Record<string, unknown>): VersionRow {
  return {
    id: String(row.id),
    quote_id: String(row.quote_id),
    version_number: Number(row.version_number),
    state: String(row.state) as QuoteState,
    snapshot_encrypted: String(row.snapshot_encrypted),
    calculation_schema_version: Number(row.calculation_schema_version),
    content_hash: String(row.content_hash),
    total_fen: Number(row.total_fen),
    valid_until: String(row.valid_until),
    token_nonce: String(row.token_nonce),
    published_at: String(row.published_at),
    first_viewed_at: row.first_viewed_at === null ? null : String(row.first_viewed_at as string),
    last_viewed_at: row.last_viewed_at === null ? null : String(row.last_viewed_at as string),
    view_count: Number(row.view_count),
    accepted_at: row.accepted_at === null ? null : String(row.accepted_at as string),
    superseded_by_version:
      row.superseded_by_version === null ? null : Number(row.superseded_by_version),
    withdrawn_at: row.withdrawn_at === null ? null : String(row.withdrawn_at as string),
    created_by: String(row.created_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export function getVersionById(db: AppDatabase, versionId: string): VersionRow {
  const row = db.prepare('SELECT * FROM quote_versions WHERE id = ?').get(versionId);
  if (!row) throw notFound('报价版本不存在');
  return versionRow(row);
}

export function getMerchantVersion(
  db: AppDatabase,
  merchantId: string,
  quoteId: string,
  version: number,
): VersionRow {
  const row = db
    .prepare(
      `SELECT v.* FROM quote_versions v
       JOIN quotes q ON q.id = v.quote_id
       WHERE q.id = ? AND q.merchant_id = ? AND v.version_number = ?`,
    )
    .get(quoteId, merchantId, version);
  if (!row) throw notFound('报价版本不存在');
  return versionRow(row);
}

export function decryptSnapshot(row: VersionRow, config: AppConfig): QuoteSnapshot {
  return decryptJson<QuoteSnapshot>(row.snapshot_encrypted, config.appSecret);
}

export function refreshExpiry(
  db: AppDatabase,
  row: VersionRow,
  timeZone = 'Asia/Shanghai',
): VersionRow {
  if (
    (row.state === 'ACTIVE' || row.state === 'CHANGE_REQUESTED') &&
    row.valid_until < currentDateInTimeZone(timeZone)
  ) {
    const timestamp = new Date().toISOString();
    db.prepare(
      `UPDATE quote_versions SET state = 'EXPIRED', updated_at = ?
       WHERE id = ? AND state IN ('ACTIVE', 'CHANGE_REQUESTED')`,
    ).run(timestamp, row.id);
    return { ...row, state: 'EXPIRED', updated_at: timestamp };
  }
  return row;
}

export function getMerchantPublicProfile(
  db: AppDatabase,
  merchantId: string,
  config: AppConfig,
): MerchantPublicProfile {
  const row = db
    .prepare(
      `SELECT name, logo_url, contact_name, contact_phone_encrypted, contact_wechat_encrypted
       FROM merchants WHERE id = ?`,
    )
    .get(merchantId);
  if (!row) throw notFound('商家不存在');
  return {
    name: String(row.name),
    logoUrl: String(row.logo_url),
    contactName: String(row.contact_name),
    contactPhone: decryptText(String(row.contact_phone_encrypted), config.appSecret),
    contactWechat: decryptText(String(row.contact_wechat_encrypted), config.appSecret),
  };
}

export function toPublicDocument(row: VersionRow, snapshot: QuoteSnapshot): PublicQuoteDocument {
  return {
    quoteNumber: snapshot.quoteNumber,
    version: snapshot.version,
    state: row.state,
    publishedAt: snapshot.publishedAt,
    publishedDate: snapshot.publishedDate ?? snapshot.publishedAt.slice(0, 10),
    validUntil: row.valid_until,
    merchant: snapshot.merchant,
    customerName: snapshot.draft.customerName,
    projectName: snapshot.draft.projectName,
    deliveryPeriod: snapshot.draft.deliveryPeriod,
    notes: snapshot.draft.notes,
    terms: snapshot.draft.terms,
    calculation: toPublicCalculation(snapshot.calculation),
    firstViewedAt: row.first_viewed_at,
    acceptedAt: row.accepted_at,
    supersededByVersion: row.superseded_by_version,
  };
}

export function mapCategory(row: Record<string, unknown>): {
  id: string;
  name: string;
  sortOrder: number;
  enabled: boolean;
} {
  return {
    id: String(row.id),
    name: String(row.name),
    sortOrder: Number(row.sort_order),
    enabled: boolean(row.enabled),
  };
}
