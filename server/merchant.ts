import { Hono } from 'hono';

import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError, notFound } from './errors.ts';
import { audit, boolean, decryptJson, id, nowIso } from './helpers.ts';
import { decryptText, encryptText, hashText } from './security.ts';
import type { AppBindings } from './types.ts';
import { merchantUpdateSchema } from './validation.ts';

export function createMerchantRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/', (context) => {
    const auth = context.get('auth');
    const row = db.prepare('SELECT * FROM merchants WHERE id = ?').get(auth.merchantId);
    if (!row) throw notFound('商家不存在');
    return context.json({
      id: String(row.id),
      name: String(row.name),
      logoUrl: String(row.logo_url),
      contactName: String(row.contact_name),
      contactPhone: decryptText(String(row.contact_phone_encrypted), config.appSecret),
      contactWechat: decryptText(String(row.contact_wechat_encrypted), config.appSecret),
      defaultValidDays: Number(row.default_valid_days),
      defaultDeliveryPeriod: String(row.default_delivery_period),
      defaultTerms: String(row.default_terms),
      roundingMode: String(row.rounding_mode),
      timezone: String(row.timezone),
      onboardingCompleted: boolean(row.onboarding_completed),
    });
  });

  app.put('/', async (context) => {
    const auth = context.get('auth');
    if (auth.role === 'QUOTER') throw new AppError(403, 'FORBIDDEN', '没有修改店铺资料的权限');
    const parsed = merchantUpdateSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', '店铺资料填写不完整', parsed.error.flatten());
    }
    const data = parsed.data;
    const timestamp = nowIso();
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE merchants SET
          name = ?, logo_url = ?, contact_name = ?, contact_phone_encrypted = ?,
          contact_wechat_encrypted = ?, default_valid_days = ?, default_delivery_period = ?,
          default_terms = ?, rounding_mode = ?, onboarding_completed = ?, updated_at = ?
         WHERE id = ?`,
        )
        .run(
          data.name,
          data.logoUrl,
          data.contactName,
          encryptText(data.contactPhone, config.appSecret),
          encryptText(data.contactWechat, config.appSecret),
          data.defaultValidDays,
          data.defaultDeliveryPeriod,
          data.defaultTerms,
          data.roundingMode,
          data.onboardingCompleted ? 1 : 0,
          timestamp,
          auth.merchantId,
        );
      if (result.changes !== 1) throw notFound('商家不存在');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'MERCHANT_UPDATED',
        objectType: 'MERCHANT',
        objectId: auth.merchantId,
        summary: '更新商家公开资料和默认报价设置',
      });
    });
    return context.json({ ok: true });
  });

  app.get('/audit', (context) => {
    const auth = context.get('auth');
    if (auth.role !== 'OWNER') throw new AppError(403, 'FORBIDDEN', '仅店主可查看审计记录');
    const rows = db
      .prepare(
        `SELECT id, actor_user_id, action, object_type, object_id, summary, created_at
         FROM audit_logs WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 500`,
      )
      .all(auth.merchantId)
      .map((row) => ({
        id: String(row.id),
        actorUserId: row.actor_user_id === null ? null : String(row.actor_user_id),
        action: String(row.action),
        objectType: String(row.object_type),
        objectId: String(row.object_id),
        summary: String(row.summary),
        createdAt: String(row.created_at),
      }));
    return context.json({ items: rows });
  });

  app.get('/export', (context) => {
    const auth = context.get('auth');
    if (auth.role !== 'OWNER') throw new AppError(403, 'FORBIDDEN', '仅店主可导出全部数据');
    const exportSize = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM quotes WHERE merchant_id = ?) AS quote_count,
          (SELECT COUNT(*) FROM quote_versions v JOIN quotes q ON q.id = v.quote_id
            WHERE q.merchant_id = ?) AS version_count,
          (SELECT COUNT(*) FROM quote_actions a
            JOIN quote_versions v ON v.id = a.version_id
            JOIN quotes q ON q.id = v.quote_id WHERE q.merchant_id = ?) AS action_count`,
      )
      .get(auth.merchantId, auth.merchantId, auth.merchantId);
    if (
      Number(exportSize?.quote_count) > 5_000 ||
      Number(exportSize?.version_count) > 20_000 ||
      Number(exportSize?.action_count) > 50_000
    ) {
      throw new AppError(
        413,
        'EXPORT_TOO_LARGE',
        '数据量超过同步导出上限，请先按时间范围分批归档或使用数据库加密备份',
      );
    }
    const merchant = db.prepare('SELECT * FROM merchants WHERE id = ?').get(auth.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const categories = db
      .prepare('SELECT * FROM product_categories WHERE merchant_id = ? ORDER BY sort_order, name')
      .all(auth.merchantId);
    const products = db
      .prepare('SELECT * FROM products WHERE merchant_id = ? ORDER BY name')
      .all(auth.merchantId)
      .map((row) => ({
        ...row,
        cost_price:
          row.cost_price === null ? null : decryptText(String(row.cost_price), config.appSecret),
      }));
    const addOns = db
      .prepare('SELECT * FROM addons WHERE merchant_id = ? ORDER BY name')
      .all(auth.merchantId);
    const quotes = db
      .prepare('SELECT * FROM quotes WHERE merchant_id = ? ORDER BY created_at')
      .all(auth.merchantId)
      .map((quote) => {
        const versions = db
          .prepare('SELECT * FROM quote_versions WHERE quote_id = ? ORDER BY version_number')
          .all(String(quote.id))
          .map((version) => ({
            id: String(version.id),
            versionNumber: Number(version.version_number),
            state: String(version.state),
            snapshot: decryptJson(String(version.snapshot_encrypted), config.appSecret),
            publishedAt: String(version.published_at),
            acceptedAt: version.accepted_at === null ? null : String(version.accepted_at),
            actions: db
              .prepare('SELECT * FROM quote_actions WHERE version_id = ? ORDER BY created_at')
              .all(String(version.id))
              .map((action) => ({
                type: String(action.action_type),
                message: decryptText(String(action.message_encrypted), config.appSecret),
                createdAt: String(action.created_at),
              })),
          }));
        return {
          id: String(quote.id),
          quoteNumber: String(quote.quote_number),
          customerName: String(quote.customer_name),
          customerContact: decryptText(String(quote.customer_contact_encrypted), config.appSecret),
          projectName: String(quote.project_name),
          draft:
            quote.draft_encrypted === null
              ? null
              : decryptJson(String(quote.draft_encrypted), config.appSecret),
          versions,
        };
      });
    audit(db, {
      merchantId: auth.merchantId,
      actorUserId: auth.userId,
      action: 'DATA_EXPORTED',
      objectType: 'MERCHANT',
      objectId: auth.merchantId,
      summary: '导出商家全部业务数据',
    });
    context.header('Cache-Control', 'no-store, private');
    context.header('Content-Disposition', 'attachment; filename="diangao-export.json"');
    return context.json({
      exportedAt: nowIso(),
      merchant: {
        id: String(merchant.id),
        name: String(merchant.name),
        logoUrl: String(merchant.logo_url),
        contactName: String(merchant.contact_name),
        contactPhone: decryptText(String(merchant.contact_phone_encrypted), config.appSecret),
        contactWechat: decryptText(String(merchant.contact_wechat_encrypted), config.appSecret),
      },
      categories,
      products,
      addOns,
      quotes,
    });
  });

  app.delete('/account', async (context) => {
    const auth = context.get('auth');
    if (auth.role !== 'OWNER') throw new AppError(403, 'FORBIDDEN', '仅店主可删除店铺数据');
    const body = (await context.req.json().catch(() => ({}))) as { confirmation?: unknown };
    const merchant = db.prepare('SELECT name FROM merchants WHERE id = ?').get(auth.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const name = String(merchant.name);
    if (body.confirmation !== name) {
      throw new AppError(400, 'CONFIRMATION_MISMATCH', '请输入完整店铺名称以确认删除');
    }
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO deletion_receipts(
          id, merchant_id, merchant_name_hash, requested_by, deleted_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).run(id(), auth.merchantId, hashText(name, config.appSecret), auth.userId, timestamp);
      db.prepare('INSERT OR REPLACE INTO deletion_context(id) VALUES (1)').run();
      db.prepare('DELETE FROM merchants WHERE id = ?').run(auth.merchantId);
      db.prepare('DELETE FROM deletion_context WHERE id = 1').run();
      db.prepare("UPDATE users SET status = 'DISABLED', updated_at = ? WHERE id = ?").run(
        timestamp,
        auth.userId,
      );
    });
    return context.json({ ok: true, deletedAt: timestamp });
  });

  return app;
}
