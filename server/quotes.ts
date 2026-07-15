import { Hono } from 'hono';
import { Decimal } from 'decimal.js';

import type { QuoteDraftData } from '../shared/contracts.ts';
import { calculateQuote, PricingError, toPublicCalculation } from '../shared/pricing.ts';
import type { AppConfig } from './config.ts';
import type { AppDatabase } from './database.ts';
import { AppError, conflict, notFound } from './errors.ts';
import {
  audit,
  currentDateInTimeZone,
  datePlusInTimeZone,
  encryptJson,
  getCatalog,
  id,
  loadDraft,
  nowIso,
  stableHash,
} from './helpers.ts';
import {
  decryptSnapshot,
  getMerchantPublicProfile,
  getMerchantVersion,
  type QuoteSnapshot,
  refreshExpiry,
} from './quote-service.ts';
import { createQuoteToken, encryptText, randomNonce } from './security.ts';
import { decryptText } from './security.ts';
import type { AppBindings } from './types.ts';
import { quoteDraftSchema } from './validation.ts';

function calculateDraft(
  db: AppDatabase,
  merchantId: string,
  draft: QuoteDraftData,
  config: AppConfig,
) {
  const catalog = getCatalog(db, merchantId, config.appSecret);
  try {
    return calculateQuote(draft, catalog.products, catalog.addOns);
  } catch (error) {
    if (error instanceof PricingError) {
      throw new AppError(400, error.code, error.message, { path: error.path });
    }
    throw error;
  }
}

function calculationForMember(
  calculation: ReturnType<typeof calculateQuote>,
  canViewCost: boolean,
): unknown {
  if (canViewCost) return calculation;
  const rest = toPublicCalculation(calculation);
  return {
    ...rest,
    warnings: calculation.warnings.filter(
      (warning) => warning.code !== 'BELOW_COST' && warning.code !== 'TOTAL_BELOW_COST',
    ),
  };
}

function calculationHash(calculation: ReturnType<typeof calculateQuote>): string {
  return stableHash(toPublicCalculation(calculation));
}

