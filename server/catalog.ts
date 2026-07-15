import { Hono } from 'hono';

import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError, notFound } from './errors.ts';
import { audit, boolean, id, nowIso } from './helpers.ts';
import { decryptText, encryptText } from './security.ts';
import type { AppBindings } from './types.ts';
import { addOnSchema, categorySchema, productSchema } from './validation.ts';

function requireCatalogEditor(role: 'OWNER' | 'ADMIN' | 'QUOTER'): void {
  if (role === 'QUOTER') throw new AppError(403, 'FORBIDDEN', '没有维护价格库的权限');
}

export function createCatalogRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/', (context) => {
    const auth = context.get('auth');
    const categories = db
      .prepare(
        `SELECT id, name, sort_order, enabled FROM product_categories
         WHERE merchant_id = ? ORDER BY sort_order, name`,
      )
      .all(auth.merchantId)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        sortOrder: Number(row.sort_order),
        enabled: boolean(row.enabled),
      }));
    const products = db
      .prepare(
        `SELECT * FROM products WHERE merchant_id = ?
         ORDER BY enabled DESC, CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END,
           last_used_at DESC, name`,
      )
      .all(auth.merchantId)
      .map((row) => ({
        id: String(row.id),
        categoryId: row.category_id === null ? null : String(row.category_id),
        code: String(row.code),
        name: String(row.name),
        formulaType: String(row.formula_type),
        unit: String(row.unit),
        salePrice: String(row.sale_price),
        costPrice:
          auth.canViewCost && row.cost_price !== null
            ? decryptText(String(row.cost_price), config.appSecret)
            : null,
        minimumCharge: String(row.minimum_charge),
        lossRate: String(row.loss_rate),
        notes: String(row.notes),
        enabled: boolean(row.enabled),
        isDemo: boolean(row.is_demo),
        lastUsedAt: row.last_used_at === null ? null : String(row.last_used_at),
      }));
    const addOns = db
      .prepare('SELECT * FROM addons WHERE merchant_id = ? ORDER BY enabled DESC, name')
      .all(auth.merchantId)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        pricingType: String(row.pricing_type),
        unit: String(row.unit),
        price: String(row.price),
        notes: String(row.notes),
        enabled: boolean(row.enabled),
        applicableProductIds: db
          .prepare('SELECT product_id FROM addon_products WHERE addon_id = ? ORDER BY product_id')
          .all(String(row.id))
          .map((mapping) => String(mapping.product_id)),
      }));
    return context.json({ categories, products, addOns });
  });

  app.post('/categories', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = categorySchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '分类信息无效', parsed.error.flatten());
    const categoryId = id();
    const timestamp = nowIso();
    db.transaction(() => {
      db.prepare(
        `INSERT INTO product_categories(id, merchant_id, name, sort_order, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        categoryId,
        auth.merchantId,
        parsed.data.name,
        parsed.data.sortOrder,
        parsed.data.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'CATEGORY_CREATED',
        objectType: 'CATEGORY',
        objectId: categoryId,
        summary: `创建分类：${parsed.data.name}`,
      });
    });
    return context.json({ id: categoryId }, 201);
  });

  app.put('/categories/:id', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = categorySchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '分类信息无效', parsed.error.flatten());
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE product_categories SET name = ?, sort_order = ?, enabled = ?, updated_at = ?
         WHERE id = ? AND merchant_id = ?`,
        )
        .run(
          parsed.data.name,
          parsed.data.sortOrder,
          parsed.data.enabled ? 1 : 0,
          nowIso(),
          context.req.param('id'),
          auth.merchantId,
        );
      if (result.changes !== 1) throw notFound('分类不存在');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'CATEGORY_UPDATED',
        objectType: 'CATEGORY',
        objectId: context.req.param('id'),
        summary: `更新分类：${parsed.data.name}`,
      });
    });
    return context.json({ ok: true });
  });

  app.post('/products', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = productSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '产品信息无效', parsed.error.flatten());
    const productId = id();
    const timestamp = nowIso();
    const data = parsed.data;
    if (!auth.canViewCost && data.costPrice !== null) {
      throw new AppError(403, 'COST_PERMISSION_REQUIRED', '没有录入成本价的权限');
    }
    if (data.categoryId) {
      const category = db
        .prepare('SELECT 1 FROM product_categories WHERE id = ? AND merchant_id = ?')
        .get(data.categoryId, auth.merchantId);
      if (!category) throw new AppError(400, 'INVALID_CATEGORY', '所选分类不属于当前店铺');
    }
    const code = data.code || `P-${productId.slice(0, 8).toUpperCase()}`;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO products(
          id, merchant_id, category_id, code, name, formula_type, unit, sale_price,
          cost_price, minimum_charge, loss_rate, notes, enabled, is_demo, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        productId,
        auth.merchantId,
        data.categoryId,
        code,
        data.name,
        data.formulaType,
        data.unit,
        data.salePrice,
        data.costPrice === null ? null : encryptText(data.costPrice, config.appSecret),
        data.minimumCharge,
        data.lossRate,
        data.notes,
        data.enabled ? 1 : 0,
        data.isDemo ? 1 : 0,
        timestamp,
        timestamp,
      );
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'PRODUCT_CREATED',
        objectType: 'PRODUCT',
        objectId: productId,
        summary: `创建产品：${data.name}`,
      });
    });
    return context.json({ id: productId }, 201);
  });

  app.put('/products/:id', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = productSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '产品信息无效', parsed.error.flatten());
    const data = parsed.data;
    if (data.categoryId) {
      const category = db
        .prepare('SELECT 1 FROM product_categories WHERE id = ? AND merchant_id = ?')
        .get(data.categoryId, auth.merchantId);
      if (!category) throw new AppError(400, 'INVALID_CATEGORY', '所选分类不属于当前店铺');
    }
    const existing = db
      .prepare('SELECT code, cost_price FROM products WHERE id = ? AND merchant_id = ?')
      .get(context.req.param('id'), auth.merchantId);
    if (!existing) throw notFound('产品不存在');
    if (!auth.canViewCost && data.costPrice !== null) {
      throw new AppError(403, 'COST_PERMISSION_REQUIRED', '没有修改成本价的权限');
    }
    const code = data.code || String(existing.code);
    const costPrice = auth.canViewCost
      ? data.costPrice === null
        ? null
        : encryptText(data.costPrice, config.appSecret)
      : existing.cost_price === null
        ? null
        : String(existing.cost_price);
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE products SET
          category_id = ?, code = ?, name = ?, formula_type = ?, unit = ?, sale_price = ?,
          cost_price = ?, minimum_charge = ?, loss_rate = ?, notes = ?, enabled = ?, is_demo = ?,
          updated_at = ?
         WHERE id = ? AND merchant_id = ?`,
        )
        .run(
          data.categoryId,
          code,
          data.name,
          data.formulaType,
          data.unit,
          data.salePrice,
          costPrice,
          data.minimumCharge,
          data.lossRate,
          data.notes,
          data.enabled ? 1 : 0,
          data.isDemo ? 1 : 0,
          nowIso(),
          context.req.param('id'),
          auth.merchantId,
        );
      if (result.changes !== 1) throw notFound('产品不存在');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'PRODUCT_UPDATED',
        objectType: 'PRODUCT',
        objectId: context.req.param('id'),
        summary: `更新产品：${data.name}`,
      });
    });
    return context.json({ ok: true });
  });

  app.delete('/products/:id', (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    db.transaction(() => {
      const result = db
        .prepare('UPDATE products SET enabled = 0, updated_at = ? WHERE id = ? AND merchant_id = ?')
        .run(nowIso(), context.req.param('id'), auth.merchantId);
      if (result.changes !== 1) throw notFound('产品不存在');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'PRODUCT_DISABLED',
        objectType: 'PRODUCT',
        objectId: context.req.param('id'),
        summary: '停用产品',
      });
    });
    return context.json({ ok: true });
  });

  app.post('/addons', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = addOnSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '附加项信息无效', parsed.error.flatten());
    const addOnId = id();
    const timestamp = nowIso();
    const data = parsed.data;
    for (const productId of data.applicableProductIds) {
      if (
        !db
          .prepare('SELECT 1 FROM products WHERE id = ? AND merchant_id = ?')
          .get(productId, auth.merchantId)
      ) {
        throw new AppError(400, 'INVALID_PRODUCT_SCOPE', '附加项适用产品不属于当前店铺');
      }
    }
    db.transaction(() => {
      db.prepare(
        `INSERT INTO addons(
          id, merchant_id, name, pricing_type, unit, price, notes, enabled, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        addOnId,
        auth.merchantId,
        data.name,
        data.pricingType,
        data.unit,
        data.price,
        data.notes,
        data.enabled ? 1 : 0,
        timestamp,
        timestamp,
      );
      const insertMapping = db.prepare(
        'INSERT INTO addon_products(addon_id, product_id, merchant_id) VALUES (?, ?, ?)',
      );
      for (const productId of data.applicableProductIds) {
        insertMapping.run(addOnId, productId, auth.merchantId);
      }
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'ADDON_CREATED',
        objectType: 'ADDON',
        objectId: addOnId,
        summary: `创建附加项：${data.name}`,
      });
    });
    return context.json({ id: addOnId }, 201);
  });

  app.put('/addons/:id', async (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    const parsed = addOnSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '附加项信息无效', parsed.error.flatten());
    const data = parsed.data;
    for (const productId of data.applicableProductIds) {
      if (
        !db
          .prepare('SELECT 1 FROM products WHERE id = ? AND merchant_id = ?')
          .get(productId, auth.merchantId)
      ) {
        throw new AppError(400, 'INVALID_PRODUCT_SCOPE', '附加项适用产品不属于当前店铺');
      }
    }
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE addons SET name = ?, pricing_type = ?, unit = ?, price = ?, notes = ?, enabled = ?,
          updated_at = ? WHERE id = ? AND merchant_id = ?`,
        )
        .run(
          data.name,
          data.pricingType,
          data.unit,
          data.price,
          data.notes,
          data.enabled ? 1 : 0,
          nowIso(),
          context.req.param('id'),
          auth.merchantId,
        );
      if (result.changes !== 1) throw notFound('附加项不存在');
      db.prepare('DELETE FROM addon_products WHERE addon_id = ? AND merchant_id = ?').run(
        context.req.param('id'),
        auth.merchantId,
      );
      const insertMapping = db.prepare(
        'INSERT INTO addon_products(addon_id, product_id, merchant_id) VALUES (?, ?, ?)',
      );
      for (const productId of data.applicableProductIds) {
        insertMapping.run(context.req.param('id'), productId, auth.merchantId);
      }
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'ADDON_UPDATED',
        objectType: 'ADDON',
        objectId: context.req.param('id'),
        summary: `更新附加项：${data.name}`,
      });
    });
    return context.json({ ok: true });
  });

  app.delete('/addons/:id', (context) => {
    const auth = context.get('auth');
    requireCatalogEditor(auth.role);
    db.transaction(() => {
      const result = db
        .prepare('UPDATE addons SET enabled = 0, updated_at = ? WHERE id = ? AND merchant_id = ?')
        .run(nowIso(), context.req.param('id'), auth.merchantId);
      if (result.changes !== 1) throw notFound('附加项不存在');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'ADDON_DISABLED',
        objectType: 'ADDON',
        objectId: context.req.param('id'),
        summary: '停用附加项',
      });
    });
    return context.json({ ok: true });
  });

  return app;
}
