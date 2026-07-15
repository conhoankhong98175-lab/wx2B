export const FORMULA_TYPES = ['FIXED', 'QUANTITY', 'AREA'] as const;
export type FormulaType = (typeof FORMULA_TYPES)[number];

export const ADDON_PRICING_TYPES = ['FIXED', 'QUANTITY', 'AREA', 'PERCENT'] as const;
export type AddOnPricingType = (typeof ADDON_PRICING_TYPES)[number];

export const DIMENSION_UNITS = ['mm', 'cm', 'm'] as const;
export type DimensionUnit = (typeof DIMENSION_UNITS)[number];

export const DISCOUNT_TYPES = ['NONE', 'FIXED', 'PERCENT'] as const;
export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const TAX_MODES = ['NONE', 'INCLUDED', 'EXTRA'] as const;
export type TaxMode = (typeof TAX_MODES)[number];

export const ROUNDING_MODES = ['CENT', 'JIAO', 'YUAN'] as const;
export type RoundingMode = (typeof ROUNDING_MODES)[number];

export const QUOTE_STATES = [
  'ACTIVE',
  'CHANGE_REQUESTED',
  'ACCEPTED',
  'EXPIRED',
  'WITHDRAWN',
  'SUPERSEDED',
] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];

export const PUBLIC_ACTION_TYPES = ['VIEW', 'ACCEPT', 'QUESTION', 'CHANGE_REQUEST'] as const;
export type PublicActionType = (typeof PUBLIC_ACTION_TYPES)[number];

export interface CatalogProduct {
  id: string;
  categoryId: string | null;
  code: string;
  name: string;
  formulaType: FormulaType;
  unit: string;
  salePrice: string;
  costPrice: string | null;
  minimumCharge: string;
  lossRate: string;
  enabled: boolean;
  notes: string;
}

export interface CatalogAddOn {
  id: string;
  name: string;
  pricingType: AddOnPricingType;
  unit: string;
  price: string;
  enabled: boolean;
  notes: string;
  applicableProductIds: string[];
}

export interface DimensionInput {
  value: string;
  unit: DimensionUnit;
}

export interface DraftAddOnInput {
  id: string;
  addOnId: string;
  quantity?: string | undefined;
  area?: string | undefined;
  priceOverride?: string | undefined;
}

export interface DraftLineInput {
  id: string;
  productId: string;
  quantity: string;
  length?: DimensionInput | undefined;
  width?: DimensionInput | undefined;
  unitPriceOverride?: string | undefined;
  addOns: DraftAddOnInput[];
  description: string;
}

export interface QuoteDraftData {
  customerName: string;
  customerContact: string;
  projectName: string;
  lines: DraftLineInput[];
  orderAddOns: DraftAddOnInput[];
  discountType: DiscountType;
  discountValue: string;
  manualAdjustment: string;
  adjustmentReason: string;
  taxMode: TaxMode;
  taxRate: string;
  roundingMode: RoundingMode;
  validUntil: string;
  deliveryPeriod: string;
  notes: string;
  terms: string;
}

export interface CalculatedAddOn {
  id: string;
  addOnId: string;
  name: string;
  pricingType: AddOnPricingType;
  unit: string;
  parameter: string;
  price: string;
  amount: string;
}

export interface CalculatedLine {
  id: string;
  productId: string;
  code: string;
  name: string;
  formulaType: FormulaType;
  unit: string;
  quantity: string;
  lengthMeters: string | null;
  widthMeters: string | null;
  actualArea: string | null;
  billableArea: string | null;
  lossRate: string;
  unitPrice: string;
  minimumCharge: string;
  formulaAmount: string;
  baseAmount: string;
  minimumApplied: boolean;
  addOns: CalculatedAddOn[];
  addOnTotal: string;
  lineTotal: string;
  costAmount: string | null;
  belowCost: boolean;
  description: string;
}

export interface PricingWarning {
  code: 'BELOW_COST' | 'TOTAL_BELOW_COST' | 'MINIMUM_APPLIED' | 'PRICE_OVERRIDDEN';
  lineId: string;
  message: string;
}

export interface QuoteCalculation {
  schemaVersion: 1;
  currency: 'CNY';
  lines: CalculatedLine[];
  orderAddOns: CalculatedAddOn[];
  subtotal: string;
  discountAmount: string;
  afterDiscount: string;
  manualAdjustment: string;
  preTaxAmount: string;
  taxMode: TaxMode;
  taxRate: string;
  taxAmount: string;
  totalBeforeRounding: string;
  roundingMode: RoundingMode;
  roundingAdjustment: string;
  total: string;
  totalFen: number;
  internalCostTotal: string | null;
  belowCost: boolean;
  warnings: PricingWarning[];
}

export interface MerchantPublicProfile {
  name: string;
  logoUrl: string;
  contactName: string;
  contactPhone: string;
  contactWechat: string;
}

export interface PublicQuoteDocument {
  quoteNumber: string;
  version: number;
  state: QuoteState;
  publishedAt: string;
  publishedDate: string;
  validUntil: string;
  merchant: MerchantPublicProfile;
  customerName: string;
  projectName: string;
  deliveryPeriod: string;
  notes: string;
  terms: string;
  calculation: Omit<QuoteCalculation, 'warnings' | 'lines' | 'internalCostTotal' | 'belowCost'> & {
    lines: Array<Omit<CalculatedLine, 'costAmount' | 'belowCost'>>;
  };
  firstViewedAt: string | null;
  acceptedAt: string | null;
  supersededByVersion: number | null;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}
