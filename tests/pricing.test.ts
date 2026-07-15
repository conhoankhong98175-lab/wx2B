import { describe, expect, it } from 'vitest';

import type { CatalogAddOn, CatalogProduct, QuoteDraftData } from '../shared/contracts.ts';
import { calculateQuote, PricingError, toPublicCalculation } from '../shared/pricing.ts';

const products: CatalogProduct[] = [
  {
    id: 'area-product',
    categoryId: null,
    code: 'P001',
    name: '门头喷绘',
    formulaType: 'AREA',
    unit: '㎡',
    salePrice: '25',
    costPrice: '20',
    minimumCharge: '100',
    lossRate: '10',
    enabled: true,
    notes: '',
  },
  {
    id: 'quantity-product',
    categoryId: null,
    code: 'P002',
    name: '名片',
    formulaType: 'QUANTITY',
    unit: '盒',
    salePrice: '30',
    costPrice: '10',
    minimumCharge: '0',
    lossRate: '0',
    enabled: true,
    notes: '',
  },
  {
    id: 'fixed-product',
    categoryId: null,
    code: 'P003',
    name: '设计费',
    formulaType: 'FIXED',
    unit: '项',
    salePrice: '100',
    costPrice: null,
    minimumCharge: '0',
    lossRate: '0',
    enabled: true,
    notes: '',
  },
];

const addOns: CatalogAddOn[] = [
  {
    id: 'fixed-addon',
    name: '包边',
    pricingType: 'FIXED',
    unit: '项',
    price: '20',
    enabled: true,
    notes: '',
    applicableProductIds: [],
  },
  {
    id: 'order-addon',
    name: '运输',
    pricingType: 'FIXED',
    unit: '次',
    price: '30',
    enabled: true,
    notes: '',
    applicableProductIds: [],
  },
  {
    id: 'percent-addon',
    name: '加急费',
    pricingType: 'PERCENT',
    unit: '%',
    price: '10',
    enabled: true,
    notes: '',
    applicableProductIds: [],
  },
];

function draft(overrides: Partial<QuoteDraftData> = {}): QuoteDraftData {
  return {
    customerName: '示例客户',
    customerContact: '',
    projectName: '门头项目',
    lines: [
      {
        id: 'line-1',
        productId: 'area-product',
        quantity: '1',
        length: { value: '120', unit: 'cm' },
        width: { value: '2400', unit: 'mm' },
        addOns: [{ id: 'line-addon-1', addOnId: 'fixed-addon' }],
        description: '',
      },
    ],
    orderAddOns: [{ id: 'order-addon-1', addOnId: 'order-addon' }],
    discountType: 'PERCENT',
    discountValue: '10',
    manualAdjustment: '5',
    adjustmentReason: '现场条件调整',
    taxMode: 'EXTRA',
    taxRate: '13',
    roundingMode: 'YUAN',
    validUntil: '2026-07-21',
    deliveryPeriod: '3 天',
    notes: '',
    terms: '',
    ...overrides,
  };
}

