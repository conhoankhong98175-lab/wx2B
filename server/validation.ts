import { z } from 'zod';

import {
  ADDON_PRICING_TYPES,
  DIMENSION_UNITS,
  DISCOUNT_TYPES,
  FORMULA_TYPES,
  PUBLIC_ACTION_TYPES,
  ROUNDING_MODES,
  TAX_MODES,
} from '../shared/contracts.ts';

const decimalString = z
  .string()
  .max(30)
  .regex(/^-?\d{1,18}(?:\.\d{1,6})?$/, '请输入有效数字');
const nonNegativeDecimal = decimalString.refine((value) => !value.startsWith('-'), '不能小于 0');
const boundedMoney = nonNegativeDecimal.refine(
  (value) => Number(value) <= 1_000_000_000,
  '金额不能超过 10 亿元',
);
const shortText = z.string().trim().max(100);

export const merchantUpdateSchema = z.object({
  name: z.string().trim().min(1, '商家名称不能为空').max(80),
  logoUrl: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === '' || value.startsWith('https://'), 'Logo 必须使用 HTTPS 地址')
    .default(''),
  contactName: shortText.default(''),
  contactPhone: z.string().trim().max(30).default(''),
  contactWechat: z.string().trim().max(50).default(''),
  defaultValidDays: z.number().int().min(1).max(365).default(7),
  defaultDeliveryPeriod: z.string().trim().max(200).default(''),
  defaultTerms: z.string().trim().max(3000).default(''),
  roundingMode: z.enum(ROUNDING_MODES).default('CENT'),
  onboardingCompleted: z.boolean().default(true),
});

export const categorySchema = z.object({
  name: z.string().trim().min(1).max(50),
  sortOrder: z.number().int().min(-10000).max(10000).default(0),
  enabled: z.boolean().default(true),
});

export const productSchema = z.object({
  categoryId: z.string().uuid().nullable().default(null),
  code: z.string().trim().max(50).default(''),
  name: z.string().trim().min(1).max(100),
  formulaType: z.enum(FORMULA_TYPES),
  unit: z.string().trim().min(1).max(20),
  salePrice: boundedMoney,
  costPrice: boundedMoney.nullable().default(null),
  minimumCharge: boundedMoney.default('0'),
  lossRate: nonNegativeDecimal
    .refine((value) => Number(value) <= 100, '损耗率不能超过 100%')
    .default('0'),
  notes: z.string().trim().max(500).default(''),
  enabled: z.boolean().default(true),
  isDemo: z.boolean().default(false),
});

export const addOnSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    pricingType: z.enum(ADDON_PRICING_TYPES),
    unit: z.string().trim().min(1).max(20),
    price: boundedMoney,
    notes: z.string().trim().max(500).default(''),
    enabled: z.boolean().default(true),
    applicableProductIds: z.array(z.string().uuid()).max(100).default([]),
  })
  .superRefine((value, context) => {
    if (value.pricingType === 'PERCENT' && Number(value.price) > 100) {
      context.addIssue({ code: 'custom', path: ['price'], message: '比例不能超过 100%' });
    }
  });

const dimensionSchema = z.object({
  value: decimalString,
  unit: z.enum(DIMENSION_UNITS),
});

const draftAddOnSchema = z.object({
  id: z.string().min(1).max(100),
  addOnId: z.string().uuid(),
  quantity: decimalString.optional(),
  area: decimalString.optional(),
  priceOverride: nonNegativeDecimal.optional(),
});

const draftLineSchema = z.object({
  id: z.string().min(1).max(100),
  productId: z.string().uuid(),
  quantity: decimalString,
  length: dimensionSchema.optional(),
  width: dimensionSchema.optional(),
  unitPriceOverride: nonNegativeDecimal.optional(),
  addOns: z.array(draftAddOnSchema).max(20).default([]),
  description: z.string().trim().max(500).default(''),
});

export const quoteDraftSchema = z.object({
  customerName: z.string().trim().min(1, '客户名称不能为空').max(100),
  customerContact: z.string().trim().max(100).default(''),
  projectName: z.string().trim().max(100).default(''),
  lines: z.array(draftLineSchema).max(100).default([]),
  orderAddOns: z.array(draftAddOnSchema).max(20).default([]),
  discountType: z.enum(DISCOUNT_TYPES).default('NONE'),
  discountValue: nonNegativeDecimal.default('0'),
  manualAdjustment: decimalString.default('0'),
  adjustmentReason: z.string().trim().max(500).default(''),
  taxMode: z.enum(TAX_MODES).default('NONE'),
  taxRate: nonNegativeDecimal.default('0'),
  roundingMode: z.enum(ROUNDING_MODES).default('CENT'),
  validUntil: z.iso.date(),
  deliveryPeriod: z.string().trim().max(200).default(''),
  notes: z.string().trim().max(2000).default(''),
  terms: z.string().trim().max(3000).default(''),
});

export const publicActionSchema = z.object({
  type: z.enum(PUBLIC_ACTION_TYPES),
  requestId: z.string().min(8).max(100),
  anonymousId: z.string().max(100).default(''),
  message: z.string().trim().max(500).default(''),
});

export const localLoginSchema = z.object({
  displayName: z.string().trim().min(1).max(80).default('我的店铺'),
});

export const wechatLoginSchema = z.object({
  code: z.string().trim().min(3).max(200),
});
