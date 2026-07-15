const api = require('../../utils/api');
const format = require('../../utils/format');
const pricing = require('../../utils/pricing');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
function recoveryKey(quoteId) {
  return `diangao_draft_recovery_${quoteId || 'new'}`;
}

Page({
  data: {
    loading: true,
    error: '',
    saving: false,
    publishing: false,
    previewing: false,
    syncState: '',
    quoteId: '',
    quoteNumber: '',
    draftVersion: 1,
    draftRevision: 0,
    draft: null,
    merchant: null,
    products: [],
    productNames: [],
    addOns: [],
    addOnNames: [],
    calculation: null,
    calculationHash: null,
    dimensionUnits: ['mm', 'cm', 'm'],
    discountIndex: 0,
    taxIndex: 0,
    discountOptions: ['无优惠', '固定优惠金额', '折扣比例'],
    discountValues: ['NONE', 'FIXED', 'PERCENT'],
    taxOptions: ['不计税', '单价含税', '税费另计'],
    taxValues: ['NONE', 'INCLUDED', 'EXTRA'],
  },

  onLoad(options) {
    this.load(options.id || '');
  },

  async load(quoteId) {
    try {
      const [catalog, merchant] = await Promise.all([
        api.request('/catalog'),
        api.request('/merchant'),
      ]);
      let draft;
      let quoteNumber = '';
      let draftVersion = 1;
      if (quoteId) {
        const quote = await api.request(`/quotes/${quoteId}`);
        if (!quote.draft) throw new Error('当前没有可编辑草稿');
        draft = quote.draft;
        quoteNumber = quote.quoteNumber;
        draftVersion = quote.draftVersion;
        this.setData({ draftRevision: quote.draftRevision });
      } else {
        draft = {
          customerName: '',
          customerContact: '',
          projectName: '',
          lines: [],
          orderAddOns: [],
          discountType: 'NONE',
          discountValue: '0',
          manualAdjustment: '0',
          adjustmentReason: '',
          taxMode: 'NONE',
          taxRate: '0',
          roundingMode: merchant.roundingMode,
          validUntil: format.datePlus(merchant.defaultValidDays),
          deliveryPeriod: merchant.defaultDeliveryPeriod,
          notes: '',
          terms: merchant.defaultTerms,
        };
      }
      let recovered = false;
      const stored = wx.getStorageSync(recoveryKey(quoteId));
      if (stored?.lines && Array.isArray(stored.lines)) {
        draft = clone(stored);
        recovered = true;
      }
      this.draftGeneration = recovered ? 1 : 0;
      this.syncedGeneration = 0;
      this.lastPersistResult = null;
      const products = catalog.products.filter((item) => item.enabled);
      const addOns = catalog.addOns.filter((item) => item.enabled);
      draft.lines.forEach((line) =>
        line.addOns.forEach((selected) => {
          const addOn = addOns.find((item) => item.id === selected.addOnId);
          selected.name = addOn?.name || '附加项';
          selected.pricingType = addOn?.pricingType || 'FIXED';
        }),
      );
      draft.orderAddOns.forEach((selected) => {
        const addOn = addOns.find((item) => item.id === selected.addOnId);
        selected.name = addOn?.name || '附加费用';
        selected.pricingType = addOn?.pricingType || 'FIXED';
      });
      this.setData({
        quoteId,
        quoteNumber,
        draftVersion,
        draft,
        merchant,
        products,
        productNames: products.map((item) => `${item.name}${item.isDemo ? '（演示）' : ''}`),
        addOns,
        addOnNames: addOns.map((item) => item.name),
        discountIndex: ['NONE', 'FIXED', 'PERCENT'].indexOf(draft.discountType),
        taxIndex: ['NONE', 'INCLUDED', 'EXTRA'].indexOf(draft.taxMode),
        syncState: recovered ? '已恢复未同步草稿' : '',
      });
      this.calculate();
      if (recovered) this.scheduleAutoSave();
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  setDraft(draft) {
    this.draftGeneration = (this.draftGeneration || 0) + 1;
    wx.setStorageSync(recoveryKey(this.data.quoteId), draft);
    this.setData({ draft, calculationHash: null }, () => this.calculate());
    this.setData({ syncState: '已在本机暂存，等待同步' });
    this.scheduleAutoSave();
  },
  scheduleAutoSave() {
    clearTimeout(this.saveTimer);
    if (!this.data.draft?.customerName?.trim() || !this.data.draft.lines?.length) return;
    this.saveTimer = setTimeout(async () => {
      this.setData({ saving: true, syncState: '正在同步…' });
      try {
        await this.persist();
        if (this.syncedGeneration === this.draftGeneration) {
          this.setData({ syncState: '已同步' });
        }
      } catch (error) {
        this.preserveDraftConflict(error);
        this.setData({
          error: error.message || '草稿同步失败',
          syncState: '未同步，草稿仍保存在本机',
        });
      } finally {
        this.setData({ saving: false });
      }
    }, 900);
  },
  onField(event) {
    const draft = clone(this.data.draft);
    draft[event.currentTarget.dataset.field] = event.detail.value;
    this.setDraft(draft);
  },
  onDiscount(event) {
    const index = Number(event.detail.value);
    const draft = clone(this.data.draft);
    draft.discountType = this.data.discountValues[index];
    draft.discountValue = '0';
    this.setData({ discountIndex: index });
    this.setDraft(draft);
  },
  onTax(event) {
    const index = Number(event.detail.value);
    const draft = clone(this.data.draft);
    draft.taxMode = this.data.taxValues[index];
    this.setData({ taxIndex: index });
    this.setDraft(draft);
  },

  addProduct(event) {
    const product = this.data.products[Number(event.detail.value)];
    if (!product) return;
    const draft = clone(this.data.draft);
    draft.lines.push({
      id: uid(),
      productId: product.id,
      quantity: '1',
      addOns: [],
      description: '',
      ...(product.formulaType === 'AREA'
        ? { length: { value: '1', unit: 'm' }, width: { value: '1', unit: 'm' } }
        : {}),
    });
    this.setDraft(draft);
  },

  removeLine(event) {
    const draft = clone(this.data.draft);
    draft.lines.splice(Number(event.currentTarget.dataset.index), 1);
    this.setDraft(draft);
  },
  onLineField(event) {
    const draft = clone(this.data.draft);
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    draft.lines[index][field] = event.detail.value;
    this.setDraft(draft);
  },
  onDimension(event) {
    const draft = clone(this.data.draft);
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    draft.lines[index][field].value = event.detail.value;
    this.setDraft(draft);
  },
  onDimensionUnit(event) {
    const draft = clone(this.data.draft);
    const index = Number(event.currentTarget.dataset.index);
    const field = event.currentTarget.dataset.field;
    draft.lines[index][field].unit = ['mm', 'cm', 'm'][Number(event.detail.value)];
    this.setDraft(draft);
  },
  addLineAddon(event) {
    const draft = clone(this.data.draft);
    const lineIndex = Number(event.currentTarget.dataset.index);
    const addOn = this.data.addOns[Number(event.detail.value)];
    const productId = draft.lines[lineIndex].productId;
    if (addOn?.applicableProductIds?.length && !addOn.applicableProductIds.includes(productId)) {
      wx.showToast({ title: '该附加项不适用于当前产品', icon: 'none' });
      return;
    }
    if (addOn)
      draft.lines[lineIndex].addOns.push({
        id: uid(),
        addOnId: addOn.id,
        name: addOn.name,
        pricingType: addOn.pricingType,
        ...(addOn.pricingType === 'QUANTITY' ? { quantity: '1' } : {}),
        ...(addOn.pricingType === 'AREA' ? { area: '1' } : {}),
      });
    this.setDraft(draft);
  },
  removeLineAddon(event) {
    const draft = clone(this.data.draft);
    draft.lines[Number(event.currentTarget.dataset.line)].addOns.splice(
      Number(event.currentTarget.dataset.index),
      1,
    );
    this.setDraft(draft);
  },
  onLineAddonField(event) {
    const draft = clone(this.data.draft);
    const selected =
      draft.lines[Number(event.currentTarget.dataset.line)].addOns[
        Number(event.currentTarget.dataset.index)
      ];
    selected[event.currentTarget.dataset.field] = event.detail.value;
    this.setDraft(draft);
  },
  addOrderAddon(event) {
    const addOn = this.data.addOns[Number(event.detail.value)];
    if (!addOn) return;
    const draft = clone(this.data.draft);
    draft.orderAddOns.push({
      id: uid(),
      addOnId: addOn.id,
      name: addOn.name,
      pricingType: addOn.pricingType,
      ...(addOn.pricingType === 'QUANTITY' ? { quantity: '1' } : {}),
      ...(addOn.pricingType === 'AREA' ? { area: '1' } : {}),
    });
    this.setDraft(draft);
  },
  removeOrderAddon(event) {
    const draft = clone(this.data.draft);
    draft.orderAddOns.splice(Number(event.currentTarget.dataset.index), 1);
    this.setDraft(draft);
  },
  onOrderAddonField(event) {
    const draft = clone(this.data.draft);
    draft.orderAddOns[Number(event.currentTarget.dataset.index)][
      event.currentTarget.dataset.field
    ] = event.detail.value;
    this.setDraft(draft);
  },

  calculate() {
    clearTimeout(this.calculateTimer);
    if (!this.data.draft || this.data.draft.lines.length === 0) {
      this.setData({ calculation: null });
      return;
    }
    try {
      this.setData({
        calculation: pricing.calculate(this.data.draft, this.data.products, this.data.addOns),
        calculationHash: null,
      });
    } catch (error) {
      this.setData({
        calculation: null,
        calculationHash: null,
        error: error.message || '计算失败',
      });
    }
    this.calculateTimer = setTimeout(async () => {
      try {
        const result = await api.request('/quotes/calculate', {
          method: 'POST',
          data: this.data.draft,
        });
        this.setData({
          calculation: result.calculation,
          calculationHash: result.calculationHash,
          error: '',
        });
      } catch (error) {
        this.setData({
          calculation: null,
          calculationHash: null,
          error: error.message || '计算失败',
        });
      }
    }, 250);
  },

  async persist(force = false) {
    if (
      !force &&
      !this.persistPromise &&
      this.lastPersistResult &&
      this.syncedGeneration === this.draftGeneration
    ) {
      return this.lastPersistResult;
    }
    if (!this.persistPromise) {
      this.persistPromise = this.flushDraftChanges().finally(() => {
        this.persistPromise = null;
      });
    }
    return this.persistPromise;
  },

  async flushDraftChanges() {
    let latestResult = this.lastPersistResult;
    do {
      const generation = this.draftGeneration || 0;
      const quoteId = this.data.quoteId;
      const draftRevision = this.data.draftRevision;
      const draft = clone(this.data.draft);
      latestResult = await this.persistSnapshot({ draft, draftRevision, generation, quoteId });
      this.lastPersistResult = latestResult;
      this.syncedGeneration = generation;

      if (generation === this.draftGeneration) {
        wx.removeStorageSync(recoveryKey(this.data.quoteId));
        this.setData({ syncState: '已同步' });
      } else {
        wx.setStorageSync(recoveryKey(this.data.quoteId), this.data.draft);
        this.setData({ syncState: '有新修改，继续同步…' });
      }
    } while (this.syncedGeneration < this.draftGeneration);
    return latestResult;
  },

  async persistSnapshot({ draft, draftRevision, generation, quoteId }) {
    if (!draft.customerName.trim()) throw new Error('请填写客户名称');
    if (!draft.lines.length) throw new Error('请至少添加一个报价项目');
    if (quoteId) {
      const result = await api.request(`/quotes/${quoteId}/draft`, {
        method: 'PUT',
        data: draft,
        header: { 'If-Match': String(draftRevision) },
      });
      if (!result.calculation || !result.calculationHash) throw new Error('报价计算尚未完成');
      this.setData({ draftRevision: result.draftRevision });
      if (generation === this.draftGeneration) {
        this.setData({ calculation: result.calculation, calculationHash: result.calculationHash });
      }
      return {
        id: quoteId,
        calculation: result.calculation,
        calculationHash: result.calculationHash,
        draftRevision: result.draftRevision,
      };
    }
    const result = await api.request('/quotes', { method: 'POST', data: draft });
    if (!result.calculation || !result.calculationHash) throw new Error('报价计算尚未完成');
    const nextState = {
      quoteId: result.id,
      quoteNumber: result.quoteNumber,
      draftVersion: 1,
      draftRevision: result.draftRevision,
    };
    if (generation === this.draftGeneration) {
      nextState.calculation = result.calculation;
      nextState.calculationHash = result.calculationHash;
    }
    this.setData(nextState);
    if (generation !== this.draftGeneration) {
      wx.setStorageSync(recoveryKey(result.id), this.data.draft);
    }
    wx.removeStorageSync(recoveryKey(''));
    return {
      id: result.id,
      calculation: result.calculation,
      calculationHash: result.calculationHash,
      draftRevision: result.draftRevision,
    };
  },

  async save() {
    clearTimeout(this.saveTimer);
    this.setData({ saving: true, error: '' });
    try {
      await this.persist();
      if (this.syncedGeneration !== this.draftGeneration) {
        throw new Error('仍有未同步修改，请再次保存');
      }
      this.setData({ syncState: '已同步' });
      wx.showToast({ title: '草稿已保存', icon: 'success' });
    } catch (error) {
      this.preserveDraftConflict(error);
      this.setData({ error: error.message || '保存失败' });
    } finally {
      this.setData({ saving: false });
    }
  },

  async showPreview() {
    if (!this.data.calculation) return;
    clearTimeout(this.saveTimer);
    wx.showLoading({ title: '校验报价' });
    try {
      const persisted = await this.persist(true);
      this.setData({
        calculation: persisted.calculation,
        calculationHash: persisted.calculationHash,
        previewing: true,
        error: '',
      });
    } catch (error) {
      this.preserveDraftConflict(error);
      this.setData({ error: error.message || '预览生成失败' });
    } finally {
      wx.hideLoading();
    }
  },
  hidePreview() {
    this.setData({ previewing: false });
  },

  preserveDraftConflict(error) {
    if (error.code !== 'DRAFT_CHANGED') return;
    wx.setStorageSync(recoveryKey(this.data.quoteId), this.data.draft);
    this.lastPersistResult = null;
    this.syncedGeneration = Math.min(
      this.syncedGeneration || 0,
      Math.max(0, (this.draftGeneration || 0) - 1),
    );
    this.setData({ syncState: '草稿有冲突，当前内容已保留在本机' });
  },

  async publish() {
    clearTimeout(this.saveTimer);
    this.setData({ publishing: true, error: '' });
    try {
      const persisted = await this.persist();
      this.setData({ previewing: false });
      const containsDemo = this.data.draft.lines.some(
        (line) => this.data.products.find((product) => product.id === line.productId)?.isDemo,
      );
      if (containsDemo) {
        const confirmation = await new Promise((resolve) =>
          wx.showModal({
            title: '确认演示价格',
            content: '报价使用了演示价格，请确认已经按本店真实价格核对。',
            confirmText: '已核对',
            success: (result) => resolve(result.confirm),
          }),
        );
        if (!confirmation) return;
      }
      const belowCost = persisted.calculation.warnings?.some(
        (item) => item.code === 'BELOW_COST' || item.code === 'TOTAL_BELOW_COST',
      );
      if (belowCost) {
        const confirmation = await new Promise((resolve) =>
          wx.showModal({
            title: '价格低于成本',
            content: '部分价格低于已录入成本，确认仍要发布？',
            confirmText: '继续发布',
            success: (result) => resolve(result.confirm),
          }),
        );
        if (!confirmation) return;
      }
      const publishConfirmation = await new Promise((resolve) =>
        wx.showModal({
          title: '确认发布正式报价',
          content: `客户将看到总计 ¥${persisted.calculation.total}，确认继续？`,
          confirmText: '确认发布',
          success: (result) => resolve(result.confirm),
        }),
      );
      if (!publishConfirmation) return;
      await api.request(`/quotes/${persisted.id}/publish`, {
        method: 'POST',
        data: {
          confirmDemoPrices: containsDemo,
          confirmBelowCost: Boolean(belowCost),
          expectedCalculationHash: persisted.calculationHash,
          expectedDraftRevision: persisted.draftRevision,
        },
      });
      wx.showToast({ title: '报价已发布', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: `/pages/quote-detail/index?id=${persisted.id}` }), 500);
    } catch (error) {
      if (error.code === 'CALCULATION_CHANGED' && error.details) {
        this.setData({
          calculation: error.details.calculation || this.data.calculation,
          calculationHash: error.details.calculationHash || null,
        });
      }
      this.preserveDraftConflict(error);
      this.setData({ error: error.message || '发布失败' });
    } finally {
      this.setData({ publishing: false });
    }
  },
});
