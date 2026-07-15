import { Decimal } from 'decimal.js';

import type {
  CalculatedAddOn,
  CalculatedLine,
  CatalogAddOn,
  CatalogProduct,
  DimensionInput,
  DraftAddOnInput,
  DraftLineInput,
  PricingWarning,
  QuoteCalculation,
  QuoteDraftData,
  RoundingMode,
} from './contracts.ts';

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

const ZERO = new Decimal(0);
const ONE_HUNDRED = new Decimal(100);
const MAX_PRICE = new Decimal('1000000000');
const MAX_QUANTITY = new Decimal('1000000');
const MAX_LENGTH_METERS = new Decimal('100000');

export class PricingError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly path: string,
  ) {
    super(message);
    this.name = 'PricingError';
  }
}

function decimal(value: string, path: string): Decimal {
  let parsed: Decimal;
  try {
    parsed = new Decimal(value || '0');
  } catch {
    throw new PricingError('INVALID_NUMBER', '请输入有效数字', path);
  }
  if (!parsed.isFinite()) {
    throw new PricingError('INVALID_NUMBER', '请输入有限数字', path);
  }
  return parsed;
}

function positive(value: string, path: string, maximum: Decimal): Decimal {
  const parsed = decimal(value, path);
  if (parsed.lte(0)) {
    throw new PricingError('MUST_BE_POSITIVE', '数值必须大于 0', path);
  }
  if (parsed.gt(maximum)) {
    throw new PricingError('VALUE_TOO_LARGE', '数值超过允许范围', path);
  }
  return parsed;
}

function nonNegative(value: string, path: string, maximum = MAX_PRICE): Decimal {
  const parsed = decimal(value, path);
  if (parsed.lt(0)) {
    throw new PricingError('MUST_BE_NON_NEGATIVE', '数值不能小于 0', path);
  }
  if (parsed.gt(maximum)) {
    throw new PricingError('VALUE_TOO_LARGE', '数值超过允许范围', path);
  }
  return parsed;
}

function percentage(value: string, path: string): Decimal {
  const parsed = nonNegative(value, path, ONE_HUNDRED);
  return parsed;
}

function money(value: Decimal): string {
  return value.toDecimalPlaces(2).toFixed(2);
}

