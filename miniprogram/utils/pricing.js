function numeric(value, label, allowZero = true) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    throw new Error(`${label}填写无效`);
  }
  return parsed;
}

function rounded(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function money(value) {
  return rounded(value, 2).toFixed(2);
}

function precise(value) {
  return rounded(value, 4).toFixed(4);
}

function meters(dimension, label) {
  const value = numeric(dimension?.value, label, false);
  const factor = { mm: 0.001, cm: 0.01, m: 1 }[dimension?.unit];
  if (!factor) throw new Error(`${label}单位无效`);
  return value * factor;
}

function addOnResult(input, addOn, context) {
  if (!addOn || !addOn.enabled) throw new Error('附加项不存在或已停用');
  if (
    context.productId &&
    addOn.applicableProductIds?.length &&
    !addOn.applicableProductIds.includes(context.productId)
  ) {
    throw new Error('所选附加项不适用于当前产品');
  }
  const price = numeric(input.priceOverride || addOn.price, '附加项价格');
  let parameter = 1;
  let amount = price;
  if (addOn.pricingType === 'QUANTITY') {
    parameter = numeric(input.quantity || context.quantity, '附加项数量', false);
    amount = parameter * price;
  } else if (addOn.pricingType === 'AREA') {
    parameter = numeric(input.area || context.area, '附加项面积', false);
    amount = parameter * price;
  } else if (addOn.pricingType === 'PERCENT') {
    if (price > 100) throw new Error('附加项比例不能超过 100%');
    parameter = price;
    amount = (context.baseAmount * price) / 100;
  }
  amount = rounded(rounded(amount, 4), 2);
  return {
    amount,
    result: {
      id: input.id,
      addOnId: addOn.id,
      name: addOn.name,
      pricingType: addOn.pricingType,
      unit: addOn.unit,
      parameter: precise(parameter),
      price: precise(price),
      amount: money(amount),
    },
  };
}

function calculate(draft, productCatalog, addOnCatalog) {
  if (!draft?.lines?.length) throw new Error('请至少添加一个报价项目');
  const products = Object.fromEntries(productCatalog.map((item) => [item.id, item]));
  const addOns = Object.fromEntries(addOnCatalog.map((item) => [item.id, item]));
  const lines = [];
  const warnings = [];
  let lineSubtotal = 0;

  for (const line of draft.lines) {
    const product = products[line.productId];
    if (!product || !product.enabled) throw new Error('产品不存在或已停用');
    const quantity = numeric(line.quantity, '数量', false);
    const configuredPrice = numeric(product.salePrice, '销售价');
    const unitPrice = numeric(line.unitPriceOverride || product.salePrice, '本次单价');
    const minimumCharge = numeric(product.minimumCharge || 0, '最低收费');
    const lossRate = numeric(product.lossRate || 0, '损耗率');
    if (lossRate > 100) throw new Error('损耗率不能超过 100%');

    let lengthMeters = null;
    let widthMeters = null;
    let actualArea = null;
    let billableArea = null;
    let formulaAmount;
    if (product.formulaType === 'FIXED') {
      formulaAmount = rounded(unitPrice, 4);
    } else if (product.formulaType === 'QUANTITY') {
      formulaAmount = rounded(quantity * unitPrice, 4);
    } else {
      lengthMeters = meters(line.length, '长度');
      widthMeters = meters(line.width, '宽度');
      actualArea = rounded(lengthMeters * widthMeters * quantity, 4);
      billableArea = rounded(actualArea * (1 + lossRate / 100), 4);
      formulaAmount = rounded(billableArea * unitPrice, 4);
    }
    const minimumApplied = formulaAmount < minimumCharge;
    const baseAmount = rounded(Math.max(formulaAmount, minimumCharge), 4);
    const calculatedAddOns = [];
    let addOnTotal = 0;
    for (const selected of line.addOns || []) {
      const calculated = addOnResult(selected, addOns[selected.addOnId], {
        quantity,
        area: billableArea,
        baseAmount,
        productId: product.id,
      });
      calculatedAddOns.push(calculated.result);
      addOnTotal += calculated.amount;
    }
    const lineTotal = rounded(baseAmount + addOnTotal, 2);
    if (minimumApplied) {
      warnings.push({
        code: 'MINIMUM_APPLIED',
        lineId: line.id,
        message: `${product.name}已应用最低收费`,
      });
    }
    if (line.unitPriceOverride && unitPrice !== configuredPrice) {
      warnings.push({
        code: 'PRICE_OVERRIDDEN',
        lineId: line.id,
        message: `${product.name}使用了本次手工单价`,
      });
    }
    lines.push({
      id: line.id,
      productId: product.id,
      code: product.code,
      name: product.name,
      formulaType: product.formulaType,
      unit: product.unit,
      quantity: precise(quantity),
      lengthMeters: lengthMeters === null ? null : precise(lengthMeters),
      widthMeters: widthMeters === null ? null : precise(widthMeters),
      actualArea: actualArea === null ? null : precise(actualArea),
      billableArea: billableArea === null ? null : precise(billableArea),
      lossRate: precise(lossRate),
      unitPrice: precise(unitPrice),
      minimumCharge: money(minimumCharge),
      formulaAmount: money(formulaAmount),
      baseAmount: money(baseAmount),
      minimumApplied,
      addOns: calculatedAddOns,
      addOnTotal: money(addOnTotal),
      lineTotal: money(lineTotal),
      costAmount: null,
      belowCost: false,
      description: line.description || '',
    });
    lineSubtotal += lineTotal;
  }

  let orderAddOnTotal = 0;
  const orderAddOns = (draft.orderAddOns || []).map((selected) => {
    const calculated = addOnResult(selected, addOns[selected.addOnId], {
      quantity: 1,
      area: null,
      baseAmount: lineSubtotal,
      productId: null,
    });
    orderAddOnTotal += calculated.amount;
    return calculated.result;
  });
  const subtotal = rounded(lineSubtotal + orderAddOnTotal, 2);
  const discountValue = numeric(draft.discountValue || 0, '优惠值');
  const discountAmount =
    draft.discountType === 'FIXED'
      ? rounded(discountValue, 2)
      : draft.discountType === 'PERCENT'
        ? rounded((subtotal * discountValue) / 100, 2)
        : 0;
  const afterDiscount = subtotal - discountAmount;
  const rawManualAdjustment = Number(draft.manualAdjustment || 0);
  if (!Number.isFinite(rawManualAdjustment)) throw new Error('手工调整填写无效');
  const manualAdjustment = rounded(rawManualAdjustment, 2);
  const preTaxAmount = afterDiscount + manualAdjustment;
  if (preTaxAmount < 0) throw new Error('优惠和调整后金额不能小于 0');
  const taxRate = numeric(draft.taxRate || 0, '税率');
  let taxAmount = 0;
  let totalBeforeRounding = preTaxAmount;
  if (draft.taxMode === 'EXTRA') {
    taxAmount = rounded((preTaxAmount * taxRate) / 100, 2);
    totalBeforeRounding += taxAmount;
  }
  const digits = draft.roundingMode === 'CENT' ? 2 : draft.roundingMode === 'JIAO' ? 1 : 0;
  const total = rounded(totalBeforeRounding, digits);
  if (draft.taxMode === 'INCLUDED' && taxRate > 0) {
    taxAmount = rounded((total * taxRate) / (100 + taxRate), 2);
  }
  return {
    schemaVersion: 1,
    currency: 'CNY',
    lines,
    orderAddOns,
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
    roundingAdjustment: money(total - totalBeforeRounding),
    total: money(total),
    totalFen: Math.round(total * 100),
    internalCostTotal: null,
    belowCost: false,
    warnings,
  };
}

module.exports = { calculate };
