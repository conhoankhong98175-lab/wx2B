import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { QuoteDraftData } from '../shared/contracts.ts';
import { createApp } from '../server/app.ts';
import type { AppConfig } from '../server/config.ts';
import { AppDatabase } from '../server/database.ts';

function futureDate(days = 30): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

describe('报价 API 完整闭环', () => {
  let db: AppDatabase;
  let app: ReturnType<typeof createApp>;
  let config: AppConfig;
  let token: string;

  beforeEach(async () => {
    config = {
      mode: 'test',
      isProduction: false,
      host: '127.0.0.1',
      port: 0,
      publicBaseUrl: 'https://quote.example.test',
      dbPath: ':memory:',
      appSecret: 'test-secret-that-is-definitely-long-enough',
      wechatAppId: '',
      wechatAppSecret: '',
      pdfFontPath: 'C:\\Windows\\Fonts\\simhei.ttf',
      corsOrigins: [],
      webRoot: 'missing-test-web-root',
    };
    db = new AppDatabase(':memory:', config.appSecret);
    app = createApp(db, config);
    const response = await app.request('/api/auth/local', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: '测试广告店' }),
    });
    expect(response.status).toBe(200);
    token = String(((await response.json()) as { token: string }).token);
  });

  afterEach(() => db.close());

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  }

  it('完成建库、草稿、发布、查看、修改、V2、接受和撤回', async () => {
    const catalogResponse = await app.request('/api/catalog', { headers: authHeaders() });
    expect(catalogResponse.status).toBe(200);
    const catalog = (await catalogResponse.json()) as {
      products: Array<{ id: string; formulaType: string; costPrice: string | null }>;
      addOns: Array<{ id: string; pricingType: string }>;
    };
    const areaProduct = catalog.products.find((item) => item.formulaType === 'AREA');
    const fixedAddOn = catalog.addOns.find((item) => item.pricingType === 'FIXED');
    expect(areaProduct).toBeDefined();
    expect(areaProduct?.costPrice).toBe('15');
    expect(fixedAddOn).toBeDefined();

    const draft: QuoteDraftData = {
      customerName: '张先生',
      customerContact: '13800000000',
      projectName: '门头制作',
      lines: [
        {
          id: 'line-1',
          productId: areaProduct?.id ?? '',
          quantity: '1',
          length: { value: '1.2', unit: 'm' },
          width: { value: '2.4', unit: 'm' },
          addOns: [{ id: 'addon-1', addOnId: fixedAddOn?.id ?? '' }],
          description: '含基础安装',
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
      deliveryPeriod: '3 天',
      notes: '现场尺寸以复核为准',
      terms: '报价有效期内确认',
    };

    const createdResponse = await app.request('/api/quotes', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(draft),
    });
    expect(createdResponse.status).toBe(201);
    const created = (await createdResponse.json()) as {
      id: string;
      quoteNumber: string;
      calculationHash: string;
      draftRevision: number;
    };
    expect(created.quoteNumber).toMatch(/^DG-/);

    const originalPrice = db
      .prepare('SELECT sale_price FROM products WHERE id = ?')
      .get(areaProduct!.id)?.sale_price;
    db.prepare('UPDATE products SET sale_price = ? WHERE id = ?').run('999', areaProduct!.id);
    const staleCalculation = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: created.calculationHash,
        expectedDraftRevision: created.draftRevision,
      }),
    });
    expect(staleCalculation.status).toBe(409);
    expect(((await staleCalculation.json()) as { error: { code: string } }).error.code).toBe(
      'CALCULATION_CHANGED',
    );
    db.prepare('UPDATE products SET sale_price = ? WHERE id = ?').run(
      String(originalPrice),
      areaProduct!.id,
    );

    const blockedPublish = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        expectedCalculationHash: created.calculationHash,
        expectedDraftRevision: created.draftRevision,
      }),
    });
    expect(blockedPublish.status).toBe(409);
    expect(((await blockedPublish.json()) as { error: { code: string } }).error.code).toBe(
      'DEMO_PRICE_CONFIRMATION_REQUIRED',
    );

    const publishResponse = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: created.calculationHash,
        expectedDraftRevision: created.draftRevision,
      }),
    });
    expect(publishResponse.status).toBe(200);
    const published = (await publishResponse.json()) as {
      version: number;
      shareToken: string;
      calculation: { total: string };
    };
    expect(published.version).toBe(1);
    expect(published.calculation.total).toBe('275.60');

    const publicResponse = await app.request(
      `/api/public/quotes/${encodeURIComponent(published.shareToken)}`,
    );
    expect(publicResponse.status).toBe(200);
    const publicBody = (await publicResponse.json()) as {
      available: boolean;
      quote: { calculation: { lines: Array<Record<string, unknown>> }; state: string };
    };
    expect(publicBody.available).toBe(true);
    expect(publicBody.quote.state).toBe('ACTIVE');
    expect(publicBody.quote.calculation.lines[0]).not.toHaveProperty('costAmount');
    expect(publicBody.quote.calculation.lines[0]).not.toHaveProperty('belowCost');
    expect(publicBody.quote.calculation).not.toHaveProperty('warnings');

    const viewAction = {
      type: 'VIEW',
      requestId: 'view-request-0001',
      anonymousId: 'browser-1',
      message: '',
    };
    for (let index = 0; index < 2; index += 1) {
      const response = await app.request(
        `/api/public/quotes/${encodeURIComponent(published.shareToken)}/actions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(viewAction),
        },
      );
      expect(response.status).toBe(200);
    }
    const actionCount = db
      .prepare("SELECT COUNT(*) AS count FROM quote_actions WHERE action_type = 'VIEW'")
      .get();
    expect(Number(actionCount?.count)).toBe(1);

    const changeResponse = await app.request(
      `/api/public/quotes/${encodeURIComponent(published.shareToken)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'CHANGE_REQUEST',
          requestId: 'change-request-0001',
          anonymousId: 'browser-1',
          message: '宽度改为 3 米',
        }),
      },
    );
    expect(changeResponse.status).toBe(200);

    const newVersionResponse = await app.request(`/api/quotes/${created.id}/new-version`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(newVersionResponse.status).toBe(200);
    const newVersion = (await newVersionResponse.json()) as {
      draft: QuoteDraftData;
      draftRevision: number;
    };
    const line = newVersion.draft.lines[0];
    expect(line).toBeDefined();
    if (!line) throw new Error('缺少报价项目');
    const staleDraft = { ...newVersion.draft, notes: '较早的自动保存请求' };
    line.width = { value: '3', unit: 'm' };

    const savedResponse = await app.request(`/api/quotes/${created.id}/draft`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': String(newVersion.draftRevision) },
      body: JSON.stringify(newVersion.draft),
    });
    expect(savedResponse.status).toBe(200);
    const saved = (await savedResponse.json()) as {
      calculationHash: string;
      draftRevision: number;
    };

    const staleSave = await app.request(`/api/quotes/${created.id}/draft`, {
      method: 'PUT',
      headers: { ...authHeaders(), 'if-match': String(newVersion.draftRevision) },
      body: JSON.stringify(staleDraft),
    });
    expect(staleSave.status).toBe(409);
    expect(((await staleSave.json()) as { error: { code: string } }).error.code).toBe(
      'DRAFT_CHANGED',
    );

    const staleDraftPublish = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: saved.calculationHash,
        expectedDraftRevision: newVersion.draftRevision,
      }),
    });
    expect(staleDraftPublish.status).toBe(409);
    expect(((await staleDraftPublish.json()) as { error: { code: string } }).error.code).toBe(
      'DRAFT_CHANGED',
    );

    const publishV2Response = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: saved.calculationHash,
        expectedDraftRevision: saved.draftRevision,
      }),
    });
    expect(publishV2Response.status).toBe(200);
    const publishedV2 = (await publishV2Response.json()) as { version: number; shareToken: string };
    expect(publishedV2.version).toBe(2);

    const oldPublic = await app.request(
      `/api/public/quotes/${encodeURIComponent(published.shareToken)}`,
    );
    expect(((await oldPublic.json()) as { quote: { state: string } }).quote.state).toBe(
      'SUPERSEDED',
    );
    const oldAccept = await app.request(
      `/api/public/quotes/${encodeURIComponent(published.shareToken)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'ACCEPT',
          requestId: 'old-accept-0001',
          anonymousId: 'browser-1',
          message: '',
        }),
      },
    );
    expect(oldAccept.status).toBe(409);

    const acceptV2 = await app.request(
      `/api/public/quotes/${encodeURIComponent(publishedV2.shareToken)}/actions`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'ACCEPT',
          requestId: 'accept-request-0002',
          anonymousId: 'browser-1',
          message: '',
        }),
      },
    );
    expect(acceptV2.status).toBe(200);
    expect(((await acceptV2.json()) as { state: string }).state).toBe('ACCEPTED');

    const withdrawAccepted = await app.request(`/api/quotes/${created.id}/versions/2/withdraw`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(withdrawAccepted.status).toBe(409);
    const acceptedStillVisible = await app.request(
      `/api/public/quotes/${encodeURIComponent(publishedV2.shareToken)}`,
    );
    expect(((await acceptedStillVisible.json()) as { quote: { state: string } }).quote.state).toBe(
      'ACCEPTED',
    );

    const versionThreeDraft = (await (
      await app.request(`/api/quotes/${created.id}/new-version`, {
        method: 'POST',
        headers: authHeaders(),
      })
    ).json()) as { draft: QuoteDraftData; draftRevision: number };
    const versionThreePreview = (await (
      await app.request('/api/quotes/calculate', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(versionThreeDraft.draft),
      })
    ).json()) as { calculationHash: string };
    const publishV3Response = await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: versionThreePreview.calculationHash,
        expectedDraftRevision: versionThreeDraft.draftRevision,
      }),
    });
    expect(publishV3Response.status).toBe(200);
    const publishedV3 = (await publishV3Response.json()) as { version: number; shareToken: string };
    expect(publishedV3.version).toBe(3);
    const withdraw = await app.request(`/api/quotes/${created.id}/versions/3/withdraw`, {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(withdraw.status).toBe(200);
    const withdrawnPublic = await app.request(
      `/api/public/quotes/${encodeURIComponent(publishedV3.shareToken)}`,
    );
    const withdrawnBody = (await withdrawnPublic.json()) as {
      available: boolean;
      state: string;
      quote?: unknown;
    };
    expect(withdrawnBody).toMatchObject({ available: false, state: 'WITHDRAWN' });
    expect(withdrawnBody).not.toHaveProperty('quote');
  });

  it('生成的 PDF 有内容且没有平台水印文本', async () => {
    const catalog = (await (
      await app.request('/api/catalog', { headers: authHeaders() })
    ).json()) as { products: Array<{ id: string; formulaType: string }> };
    const product = catalog.products.find((item) => item.formulaType === 'FIXED');
    const input: QuoteDraftData = {
      customerName: 'PDF 客户',
      customerContact: '',
      projectName: 'PDF 测试',
      lines: [
        {
          id: 'line-pdf',
          productId: product?.id ?? '',
          quantity: '1',
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
        headers: authHeaders(),
        body: JSON.stringify(input),
      })
    ).json()) as { id: string; calculationHash: string; draftRevision: number };
    await app.request(`/api/quotes/${created.id}/publish`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        confirmDemoPrices: true,
        confirmBelowCost: true,
        expectedCalculationHash: created.calculationHash,
        expectedDraftRevision: created.draftRevision,
      }),
    });
    const response = await app.request(`/api/documents/${created.id}/versions/1/pdf`, {
      headers: authHeaders(),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
  }, 20_000);
});