function intermediate(value: Decimal): Decimal {
  return value.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

function precise(value: Decimal): string {
  return value.toDecimalPlaces(4).toFixed(4);
}

function dimensionToMeters(input: DimensionInput, path: string): Decimal {
  const value = positive(input.value, path, new Decimal('100000000'));
  let meters: Decimal;
  switch (input.unit) {
    case 'mm':
      meters = value.div(1000);
      break;
    case 'cm':
      meters = value.div(100);
      break;
    case 'm':
      meters = value;
      break;
  }
  if (meters.gt(MAX_LENGTH_METERS)) {
    throw new PricingError('VALUE_TOO_LARGE', '换算后的尺寸超过允许范围', path);
  }
  return meters;
}

function calculateAddOn(
  input: DraftAddOnInput,
  catalog: Map<string, CatalogAddOn>,
  context: {
    quantity: Decimal;
    area: Decimal | null;
    baseAmount: Decimal;
    productId: string | null;
  },
  path: string,
): { result: CalculatedAddOn; amount: Decimal } {
  const addOn = catalog.get(input.addOnId);
  if (!addOn || !addOn.enabled) {
    throw new PricingError('ADDON_NOT_AVAILABLE', '附加项不存在或已停用', `${path}.addOnId`);
  }
  if (
    context.productId &&
    addOn.applicableProductIds.length > 0 &&
    !addOn.applicableProductIds.includes(context.productId)
  ) {
    throw new PricingError('ADDON_NOT_APPLICABLE', '该附加项不适用于当前产品', path);
  }

  const price = input.priceOverride
    ? nonNegative(input.priceOverride, `${path}.priceOverride`)
    : nonNegative(addOn.price, `${path}.price`);
  let parameter = new Decimal(1);
  let amount: Decimal;

  switch (addOn.pricingType) {
    case 'FIXED':
      amount = price;
      break;
    case 'QUANTITY':
      parameter = input.quantity
        ? positive(input.quantity, `${path}.quantity`, MAX_QUANTITY)
        : context.quantity;
      amount = parameter.mul(price);
      break;
    case 'AREA':
      parameter = input.area
        ? positive(input.area, `${path}.area`, new Decimal('10000000000'))
        : (context.area ?? ZERO);
      if (parameter.lte(0)) {
        throw new PricingError('AREA_REQUIRED', '按面积计价的附加项需要有效面积', path);
      }
      amount = parameter.mul(price);
      break;
    case 'PERCENT':
      percentage(price.toString(), `${path}.price`);
      parameter = price;
      amount = context.baseAmount.mul(price).div(ONE_HUNDRED);
      break;
  }

  const roundedAmount = intermediate(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return {
    amount: roundedAmount,
    result: {
      id: input.id,
      addOnId: addOn.id,
      name: addOn.name,
      pricingType: addOn.pricingType,
      unit: addOn.unit,
      parameter: precise(parameter),
      price: precise(price),
      amount: money(roundedAmount),
    },
  };
}

function calculateLine(
  input: DraftLineInput,
  products: Map<string, CatalogProduct>,
  addOns: Map<string, CatalogAddOn>,
  path: string,
): { result: CalculatedLine; amount: Decimal; warnings: PricingWarning[] } {
  const product = products.get(input.productId);
  if (!product || !product.enabled) {
    throw new PricingError('PRODUCT_NOT_AVAILABLE', '产品不存在或已停用', `${path}.productId`);
  }

  const quantity = positive(input.quantity, `${path}.quantity`, MAX_QUANTITY);
  const configuredPrice = nonNegative(product.salePrice, `${path}.catalogPrice`);
  const unitPrice = input.unitPriceOverride
    ? nonNegative(input.unitPriceOverride, `${path}.unitPriceOverride`)
    : configuredPrice;
  const minimumCharge = nonNegative(product.minimumCharge, `${path}.minimumCharge`);
  const lossRate = percentage(product.lossRate, `${path}.lossRate`);

  let lengthMeters: Decimal | null = null;
  let widthMeters: Decimal | null = null;
  let actualArea: Decimal | null = null;
  let billableArea: Decimal | null = null;
  let formulaAmount: Decimal;

  switch (product.formulaType) {
    case 'FIXED':
      formulaAmount = intermediate(unitPrice);
      break;
    case 'QUANTITY':
      formulaAmount = intermediate(quantity.mul(unitPrice));
      break;
    case 'AREA':
      if (!input.length || !input.width) {
        throw new PricingError('DIMENSIONS_REQUIRED', '面积计价需要长度和宽度', path);
      }
      lengthMeters = dimensionToMeters(input.length, `${path}.length`);
      widthMeters = dimensionToMeters(input.width, `${path}.width`);
      actualArea = lengthMeters
        .mul(widthMeters)
        .mul(quantity)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      billableArea = actualArea
        .mul(ONE_HUNDRED.add(lossRate))
        .div(ONE_HUNDRED)
        .toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      formulaAmount = billableArea.mul(unitPrice).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
      break;
  }

  const minimumApplied = formulaAmount.lt(minimumCharge);
  const baseAmount = intermediate(Decimal.max(formulaAmount, minimumCharge));
  const calculatedAddOns: CalculatedAddOn[] = [];
  let addOnTotal = ZERO;
  input.addOns.forEach((addOnInput, index) => {
    const calculated = calculateAddOn(
      addOnInput,
      addOns,
      { quantity, area: billableArea, baseAmount, productId: product.id },
      `${path}.addOns[${index}]`,
    );
    calculatedAddOns.push(calculated.result);
    addOnTotal = addOnTotal.add(calculated.amount);
  });

  let costAmount: Decimal | null = null;
  if (product.costPrice !== null && product.costPrice !== '') {
    const cost = nonNegative(product.costPrice, `${path}.costPrice`);
    switch (product.formulaType) {
      case 'FIXED':
        costAmount = cost;
        break;
      case 'QUANTITY':
        costAmount = quantity.mul(cost);
        break;
      case 'AREA':
        costAmount = (billableArea ?? ZERO).mul(cost);
        break;
    }
  }

  const lineTotal = baseAmount.add(addOnTotal).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const belowCost = costAmount !== null && lineTotal.lt(costAmount);
  const warnings: PricingWarning[] = [];
  if (minimumApplied) {
    warnings.push({
      code: 'MINIMUM_APPLIED',
      lineId: input.id,
      message: `${product.name}已应用最低收费`,
    });
  }
  if (input.unitPriceOverride && !unitPrice.eq(configuredPrice)) {
    warnings.push({
      code: 'PRICE_OVERRIDDEN',
      lineId: input.id,
      message: `${product.name}使用了本次手工单价`,
    });
  }
  if (belowCost) {
    warnings.push({
      code: 'BELOW_COST',
      lineId: input.id,
      message: `${product.name}的销售金额低于已录入成本`,
    });
  }

  return {
    amount: lineTotal,
    warnings,
    result: {
      id: input.id,
      productId: product.id,
      code: product.code,
      name: product.name,
      formulaType: product.formulaType,
      unit: product.unit,
      quantity: precise(quantity),
      lengthMeters: lengthMeters ? precise(lengthMeters) : null,
      widthMeters: widthMeters ? precise(widthMeters) : null,
      actualArea: actualArea ? precise(actualArea) : null,
      billableArea: billableArea ? precise(billableArea) : null,
      lossRate: precise(lossRate),
      unitPrice: precise(unitPrice),
      minimumCharge: money(minimumCharge),
      formulaAmount: money(formulaAmount),
      baseAmount: money(baseAmount),
      minimumApplied,
      addOns: calculatedAddOns,
      addOnTotal: money(addOnTotal),
      lineTotal: money(lineTotal),
      costAmount: costAmount ? money(costAmount) : null,
      belowCost,
      description: input.description,
    },
  };
}

function roundTotal(value: Decimal, mode: RoundingMode): Decimal {
  const decimalPlaces = mode === 'CENT' ? 2 : mode === 'JIAO' ? 1 : 0;
  return value.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP);
}

export function calculateQuote(
  draft: QuoteDraftData,
  productCatalog: CatalogProduct[],
  addOnCatalog: CatalogAddOn[],
): QuoteCalculation {
  if (draft.lines.length === 0) {
    throw new PricingError('LINE_REQUIRED', '请至少添加一个报价项目', 'lines');
  }
  if (draft.lines.length > 100) {
    throw new PricingError('TOO_MANY_LINES', '单份报价最多支持 100 个项目', 'lines');
  }

  const products = new Map(productCatalog.map((item) => [item.id, item]));
  const addOns = new Map(addOnCatalog.map((item) => [item.id, item]));
  const lines: CalculatedLine[] = [];
  const warnings: PricingWarning[] = [];
  let subtotal = ZERO;
  let knownCostTotal = ZERO;
  let hasKnownCost = false;

  draft.lines.forEach((line, index) => {
    if (line.addOns.length > 20) {
      throw new PricingError('TOO_MANY_ADDONS', '单个项目最多支持 20 个附加项', `lines[${index}]`);
    }
    const calculated = calculateLine(line, products, addOns, `lines[${index}]`);
    lines.push(calculated.result);
    warnings.push(...calculated.warnings);
    subtotal = subtotal.add(calculated.amount);
    if (calculated.result.costAmount !== null) {
      hasKnownCost = true;
      knownCostTotal = knownCostTotal.add(new Decimal(calculated.result.costAmount));
    }
  });

  if (draft.orderAddOns.length > 20) {
    throw new PricingError('TOO_MANY_ADDONS', '整单最多支持 20 个附加项', 'orderAddOns');
  }
  const calculatedOrderAddOns: CalculatedAddOn[] = [];
  const lineSubtotal = subtotal;
  let orderAddOnTotal = ZERO;
  draft.orderAddOns.forEach((addOnInput, index) => {
    const calculated = calculateAddOn(
      addOnInput,
      addOns,
      { quantity: new Decimal(1), area: null, baseAmount: lineSubtotal, productId: null },
      `orderAddOns[${index}]`,
    );
    calculatedOrderAddOns.push(calculated.result);
    orderAddOnTotal = orderAddOnTotal.add(calculated.amount);
  });
  subtotal = lineSubtotal.add(orderAddOnTotal);

  const discountValue = nonNegative(draft.discountValue, 'discountValue');
  let discountAmount: Decimal;
  switch (draft.discountType) {
    case 'NONE':
      discountAmount = ZERO;
      break;
    case 'FIXED':
      discountAmount = discountValue.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      break;
    case 'PERCENT':
      percentage(draft.discountValue, 'discountValue');
      discountAmount = subtotal
        .mul(discountValue)
        .div(ONE_HUNDRED)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
      break;
  }

  const afterDiscount = subtotal.sub(discountAmount);
  const manualAdjustment = decimal(draft.manualAdjustment, 'manualAdjustment').toDecimalPlaces(
    2,
    Decimal.ROUND_HALF_UP,
  );
  if (!manualAdjustment.eq(0) && draft.adjustmentReason.trim().length === 0) {
    throw new PricingError(
      'ADJUSTMENT_REASON_REQUIRED',
      '手工调整金额时必须填写原因',
      'adjustmentReason',
    );
  }
  const preTaxAmount = afterDiscount.add(manualAdjustment);
  if (preTaxAmount.lt(0)) {
    throw new PricingError('NEGATIVE_TOTAL', '优惠和调整后金额不能小于 0', 'manualAdjustment');
  }

  const taxRate = percentage(draft.taxRate, 'taxRate');
  let taxAmount = ZERO;
  let totalBeforeRounding = preTaxAmount;
  if (draft.taxMode === 'EXTRA') {
    taxAmount = preTaxAmount
      .mul(taxRate)
      .div(ONE_HUNDRED)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    totalBeforeRounding = preTaxAmount.add(taxAmount);
  }

  const total = roundTotal(totalBeforeRounding, draft.roundingMode);
  if (draft.taxMode === 'INCLUDED' && taxRate.gt(0)) {
    taxAmount = total
      .mul(taxRate)
      .div(ONE_HUNDRED.add(taxRate))
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }
  const roundingAdjustment = total.sub(totalBeforeRounding);
  if (total.gt(MAX_PRICE)) {
    throw new PricingError('TOTAL_TOO_LARGE', '报价总额超过允许范围', 'total');
  }
  const belowCost = hasKnownCost && total.lt(knownCostTotal);
  if (belowCost) {
    warnings.push({
      code: 'TOTAL_BELOW_COST',
      lineId: 'quote',
      message: '整单优惠或调整后的总价低于已录入成本合计',
    });
  }

  return {
    schemaVersion: 1,
    currency: 'CNY',
    lines,
    orderAddOns: calculatedOrderAddOns,
    subtotal: money(subtotal),
    discountAmount: money(discountAmount),
    afterDiscount: money(afterDiscount),
    manualAdjustment: money(manualAdjustment),
    preTaxAmount: money(preTaxAmount),
    taxMode: draft.taxMode,
    taxRate: precise(taxRate),
    taxAmount: money(taxAmount),
    totalBeforeRounding: money(totalBeforeRounding),
    roundingMode: draft.roundingMode,
    roundingAdjustment: money(roundingAdjustment),
    total: money(total),
    totalFen: total.mul(100).toDecimalPlaces(0).toNumber(),
    internalCostTotal: hasKnownCost ? money(knownCostTotal) : null,
    belowCost,
    warnings,
  };
}

export function toPublicCalculation(calculation: QuoteCalculation): Omit<
  QuoteCalculation,
  'warnings' | 'lines' | 'internalCostTotal' | 'belowCost'
> & {
  lines: Array<Omit<CalculatedLine, 'costAmount' | 'belowCost'>>;
} {
  const rest = { ...calculation } as Partial<QuoteCalculation>;
  delete rest.warnings;
  delete rest.internalCostTotal;
  delete rest.belowCost;
  delete rest.lines;
  return {
    ...(rest as Omit<QuoteCalculation, 'warnings' | 'lines' | 'internalCostTotal' | 'belowCost'>),
    lines: calculation.lines.map((line) => {
      const output = { ...line } as Partial<CalculatedLine>;
      delete output.costAmount;
      delete output.belowCost;
      return output as Omit<CalculatedLine, 'costAmount' | 'belowCost'>;
    }),
  };
}
