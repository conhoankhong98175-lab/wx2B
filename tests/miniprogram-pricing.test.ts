import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import type { CatalogAddOn, CatalogProduct, QuoteDraftData } from '../shared/contracts.ts';
import { calculateQuote } from '../shared/pricing.ts';

const sandbox: { module: { exports: unknown } } = { module: { exports: {} } };
runInNewContext(readFileSync(resolve('miniprogram/utils/pricing.js'), 'utf8'), sandbox);
const localPricing = sandbox.module.exports as {
  calculate: (
    draft: QuoteDraftData,
    products: CatalogProduct[],
    addOns: CatalogAddOn[],
  ) => ReturnType<typeof calculateQuote>;
};

describe('小程序本地预估', () => {
  it('与权威引擎的常用公式、附加项、优惠、税费和取整一致', () => {
    const products: CatalogProduct[] = [
      {
        id: 'fixed',
        categoryId: null,
        code: 'F',
        name: '固定项目',
        formulaType: 'FIXED',
        unit: '项',
        salePrice: '100',
        costPrice: null,
        minimumCharge: '0',
        lossRate: '0',
        enabled: true,
        notes: '',
      },
      {
        id: 'quantity',
        categoryId: null,
        code: 'Q',
        name: '数量项目',
        formulaType: 'QUANTITY',
        unit: '个',
        salePrice: '12.345',
        costPrice: null,
        minimumCharge: '20',
        lossRate: '0',
        enabled: true,
        notes: '',
      },
      {
        id: 'area',
        categoryId: null,
        code: 'A',
        name: '面积项目',
        formulaType: 'AREA',
        unit: '㎡',
        salePrice: '35',
        costPrice: null,
        minimumCharge: '50',
        lossRate: '5',
        enabled: true,
        notes: '',
      },
    ];
    const addOns: CatalogAddOn[] = [
      {
        id: 'fixed-addon',
        name: '固定附加',
        pricingType: 'FIXED',
        unit: '项',
        price: '10',
        enabled: true,
        notes: '',
        applicableProductIds: [],
      },
      {
        id: 'quantity-addon',
        name: '数量附加',
        pricingType: 'QUANTITY',
        unit: '个',
        price: '2.5',
        enabled: true,
        notes: '',
        applicableProductIds: [],
      },
      {
        id: 'percent-addon',
        name: '比例附加',
        pricingType: 'PERCENT',
        unit: '%',
        price: '10',
        enabled: true,
        notes: '',
        applicableProductIds: [],
      },
    ];
    const draft: QuoteDraftData = {
      customerName: '本地预估测试',
      customerContact: '',
      projectName: '',
      lines: [
        {
          id: 'line-fixed',
          productId: 'fixed',
          quantity: '1',
          addOns: [{ id: 'la-1', addOnId: 'fixed-addon' }],
          description: '',
        },
        {
          id: 'line-quantity',
          productId: 'quantity',
          quantity: '3',
          addOns: [{ id: 'la-2', addOnId: 'quantity-addon' }],
          description: '',
        },
        {
          id: 'line-area',
          productId: 'area',
          quantity: '2',
          length: { value: '120', unit: 'cm' },
          width: { value: '2', unit: 'm' },
          addOns: [{ id: 'la-3', addOnId: 'percent-addon' }],
          description: '',
        },
      ],
      orderAddOns: [{ id: 'oa-1', addOnId: 'quantity-addon', quantity: '3' }],
      discountType: 'PERCENT',
      discountValue: '5',
      manualAdjustment: '-2',
      adjustmentReason: '测试调整',
      taxMode: 'EXTRA',
      taxRate: '6',
      roundingMode: 'CENT',
      validUntil: '2099-12-31',
      deliveryPeriod: '',
      notes: '',
      terms: '',
    };

    const authoritative = calculateQuote(draft, products, addOns);
    const local = localPricing.calculate(draft, products, addOns);

    expect(local.total).toBe(authoritative.total);
    expect(local.subtotal).toBe(authoritative.subtotal);
    expect(local.discountAmount).toBe(authoritative.discountAmount);
    expect(local.taxAmount).toBe(authoritative.taxAmount);
    expect(local.lines.map((line) => line.lineTotal)).toEqual(
      authoritative.lines.map((line) => line.lineTotal),
    );
    expect(local.lines.map((line) => line.billableArea)).toEqual(
      authoritative.lines.map((line) => line.billableArea),
    );
  });
});
