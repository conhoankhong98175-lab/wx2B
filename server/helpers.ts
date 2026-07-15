import { createHash, randomUUID } from 'node:crypto';

import type { CatalogAddOn, CatalogProduct, QuoteDraftData } from '../shared/contracts.ts';
import demoCatalog from '../shared/demo-catalog.json' with { type: 'json' };
import type { AppDatabase } from './database.ts';
import { decryptText, encryptText } from './security.ts';

export function nowIso(): string {
  return new Date().toISOString();
}

export function id(): string {
  return randomUUID();
}

export function boolean(value: unknown): boolean {
  return Number(value) === 1;
}

export function stableHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function encryptJson(value: unknown, secret: string): string {
  return encryptText(JSON.stringify(value), secret);
}

export function decryptJson<T>(value: string, secret: string): T {
  return JSON.parse(decryptText(value, secret)) as T;
}

export function currentDateInTimeZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function addDays(date: Date, days: number): string {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy.toISOString().slice(0, 10);
}

export function datePlusInTimeZone(timeZone: string, days: number): string {
  const current = currentDateInTimeZone(timeZone);
  const date = new Date(`${current}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function getCatalog(
  db: AppDatabase,
  merchantId: string,
  secret: string,
  includeDisabled = false,
): { products: CatalogProduct[]; addOns: CatalogAddOn[] } {
  const products = db
    .prepare(
      `SELECT id, category_id, code, name, formula_type, unit, sale_price,
        cost_price, minimum_charge, loss_rate, enabled, notes
       FROM products
       WHERE merchant_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
       ORDER BY CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END, last_used_at DESC, name`,
    )
    .all(merchantId)
    .map((row) => ({
      id: String(row.id),
      categoryId: row.category_id === null ? null : String(row.category_id),
      code: String(row.code),
      name: String(row.name),
      formulaType: String(row.formula_type) as CatalogProduct['formulaType'],
      unit: String(row.unit),
      salePrice: String(row.sale_price),
      costPrice: row.cost_price === null ? null : decryptText(String(row.cost_price), secret),
      minimumCharge: String(row.minimum_charge),
      lossRate: String(row.loss_rate),
      enabled: boolean(row.enabled),
      notes: String(row.notes),
    }));
  const addOns = db
    .prepare(
      `SELECT id, name, pricing_type, unit, price, enabled, notes
       FROM addons
       WHERE merchant_id = ? ${includeDisabled ? '' : 'AND enabled = 1'}
       ORDER BY name`,
    )
    .all(merchantId)
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      pricingType: String(row.pricing_type) as CatalogAddOn['pricingType'],
      unit: String(row.unit),
      price: String(row.price),
      enabled: boolean(row.enabled),
      notes: String(row.notes),
      applicableProductIds: db
        .prepare('SELECT product_id FROM addon_products WHERE addon_id = ? ORDER BY product_id')
        .all(String(row.id))
        .map((mapping) => String(mapping.product_id)),
    }));
  return { products, addOns };
}

export function loadDraft(encrypted: unknown, secret: string): QuoteDraftData | null {
  if (typeof encrypted !== 'string' || encrypted.length === 0) return null;
  return decryptJson<QuoteDraftData>(encrypted, secret);
}

export function audit(
  db: AppDatabase,
  input: {
    merchantId: string;
    actorUserId: string | null;
    action: string;
    objectType: string;
    objectId: string;
    summary: string;
  },
): void {
  db.prepare(
    `INSERT INTO audit_logs(
      id, merchant_id, actor_user_id, action, object_type, object_id, summary, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id(),
    input.merchantId,
    input.actorUserId,
    input.action,
    input.objectType,
    input.objectId,
    input.summary.slice(0, 500),
    nowIso(),
  );
}

export function seedDemoCatalog(db: AppDatabase, merchantId: string, secret: string): void {
  const exists = db.prepare('SELECT 1 FROM products WHERE merchant_id = ? LIMIT 1').get(merchantId);
  if (exists) return;
  const timestamp = nowIso();
  const categoryId = id();
  db.prepare(
    `INSERT INTO product_categories(id, merchant_id, name, sort_order, enabled, created_at, updated_at)
     VALUES (?, ?, ?, 0, 1, ?, ?)`,
  ).run(categoryId, merchantId, demoCatalog.category, timestamp, timestamp);

  const insertProduct = db.prepare(
    `INSERT INTO products(
      id, merchant_id, category_id, code, name, formula_type, unit, sale_price,
      cost_price, minimum_charge, loss_rate, notes, enabled, is_demo, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?)`,
  );
  for (const product of demoCatalog.products) {
    insertProduct.run(
      id(),
      merchantId,
      categoryId,
      product.code,
      product.name,
      product.formulaType,
      product.unit,
      product.salePrice,
      product.costPrice === null ? null : encryptText(product.costPrice, secret),
      product.minimumCharge,
      product.lossRate,
      product.notes,
      timestamp,
      timestamp,
    );
  }

  const insertAddOn = db.prepare(
    `INSERT INTO addons(
      id, merchant_id, name, pricing_type, unit, price, notes, enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  );
  for (const addOn of demoCatalog.addOns) {
    insertAddOn.run(
      id(),
      merchantId,
      addOn.name,
      addOn.pricingType,
      addOn.unit,
      addOn.price,
      addOn.notes,
      timestamp,
      timestamp,
    );
  }
}