describe('calculateQuote', () => {
  it('按固定顺序计算面积、损耗、最低收费、附加项、折扣、调整、税和取整', () => {
    const result = calculateQuote(draft(), products, addOns);

    expect(result.lines[0]).toMatchObject({
      actualArea: '2.8800',
      billableArea: '3.1680',
      formulaAmount: '79.20',
      baseAmount: '100.00',
      minimumApplied: true,
      addOnTotal: '20.00',
      lineTotal: '120.00',
    });
    expect(result).toMatchObject({
      subtotal: '150.00',
      discountAmount: '15.00',
      afterDiscount: '135.00',
      manualAdjustment: '5.00',
      preTaxAmount: '140.00',
      taxAmount: '18.20',
      totalBeforeRounding: '158.20',
      total: '158.00',
      totalFen: 15800,
    });
  });

  it('固定价不随数量变化，数量价按数量计算', () => {
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'fixed',
            productId: 'fixed-product',
            quantity: '99',
            addOns: [],
            description: '',
          },
          {
            id: 'quantity',
            productId: 'quantity-product',
            quantity: '5',
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
      }),
      products,
      addOns,
    );

    expect(result.lines[0]?.lineTotal).toBe('100.00');
    expect(result.lines[1]?.lineTotal).toBe('150.00');
    expect(result.total).toBe('250.00');
  });

  it('含税模式不增加总价并正确反算税额', () => {
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'fixed',
            productId: 'fixed-product',
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
        taxMode: 'INCLUDED',
        taxRate: '13',
        roundingMode: 'CENT',
      }),
      products,
      addOns,
    );

    expect(result.total).toBe('100.00');
    expect(result.taxAmount).toBe('11.50');
  });

  it('多个整单比例附加项都以项目小计为基数，结果不受顺序影响', () => {
    const input = draft({
      lines: [
        {
          id: 'fixed',
          productId: 'fixed-product',
          quantity: '1',
          addOns: [],
          description: '',
        },
      ],
      orderAddOns: [
        { id: 'percentage-1', addOnId: 'percent-addon' },
        { id: 'percentage-2', addOnId: 'percent-addon' },
      ],
      discountType: 'NONE',
      discountValue: '0',
      manualAdjustment: '0',
      adjustmentReason: '',
      taxMode: 'NONE',
      taxRate: '0',
      roundingMode: 'CENT',
    });
    const result = calculateQuote(input, products, addOns);
    expect(result.orderAddOns.map((item) => item.amount)).toEqual(['10.00', '10.00']);
    expect(result.total).toBe('120.00');
  });

  it('手工调整没有原因时拒绝计算', () => {
    expect(() =>
      calculateQuote(draft({ manualAdjustment: '-10', adjustmentReason: '' }), products, addOns),
    ).toThrowError(PricingError);
  });

  it('总价不能为负数', () => {
    expect(() =>
      calculateQuote(
        draft({
          lines: [
            {
              id: 'fixed',
              productId: 'fixed-product',
              quantity: '1',
              addOns: [],
              description: '',
            },
          ],
          orderAddOns: [],
          discountType: 'FIXED',
          discountValue: '101',
          manualAdjustment: '0',
          adjustmentReason: '',
        }),
        products,
        addOns,
      ),
    ).toThrowError(expect.objectContaining({ code: 'NEGATIVE_TOTAL' }));
  });

  it('客户输出移除成本、毛利警告和内部字段', () => {
    const internal = calculateQuote(draft(), products, addOns);
    const output = toPublicCalculation(internal);

    expect(output).not.toHaveProperty('warnings');
    expect(output.lines[0]).not.toHaveProperty('costAmount');
    expect(output.lines[0]).not.toHaveProperty('belowCost');
  });

  it('三类公式先保留四位中间金额，再按分形成可对账行合计', () => {
    const precisionProduct: CatalogProduct = {
      ...products[1]!,
      id: 'precision-product',
      salePrice: '1.00495',
      costPrice: null,
    };
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'precision-line',
            productId: precisionProduct.id,
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
      }),
      [precisionProduct],
      [],
    );
    expect(result.lines[0]?.formulaAmount).toBe('1.01');
    expect(result.total).toBe('1.01');
  });

  it('面积先量化到四位再计算金额', () => {
    const product: CatalogProduct = {
      ...products[0]!,
      id: 'area-precision',
      salePrice: '10000',
      costPrice: null,
      minimumCharge: '0',
      lossRate: '0',
    };
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'area-precision-line',
            productId: product.id,
            quantity: '1',
            length: { value: '0.33333', unit: 'm' },
            width: { value: '0.33333', unit: 'm' },
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
      }),
      [product],
      [],
    );
    expect(result.lines[0]?.actualArea).toBe('0.1111');
    expect(result.lines[0]?.formulaAmount).toBe('1111.00');
  });

  it('含税金额按取整后的最终总额反算税额', () => {
    const product: CatalogProduct = {
      ...products[2]!,
      id: 'tax-rounding',
      salePrice: '100.49',
    };
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'tax-line',
            productId: product.id,
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
        taxMode: 'INCLUDED',
        taxRate: '13',
        roundingMode: 'YUAN',
      }),
      [product],
      [],
    );
    expect(result.total).toBe('100.00');
    expect(result.taxAmount).toBe('11.50');
    expect(result.roundingAdjustment).toBe('-0.49');
  });

  it('数量和面积附加项均按明确参数计价', () => {
    const quantityAddOn: CatalogAddOn = {
      id: 'qty-addon',
      name: '打孔',
      pricingType: 'QUANTITY',
      unit: '个',
      price: '2',
      enabled: true,
      notes: '',
      applicableProductIds: [],
    };
    const areaAddOn: CatalogAddOn = {
      id: 'area-addon',
      name: '覆膜',
      pricingType: 'AREA',
      unit: '㎡',
      price: '5',
      enabled: true,
      notes: '',
      applicableProductIds: ['area-product'],
    };
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'line-addons',
            productId: 'area-product',
            quantity: '1',
            length: { value: '1', unit: 'm' },
            width: { value: '2', unit: 'm' },
            addOns: [
              { id: 'qty-ref', addOnId: 'qty-addon', quantity: '6' },
              { id: 'area-ref', addOnId: 'area-addon' },
            ],
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
      }),
      products,
      [quantityAddOn, areaAddOn],
    );
    expect(result.lines[0]?.addOns.map((item) => item.amount)).toEqual(['12.00', '11.00']);
  });

  it('整单折扣后低于已知成本会产生阻断警告', () => {
    const result = calculateQuote(
      draft({
        lines: [
          {
            id: 'cost-line',
            productId: 'fixed-product',
            quantity: '1',
            addOns: [],
            description: '',
          },
        ],
        orderAddOns: [],
        discountType: 'FIXED',
        discountValue: '60',
        manualAdjustment: '0',
        adjustmentReason: '',
        taxMode: 'NONE',
        taxRate: '0',
        roundingMode: 'CENT',
      }),
      [{ ...products[2]!, costPrice: '50' }],
      [],
    );
    expect(result.total).toBe('40.00');
    expect(result.belowCost).toBe(true);
    expect(result.warnings.some((item) => item.code === 'TOTAL_BELOW_COST')).toBe(true);
  });
});