function expectedDraftRevision(context: {
  req: { header(name: string): string | undefined };
}): number {
  const header = context.req.header('if-match')?.trim();
  const normalized = header?.replace(/^W\//, '').replace(/^"|"$/g, '');
  const revision = Number(normalized);
  if (!normalized || !Number.isInteger(revision) || revision < 1) {
    throw new AppError(
      428,
      'DRAFT_REVISION_REQUIRED',
      '保存草稿时必须提供当前草稿版本，请刷新后重试',
    );
  }
  return revision;
}

function hasManualPriceReduction(
  db: AppDatabase,
  merchantId: string,
  draft: QuoteDraftData,
  config: AppConfig,
): boolean {
  if (draft.discountType !== 'NONE' && new Decimal(draft.discountValue).gt(0)) return true;
  if (new Decimal(draft.manualAdjustment).lt(0)) return true;
  const catalog = getCatalog(db, merchantId, config.appSecret);
  const products = new Map(catalog.products.map((product) => [product.id, product]));
  const addOns = new Map(catalog.addOns.map((addOn) => [addOn.id, addOn]));
  for (const line of draft.lines) {
    const product = products.get(line.productId);
    if (
      product &&
      line.unitPriceOverride !== undefined &&
      new Decimal(line.unitPriceOverride).lt(product.salePrice)
    ) {
      return true;
    }
    for (const selected of line.addOns) {
      const addOn = addOns.get(selected.addOnId);
      if (
        addOn &&
        selected.priceOverride !== undefined &&
        new Decimal(selected.priceOverride).lt(addOn.price)
      ) {
        return true;
      }
    }
  }
  return draft.orderAddOns.some((selected) => {
    const addOn = addOns.get(selected.addOnId);
    return (
      addOn !== undefined &&
      selected.priceOverride !== undefined &&
      new Decimal(selected.priceOverride).lt(addOn.price)
    );
  });
}

function quoteNumber(db: AppDatabase, merchantId: string, timeZone: string): string {
  const row = db
    .prepare(
      `UPDATE merchants SET quote_sequence = quote_sequence + 1, updated_at = ?
       WHERE id = ? RETURNING quote_sequence`,
    )
    .get(nowIso(), merchantId);
  if (!row) throw notFound('商家不存在');
  const sequence = String(Number(row.quote_sequence)).padStart(4, '0');
  const date = currentDateInTimeZone(timeZone).replaceAll('-', '');
  return `DG-${date}-${merchantId.slice(0, 4).toUpperCase()}-${sequence}`;
}

function createQuoteRecord(
  db: AppDatabase,
  config: AppConfig,
  input: { merchantId: string; userId: string; draft: QuoteDraftData },
): { id: string; quoteNumber: string } {
  return db.transaction(() => {
    const merchant = db
      .prepare('SELECT timezone FROM merchants WHERE id = ?')
      .get(input.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const quoteId = id();
    const number = quoteNumber(db, input.merchantId, String(merchant.timezone));
    const timestamp = nowIso();
    db.prepare(
      `INSERT INTO quotes(
        id, merchant_id, quote_number, customer_name, customer_contact_encrypted,
        project_name, draft_encrypted, draft_version, draft_revision, current_version, created_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1, 0, ?, ?, ?)`,
    ).run(
      quoteId,
      input.merchantId,
      number,
      input.draft.customerName,
      encryptText(input.draft.customerContact, config.appSecret),
      input.draft.projectName,
      encryptJson(input.draft, config.appSecret),
      input.userId,
      timestamp,
      timestamp,
    );
    audit(db, {
      merchantId: input.merchantId,
      actorUserId: input.userId,
      action: 'QUOTE_DRAFT_CREATED',
      objectType: 'QUOTE',
      objectId: quoteId,
      summary: `创建报价草稿 ${number}`,
    });
    return { id: quoteId, quoteNumber: number };
  });
}

function getQuote(db: AppDatabase, merchantId: string, quoteId: string): Record<string, unknown> {
  const row = db
    .prepare('SELECT * FROM quotes WHERE id = ? AND merchant_id = ?')
    .get(quoteId, merchantId);
  if (!row) throw notFound('报价不存在');
  return row;
}

function copyFrozenDraft(snapshot: QuoteSnapshot): QuoteDraftData {
  return {
    ...snapshot.draft,
    lines: snapshot.draft.lines.map((line) => {
      const calculated = snapshot.calculation.lines.find((item) => item.id === line.id);
      return {
        ...line,
        ...(calculated ? { unitPriceOverride: calculated.unitPrice } : {}),
        addOns: line.addOns.map((addOn) => {
          const calculatedAddOn = calculated?.addOns.find((item) => item.id === addOn.id);
          return {
            ...addOn,
            ...(calculatedAddOn ? { priceOverride: calculatedAddOn.price } : {}),
          };
        }),
      };
    }),
    orderAddOns: snapshot.draft.orderAddOns.map((addOn) => {
      const calculated = snapshot.calculation.orderAddOns.find((item) => item.id === addOn.id);
      return { ...addOn, ...(calculated ? { priceOverride: calculated.price } : {}) };
    }),
  };
}

export function createQuoteRoutes(db: AppDatabase, config: AppConfig): Hono<AppBindings> {
  const app = new Hono<AppBindings>();

  app.get('/', (context) => {
    const auth = context.get('auth');
    db.prepare(
      `UPDATE quote_versions SET state = 'EXPIRED', updated_at = ?
       WHERE quote_id IN (SELECT id FROM quotes WHERE merchant_id = ?)
         AND state IN ('ACTIVE', 'CHANGE_REQUESTED') AND valid_until < ?`,
    ).run(nowIso(), auth.merchantId, currentDateInTimeZone('Asia/Shanghai'));

    const search = (context.req.query('q') ?? '').trim();
    const state = (context.req.query('state') ?? '').trim();
    const dateFrom = (context.req.query('dateFrom') ?? '').trim();
    const dateTo = (context.req.query('dateTo') ?? '').trim();
    if (
      (dateFrom && !/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) ||
      (dateTo && !/^\d{4}-\d{2}-\d{2}$/.test(dateTo))
    ) {
      throw new AppError(400, 'INVALID_DATE_FILTER', '日期筛选格式无效');
    }
    const pattern = `%${search}%`;
    const rows = db
      .prepare(
        `SELECT q.id, q.quote_number, q.customer_name, q.project_name, q.current_version,
          q.draft_version, q.draft_encrypted, q.created_at, q.updated_at,
          v.state, v.total_fen, v.valid_until, v.first_viewed_at, v.accepted_at
         FROM quotes q
         LEFT JOIN quote_versions v
           ON v.quote_id = q.id AND v.version_number = q.current_version
         WHERE q.merchant_id = ? AND q.archived_at IS NULL
           AND (? = '' OR q.quote_number LIKE ? OR q.customer_name LIKE ? OR q.project_name LIKE ?)
           AND (? = '' OR (? = 'DRAFT' AND q.draft_encrypted IS NOT NULL) OR v.state = ?)
           AND (? = '' OR substr(q.created_at, 1, 10) >= ?)
           AND (? = '' OR substr(q.created_at, 1, 10) <= ?)
         ORDER BY q.updated_at DESC LIMIT 200`,
      )
      .all(
        auth.merchantId,
        search,
        pattern,
        pattern,
        pattern,
        state,
        state,
        state,
        dateFrom,
        dateFrom,
        dateTo,
        dateTo,
      )
      .map((row) => ({
        id: String(row.id),
        quoteNumber: String(row.quote_number),
        customerName: String(row.customer_name),
        projectName: String(row.project_name),
        currentVersion: Number(row.current_version),
        draftVersion: row.draft_version === null ? null : Number(row.draft_version),
        hasDraft: row.draft_encrypted !== null,
        state: row.state === null ? 'DRAFT' : String(row.state),
        total: row.total_fen === null ? null : (Number(row.total_fen) / 100).toFixed(2),
        validUntil: row.valid_until === null ? null : String(row.valid_until),
        viewed: row.first_viewed_at !== null,
        acceptedAt: row.accepted_at === null ? null : String(row.accepted_at),
        createdAt: String(row.created_at),
        updatedAt: String(row.updated_at),
      }));
    return context.json({ items: rows });
  });

  app.post('/calculate', async (context) => {
    const auth = context.get('auth');
    const parsed = quoteDraftSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '报价内容无效', parsed.error.flatten());
    const calculation = calculateDraft(db, auth.merchantId, parsed.data, config);
    return context.json({
      calculation: calculationForMember(calculation, auth.canViewCost),
      calculationHash: calculationHash(calculation),
    });
  });

  app.post('/', async (context) => {
    const auth = context.get('auth');
    const parsed = quoteDraftSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '报价内容无效', parsed.error.flatten());
    const calculation = parsed.data.lines.length
      ? calculateDraft(db, auth.merchantId, parsed.data, config)
      : null;
    const result = createQuoteRecord(db, config, {
      merchantId: auth.merchantId,
      userId: auth.userId,
      draft: parsed.data,
    });
    return context.json(
      {
        ...result,
        draftRevision: 1,
        calculation: calculation ? calculationForMember(calculation, auth.canViewCost) : null,
        calculationHash: calculation ? calculationHash(calculation) : null,
      },
      201,
    );
  });

  app.get('/:id', (context) => {
    const auth = context.get('auth');
    const quote = getQuote(db, auth.merchantId, context.req.param('id'));
    const merchant = db.prepare('SELECT name FROM merchants WHERE id = ?').get(auth.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const draft = loadDraft(quote.draft_encrypted, config.appSecret);
    const versions = db
      .prepare('SELECT * FROM quote_versions WHERE quote_id = ? ORDER BY version_number DESC')
      .all(String(quote.id))
      .map((raw) => {
        const row = refreshExpiry(db, {
          id: String(raw.id),
          quote_id: String(raw.quote_id),
          version_number: Number(raw.version_number),
          state: String(raw.state) as 'ACTIVE',
          snapshot_encrypted: String(raw.snapshot_encrypted),
          calculation_schema_version: Number(raw.calculation_schema_version),
          content_hash: String(raw.content_hash),
          total_fen: Number(raw.total_fen),
          valid_until: String(raw.valid_until),
          token_nonce: String(raw.token_nonce),
          published_at: String(raw.published_at),
          first_viewed_at: raw.first_viewed_at === null ? null : String(raw.first_viewed_at),
          last_viewed_at: raw.last_viewed_at === null ? null : String(raw.last_viewed_at),
          view_count: Number(raw.view_count),
          accepted_at: raw.accepted_at === null ? null : String(raw.accepted_at),
          superseded_by_version:
            raw.superseded_by_version === null ? null : Number(raw.superseded_by_version),
          withdrawn_at: raw.withdrawn_at === null ? null : String(raw.withdrawn_at),
          created_by: String(raw.created_by),
          created_at: String(raw.created_at),
          updated_at: String(raw.updated_at),
        });
        const snapshot = decryptSnapshot(row, config);
        const calculation = auth.canViewCost
          ? snapshot.calculation
          : toPublicCalculation(snapshot.calculation);
        const token = createQuoteToken(row.id, row.token_nonce, config.appSecret);
        const sharingAvailable = config.mode !== 'desktop';
        const actions = db
          .prepare(
            `SELECT id, action_type, message_encrypted, created_at
             FROM quote_actions WHERE version_id = ? ORDER BY created_at DESC`,
          )
          .all(row.id)
          .map((action) => ({
            id: String(action.id),
            type: String(action.action_type),
            message: decryptText(String(action.message_encrypted), config.appSecret),
            createdAt: String(action.created_at),
          }));
        return {
          id: row.id,
          version: row.version_number,
          state: row.state,
          calculation,
          publishedAt: row.published_at,
          validUntil: row.valid_until,
          firstViewedAt: row.first_viewed_at,
          lastViewedAt: row.last_viewed_at,
          viewCount: row.view_count,
          acceptedAt: row.accepted_at,
          supersededByVersion: row.superseded_by_version,
          shareToken: sharingAvailable ? token : null,
          shareUrl: sharingAvailable
            ? `${config.publicBaseUrl}/q/${encodeURIComponent(token)}`
            : null,
          actions,
        };
      });
    return context.json({
      id: String(quote.id),
      quoteNumber: String(quote.quote_number),
      customerName: String(quote.customer_name),
      projectName: String(quote.project_name),
      merchantName: String(merchant.name),
      sharingAvailable: config.mode !== 'desktop',
      currentVersion: Number(quote.current_version),
      draftVersion: quote.draft_version === null ? null : Number(quote.draft_version),
      draftRevision: Number(quote.draft_revision),
      draft,
      versions,
    });
  });

  app.put('/:id/draft', async (context) => {
    const auth = context.get('auth');
    const expectedRevision = expectedDraftRevision(context);
    const parsed = quoteDraftSchema.safeParse(await context.req.json().catch(() => ({})));
    if (!parsed.success)
      throw new AppError(400, 'VALIDATION_ERROR', '报价内容无效', parsed.error.flatten());
    const quote = getQuote(db, auth.merchantId, context.req.param('id'));
    if (quote.draft_encrypted === null)
      throw conflict('NO_EDITABLE_DRAFT', '当前没有可编辑草稿，请先创建新版本');
    if (Number(quote.draft_revision) !== expectedRevision) {
      throw new AppError(409, 'DRAFT_CHANGED', '草稿已在其他保存请求中发生变化，请刷新后重试', {
        draftRevision: Number(quote.draft_revision),
      });
    }
    const calculation = parsed.data.lines.length
      ? calculateDraft(db, auth.merchantId, parsed.data, config)
      : null;
    const timestamp = nowIso();
    const update = db
      .prepare(
        `UPDATE quotes SET customer_name = ?, customer_contact_encrypted = ?, project_name = ?,
        draft_encrypted = ?, draft_revision = draft_revision + 1, updated_at = ?
       WHERE id = ? AND merchant_id = ? AND draft_revision = ?`,
      )
      .run(
        parsed.data.customerName,
        encryptText(parsed.data.customerContact, config.appSecret),
        parsed.data.projectName,
        encryptJson(parsed.data, config.appSecret),
        timestamp,
        context.req.param('id'),
        auth.merchantId,
        expectedRevision,
      );
    if (update.changes !== 1) {
      const current = getQuote(db, auth.merchantId, context.req.param('id'));
      throw new AppError(409, 'DRAFT_CHANGED', '草稿已在其他保存请求中发生变化，请刷新后重试', {
        draftRevision: Number(current.draft_revision),
      });
    }
    return context.json({
      savedAt: timestamp,
      draftRevision: expectedRevision + 1,
      calculation: calculation ? calculationForMember(calculation, auth.canViewCost) : null,
      calculationHash: calculation ? calculationHash(calculation) : null,
    });
  });

  app.post('/:id/publish', async (context) => {
    const auth = context.get('auth');
    const body = (await context.req.json().catch(() => ({}))) as {
      confirmBelowCost?: boolean;
      confirmDemoPrices?: boolean;
      expectedCalculationHash?: unknown;
      expectedDraftRevision?: unknown;
    };
    const quote = getQuote(db, auth.merchantId, context.req.param('id'));
    if (
      !Number.isInteger(body.expectedDraftRevision) ||
      body.expectedDraftRevision !== Number(quote.draft_revision)
    ) {
      throw new AppError(409, 'DRAFT_CHANGED', '待发布草稿与已确认预览不一致，请重新保存并预览', {
        draftRevision: Number(quote.draft_revision),
      });
    }
    const draft = loadDraft(quote.draft_encrypted, config.appSecret);
    if (!draft) throw conflict('NO_EDITABLE_DRAFT', '当前没有可发布的草稿');
    if (!auth.canViewCost && hasManualPriceReduction(db, auth.merchantId, draft, config)) {
      throw new AppError(
        403,
        'PRICE_REDUCTION_APPROVAL_REQUIRED',
        '手工降价、优惠或负数调整需要店主确认后发布',
      );
    }
    const calculation = calculateDraft(db, auth.merchantId, draft, config);
    const currentCalculationHash = calculationHash(calculation);
    if (body.expectedCalculationHash !== currentCalculationHash) {
      throw new AppError(
        409,
        'CALCULATION_CHANGED',
        '价格库或计算结果已变化，请核对新金额后再次发布',
        {
          calculation: calculationForMember(calculation, auth.canViewCost),
          calculationHash: currentCalculationHash,
        },
      );
    }
    if (
      calculation.warnings.some(
        (item) => item.code === 'BELOW_COST' || item.code === 'TOTAL_BELOW_COST',
      ) &&
      !body.confirmBelowCost
    ) {
      throw conflict('BELOW_COST_CONFIRMATION_REQUIRED', '报价低于已录入成本，请确认后再发布');
    }
    if (
      calculation.warnings.some(
        (item) => item.code === 'BELOW_COST' || item.code === 'TOTAL_BELOW_COST',
      ) &&
      !auth.canViewCost
    ) {
      throw new AppError(403, 'OWNER_APPROVAL_REQUIRED', '当前报价需要店主确认后发布');
    }
    const productIds = [...new Set(draft.lines.map((line) => line.productId))];
    const containsDemo = productIds.some((productId) => {
      const row = db
        .prepare('SELECT is_demo FROM products WHERE id = ? AND merchant_id = ?')
        .get(productId, auth.merchantId);
      return row && Number(row.is_demo) === 1;
    });
    if (containsDemo && !body.confirmDemoPrices) {
      throw conflict(
        'DEMO_PRICE_CONFIRMATION_REQUIRED',
        '报价使用了演示价格，请核对并确认后再发布',
      );
    }

    const versionNumber = Number(quote.draft_version);
    const draftRevision = Number(quote.draft_revision);
    if (!Number.isInteger(versionNumber) || versionNumber < 1) {
      throw conflict('INVALID_DRAFT_VERSION', '草稿版本无效，请刷新后重试');
    }
    const versionId = id();
    const timestamp = nowIso();
    const merchant = getMerchantPublicProfile(db, auth.merchantId, config);
    const merchantSettings = db
      .prepare('SELECT timezone FROM merchants WHERE id = ?')
      .get(auth.merchantId);
    if (!merchantSettings) throw notFound('商家不存在');
    if (draft.validUntil < currentDateInTimeZone(String(merchantSettings.timezone))) {
      throw new AppError(400, 'VALID_UNTIL_IN_PAST', '报价有效期不能早于今天');
    }
    const snapshot: QuoteSnapshot = {
      schemaVersion: 1,
      quoteNumber: String(quote.quote_number),
      version: versionNumber,
      publishedAt: timestamp,
      publishedDate: currentDateInTimeZone(String(merchantSettings.timezone)),
      draft,
      calculation,
      merchant,
    };
    const nonce = randomNonce();

    db.transaction(() => {
      const current = getQuote(db, auth.merchantId, context.req.param('id'));
      if (
        current.draft_encrypted === null ||
        Number(current.draft_version) !== versionNumber ||
        Number(current.draft_revision) !== draftRevision
      ) {
        throw conflict('DRAFT_CHANGED', '草稿已发生变化，请刷新后重试');
      }
      const previousVersion = Number(current.current_version);
      if (previousVersion > 0) {
        db.prepare(
          `UPDATE quote_versions
           SET state = 'SUPERSEDED', superseded_by_version = ?, updated_at = ?
           WHERE quote_id = ? AND version_number = ?
             AND state NOT IN ('ACCEPTED', 'WITHDRAWN')`,
        ).run(versionNumber, timestamp, String(current.id), previousVersion);
      }
      db.prepare(
        `INSERT INTO quote_versions(
          id, quote_id, version_number, state, snapshot_encrypted,
          calculation_schema_version, content_hash, total_fen, valid_until, token_nonce,
          published_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        versionId,
        String(current.id),
        versionNumber,
        encryptJson(snapshot, config.appSecret),
        calculation.schemaVersion,
        stableHash(snapshot),
        calculation.totalFen,
        draft.validUntil,
        nonce,
        timestamp,
        auth.userId,
        timestamp,
        timestamp,
      );
      db.prepare(
        `UPDATE quotes SET current_version = ?, draft_encrypted = NULL, draft_version = NULL,
          updated_at = ? WHERE id = ? AND merchant_id = ?`,
      ).run(versionNumber, timestamp, String(current.id), auth.merchantId);
      const markUsed = db.prepare(
        'UPDATE products SET last_used_at = ? WHERE id = ? AND merchant_id = ?',
      );
      for (const productId of productIds) markUsed.run(timestamp, productId, auth.merchantId);
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'QUOTE_PUBLISHED',
        objectType: 'QUOTE_VERSION',
        objectId: versionId,
        summary: `发布 ${String(current.quote_number)} V${versionNumber}`,
      });
    });

    const token = createQuoteToken(versionId, nonce, config.appSecret);
    const sharingAvailable = config.mode !== 'desktop';
    return context.json({
      versionId,
      version: versionNumber,
      state: 'ACTIVE',
      calculation: calculationForMember(calculation, auth.canViewCost),
      shareToken: sharingAvailable ? token : null,
      shareUrl: sharingAvailable ? `${config.publicBaseUrl}/q/${encodeURIComponent(token)}` : null,
    });
  });

  app.post('/:id/new-version', (context) => {
    const auth = context.get('auth');
    const quote = getQuote(db, auth.merchantId, context.req.param('id'));
    if (quote.draft_encrypted !== null) throw conflict('DRAFT_ALREADY_EXISTS', '已有未发布草稿');
    const currentVersion = Number(quote.current_version);
    if (currentVersion < 1) throw conflict('NO_PUBLISHED_VERSION', '尚无可复制的正式版本');
    const version = getMerchantVersion(db, auth.merchantId, String(quote.id), currentVersion);
    const snapshot = decryptSnapshot(version, config);
    const merchant = db
      .prepare(
        'SELECT default_valid_days, default_terms, default_delivery_period, timezone FROM merchants WHERE id = ?',
      )
      .get(auth.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const nextDraft: QuoteDraftData = {
      ...copyFrozenDraft(snapshot),
      validUntil: datePlusInTimeZone(
        String(merchant.timezone),
        Number(merchant.default_valid_days),
      ),
      terms: snapshot.draft.terms || String(merchant.default_terms),
      deliveryPeriod: snapshot.draft.deliveryPeriod || String(merchant.default_delivery_period),
    };
    db.prepare(
      `UPDATE quotes SET draft_encrypted = ?, draft_version = ?,
          draft_revision = draft_revision + 1, updated_at = ?
       WHERE id = ? AND merchant_id = ?`,
    ).run(
      encryptJson(nextDraft, config.appSecret),
      currentVersion + 1,
      nowIso(),
      String(quote.id),
      auth.merchantId,
    );
    return context.json({
      draft: nextDraft,
      draftVersion: currentVersion + 1,
      draftRevision: Number(quote.draft_revision) + 1,
    });
  });

  app.post('/:id/copy', async (context) => {
    const auth = context.get('auth');
    const body = (await context.req.json().catch(() => ({}))) as { keepCustomer?: boolean };
    const quote = getQuote(db, auth.merchantId, context.req.param('id'));
    let source = loadDraft(quote.draft_encrypted, config.appSecret);
    if (!source && Number(quote.current_version) > 0) {
      source = copyFrozenDraft(
        decryptSnapshot(
          getMerchantVersion(db, auth.merchantId, String(quote.id), Number(quote.current_version)),
          config,
        ),
      );
    }
    if (!source) throw conflict('NOTHING_TO_COPY', '当前报价没有可复制内容');
    const merchant = db
      .prepare('SELECT default_valid_days, timezone FROM merchants WHERE id = ?')
      .get(auth.merchantId);
    if (!merchant) throw notFound('商家不存在');
    const copied: QuoteDraftData = {
      ...source,
      customerName: body.keepCustomer ? source.customerName : '新客户',
      customerContact: body.keepCustomer ? source.customerContact : '',
      validUntil: datePlusInTimeZone(
        String(merchant.timezone),
        Number(merchant.default_valid_days),
      ),
    };
    const result = createQuoteRecord(db, config, {
      merchantId: auth.merchantId,
      userId: auth.userId,
      draft: copied,
    });
    return context.json({ ...result, draft: copied, draftRevision: 1 }, 201);
  });

  app.post('/:id/versions/:version/withdraw', (context) => {
    const auth = context.get('auth');
    const versionNumber = Number(context.req.param('version'));
    const timestamp = nowIso();
    db.transaction(() => {
      const result = db
        .prepare(
          `UPDATE quote_versions SET state = 'WITHDRAWN', withdrawn_at = ?, updated_at = ?
         WHERE id IN (
           SELECT v.id FROM quote_versions v JOIN quotes q ON q.id = v.quote_id
           WHERE q.id = ? AND q.merchant_id = ? AND v.version_number = ?
         ) AND state IN ('ACTIVE', 'CHANGE_REQUESTED')`,
        )
        .run(timestamp, timestamp, context.req.param('id'), auth.merchantId, versionNumber);
      if (result.changes !== 1) throw conflict('CANNOT_WITHDRAW', '该报价不存在或当前状态不能撤回');
      audit(db, {
        merchantId: auth.merchantId,
        actorUserId: auth.userId,
        action: 'QUOTE_WITHDRAWN',
        objectType: 'QUOTE_VERSION',
        objectId: `${context.req.param('id')}:V${versionNumber}`,
        summary: `撤回报价 V${versionNumber}`,
      });
    });
    return context.json({ ok: true, state: 'WITHDRAWN' });
  });

  app.get('/notifications/list', (context) => {
    const auth = context.get('auth');
    const rows = db
      .prepare(
        `SELECT * FROM notifications WHERE merchant_id = ?
         ORDER BY CASE WHEN read_at IS NULL THEN 0 ELSE 1 END, created_at DESC LIMIT 100`,
      )
      .all(auth.merchantId)
      .map((row) => ({
        id: String(row.id),
        quoteId: String(row.quote_id),
        versionId: String(row.version_id),
        type: String(row.type),
        title: String(row.title),
        body: String(row.body),
        readAt: row.read_at === null ? null : String(row.read_at),
        resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
        createdAt: String(row.created_at),
      }));
    return context.json({ items: rows });
  });

  app.post('/notifications/:notificationId/read', (context) => {
    const auth = context.get('auth');
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE notifications SET read_at = COALESCE(read_at, ?)
       WHERE id = ? AND merchant_id = ?`,
      )
      .run(timestamp, context.req.param('notificationId'), auth.merchantId);
    if (result.changes !== 1) throw notFound('通知不存在');
    return context.json({ ok: true, readAt: timestamp });
  });

  app.post('/notifications/:notificationId/resolve', (context) => {
    const auth = context.get('auth');
    const timestamp = nowIso();
    const result = db
      .prepare(
        `UPDATE notifications
       SET read_at = COALESCE(read_at, ?), resolved_at = COALESCE(resolved_at, ?)
       WHERE id = ? AND merchant_id = ?`,
      )
      .run(timestamp, timestamp, context.req.param('notificationId'), auth.merchantId);
    if (result.changes !== 1) throw notFound('通知不存在');
    audit(db, {
      merchantId: auth.merchantId,
      actorUserId: auth.userId,
      action: 'NOTIFICATION_RESOLVED',
      objectType: 'NOTIFICATION',
      objectId: context.req.param('notificationId'),
      summary: '客户动态已处理',
    });
    return context.json({ ok: true, resolvedAt: timestamp });
  });

  return app;
}
