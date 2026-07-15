import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuoteDraftData } from '../shared/contracts.ts';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { AppDatabase } from '../server/database.ts';
import { createAccessToken } from '../server/security.ts';

function futureDate(days = 30): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('鉴权、租户隔离与不可变证据', () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let ownerToken: string;
  let ownerUserId: string;
  let merchantId: string;

  beforeEach(async () => {
    config = {
      mode: 'test',
      isProduction: false,
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'https://quote.example.test',
      dbPath: ':memory:',
      appSecret: 'security-test-secret-that-is-long-enough',
      wechatAppId: '',
      wechatAppSecret: '',
      pdfFontPath: 'C:\\Windows\\Fonts\\simhei.ttf',
      corsOrigins: [],
      webRoot: 'missing',
    };
    db = new AppDatabase(':memory:', config.appSecret);
    app = createApp(db, config);
    const login = await app.request('/api/auth/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '安全测试店铺' }),
    });
    const result = (await login.json()) as {
      token: string;
      auth: { userId: string; merchantId: string };
    };
    ownerToken = result.token;
    ownerUserId = result.auth.userId;
    merchantId = result.auth.merchantId;
  });

  afterEach(() => db.close());

  const headers = (token = ownerToken) => ({
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  });

  async function createPublishedQuote(): Promise<{
    quoteId: string;
    shareToken: string;
    productId: string;
  }> {
    const catalog = (await (await app.request('/api/catalog', { headers: headers() })).json()) as {
      products: Array<{ id: string; formulaType: string }>;
    };
    const productId = catalog.products.find((item) => item.formulaType === 'QUANTITY')?.id ?? '';
    const draft: QuoteDraftData = {
      customerName: '安全客户',
      customerContact: '13800000000',
      projectName: '安全测试',
      lines: [
        {
          id: 'security-line',
          productId,
          quantity: '1',
          unitPriceOverride: '1',
          addOns: [],
          description: '',
        },
      ],
      orderAddOns: [],
      discountType: 'NONE',
      discountValue: '0',
      manualAdjustment: '0',
      adjustmentReason: '',
      taxMode: 'NONE',
      taxRate: '0',
      roundingMode: 'CENT',
      validUntil: futureDate(),
      deliveryPeriod: '',
      notes: '',
      terms: '',
    };
    const created = (await (
      await app.request('/api/quotes', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(draft),
      })
    ).json()) as { id: string; calculationHash: string; draftRevision: number };
    const publish = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: created.calculationHash,
        expectedDraftRevision: created.draftRevision,
      }),
    });
    expect(publish.status).toBe(200);
    const published = (await publish.json()) as { shareToken: string };
    return { quoteId: created.id, shareToken: published.shareToken, productId };
  }

  it('公开路由免登录，受保护路由必须认证，成本在数据库中加密', async () => {
    expect((await app.request('/api/merchant')).status).toBe(401);
    expect((await app.request('/api/catalog')).status).toBe(401);
    expect((await app.request('/api/quotes')).status).toBe(401);
    expect((await app.request('/api/public/quotes/not-a-valid-token')).status).toBe(404);

    const raw = db
      .prepare('SELECT cost_price FROM products WHERE cost_price IS NOT NULL LIMIT 1')
      .get();
    expect(String(raw?.cost_price)).toMatch(/^v1\./);
    expect(String(raw?.cost_price)).not.toContain('15');
  });

  it('跨租户分类不能关联到当前商家的产品', async () => {
    const merchantB = crypto.randomUUID();
    const categoryB = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(
      `INSERT INTO merchants(id, name, created_at, updated_at) VALUES (?, 'B店', ?, ?)`,
    ).run(merchantB, timestamp, timestamp);
    db.prepare(
      `INSERT INTO product_categories(id, merchant_id, name, created_at, updated_at)
       VALUES (?, ?, 'B分类', ?, ?)`,
    ).run(categoryB, merchantB, timestamp, timestamp);

    const response = await app.request('/api/catalog/products', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({
        categoryId: categoryB,
        code: 'CROSS',
        name: '越权产品',
        formulaType: 'FIXED',
        unit: '项',
        salePrice: '10',
        costPrice: null,
        minimumCharge: '0',
        lossRate: '0',
        notes: '',
        enabled: true,
        isDemo: false,
      }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_CATEGORY',
    );
  });

  it('无成本权限成员看不到成本、不能录成本，也不能越权确认低价发布', async () => {
    const userId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare('INSERT INTO users(id, status, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
      userId,
      'ACTIVE',
      timestamp,
      timestamp,
    );
    db.prepare(
      `INSERT INTO memberships(
        user_id, merchant_id, role, can_view_cost, status, created_at, updated_at
      ) VALUES (?, ?, 'QUOTER', 0, 'ACTIVE', ?, ?)`,
    ).run(userId, merchantId, timestamp, timestamp);
    const quoterToken = createAccessToken(
      { sub: userId, merchantId, role: 'QUOTER', canViewCost: false },
      config.appSecret,
    );

    const catalogResponse = await app.request('/api/catalog', { headers: headers(quoterToken) });
    const catalog = (await catalogResponse.json()) as { products: Array<{ costPrice: unknown }> };
    expect(catalog.products.every((item) => item.costPrice === null)).toBe(true);

    const createProduct = await app.request('/api/catalog/products', {
      method: 'POST',
      headers: headers(quoterToken),
      body: JSON.stringify({
        categoryId: null,
        code: 'NO-COST-PERMISSION',
        name: '无权限成本',
        formulaType: 'FIXED',
        unit: '项',
        salePrice: '10',
        costPrice: '8',
        minimumCharge: '0',
        lossRate: '0',
        notes: '',
        enabled: true,
        isDemo: false,
      }),
    });
    expect(createProduct.status).toBe(403);

    const published = await createPublishedQuote();
    const nextDraft = (await (
      await app.request(`/api/quotes/${published.quoteId}/new-version`, {
        method: 'POST',
        headers: headers(),
      })
    ).json()) as { draftRevision: number };
    const lowPublish = await app.request(`/api/quotes/${published.quoteId}/publish`, {
      method: 'POST',
      headers: headers(quoterToken),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedDraftRevision: nextDraft.draftRevision,
      }),
    });
    expect(lowPublish.status).toBe(403);
    expect(((await lowPublish.json()) as { error: { code: string } }).error.code).toBe(
      'PRICE_REDUCTION_APPROVAL_REQUIRED',
    );
  });

  it('成员停用后旧令牌立即失效', async () => {
    db.prepare(
      "UPDATE memberships SET status = 'DISABLED' WHERE user_id = ? AND merchant_id = ?",
    ).run(ownerUserId, merchantId);
    const response = await app.request('/api/merchant', { headers: headers() });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'ACCOUNT_DISABLED',
    );
  });

  it('相同幂等键不能换成另一种客户动作', async () => {
    const quote = await createPublishedQuote();
    const key = 'same-idempotency-key-0001';
    const view = await app.request(
      `/api/public/quotes/${encodeURIComponent(quote.shareToken)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'VIEW', requestId: key, anonymousId: 'browser', message: '' }),
      },
    );
    expect(view.status).toBe(200);
    const accept = await app.request(
      `/api/public/quotes/${encodeURIComponent(quote.shareToken)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'ACCEPT',
          requestId: key,
          anonymousId: 'browser',
          message: '',
        }),
      },
    );
    expect(accept.status).toBe(409);
    expect(((await accept.json()) as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(() => db.prepare('UPDATE quote_actions SET request_id = request_id').run()).toThrow(
      /QUOTE_ACTION_IS_IMMUTABLE/,
    );
    expect(() => db.prepare('DELETE FROM quote_actions').run()).toThrow(
      /QUOTE_ACTION_DELETE_FORBIDDEN/,
    );
  });

  it('普通数据库操作不能删除正式版本，账户删除后公开链接立即失效', async () => {
    const quote = await createPublishedQuote();
    expect(() => db.prepare('DELETE FROM quote_versions').run()).toThrow(
      /PUBLISHED_QUOTE_VERSION_DELETE_FORBIDDEN/,
    );
    const merchant = (await (
      await app.request('/api/merchant', { headers: headers() })
    ).json()) as { name: string };
    const deleted = await app.request('/api/merchant/account', {
      method: 'DELETE',
      headers: headers(),
      body: JSON.stringify({ confirmation: merchant.name }),
    });
    expect(deleted.status).toBe(200);
    const publicResponse = await app.request(
      `/api/public/quotes/${encodeURIComponent(quote.shareToken)}`,
    );
    expect(publicResponse.status).toBe(404);
  });

  it('Windows 本地模式不返回无法从外网访问的 localhost 客户链接', async () => {
    const quote = await createPublishedQuote();
    const desktopApp = createApp(db, {
      ...config,
      mode: 'desktop',
      publicBaseUrl: 'http://127.0.0.1:34567',
    });
    const response = await desktopApp.request(`/api/quotes/${quote.quoteId}`, {
      headers: headers(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sharingAvailable: boolean;
      versions: Array<{ shareToken: string | null; shareUrl: string | null }>;
    };
    expect(body.sharingAvailable).toBe(false);
    expect(body.versions[0]).toMatchObject({ shareToken: null, shareUrl: null });
  });
});
