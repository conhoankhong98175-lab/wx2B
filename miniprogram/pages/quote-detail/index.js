const api = require('../../utils/api');
const format = require('../../utils/format');

Page({
  data: {
    loading: true,
    error: '',
    quoteId: '',
    quote: null,
    versions: [],
    current: null,
    shareVersion: null,
  },
  onLoad(options) {
    this.setData({ quoteId: options.id || '' });
    this.load();
  },
  onShow() {
    if (this.data.quoteId && !this.data.loading) this.load();
  },
  async load() {
    try {
      const quote = await api.request(`/quotes/${this.data.quoteId}`);
      const versions = quote.versions.map((item) => ({
        ...item,
        stateLabel: format.stateLabel(item.state),
        amountLabel: format.money(item.calculation.total),
        actions: item.actions || [],
      }));
      this.setData({
        quote,
        versions,
        current: versions.find((item) => item.version === quote.currentVersion) || versions[0],
        shareVersion: versions.find((item) => item.version === quote.currentVersion) || versions[0],
      });
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
  onShareAppMessage(event) {
    const index = event?.target?.dataset?.index;
    const version =
      index === undefined ? this.data.shareVersion : this.data.versions[Number(index)];
    return {
      title: `${this.data.quote.merchantName} · ${this.data.quote.projectName || '报价单'} · V${version.version}`,
      path: `/pages/public-quote/index?token=${encodeURIComponent(version.shareToken)}`,
    };
  },
  async newVersion() {
    try {
      await api.request(`/quotes/${this.data.quoteId}/new-version`, { method: 'POST' });
      wx.navigateTo({ url: `/pages/editor/index?id=${this.data.quoteId}` });
    } catch (error) {
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },
  async copyQuote() {
    const modal = await new Promise((resolve) =>
      wx.showModal({
        title: '复制报价',
        content: '是否保留当前客户信息？',
        confirmText: '保留',
        cancelText: '不保留',
        success: resolve,
      }),
    );
    try {
      const result = await api.request(`/quotes/${this.data.quoteId}/copy`, {
        method: 'POST',
        data: { keepCustomer: modal.confirm },
      });
      wx.navigateTo({ url: `/pages/editor/index?id=${result.id}` });
    } catch (error) {
      wx.showToast({ title: error.message || '复制失败', icon: 'none' });
    }
  },
  async withdraw(event) {
    const version = Number(event.currentTarget.dataset.version);
    const modal = await new Promise((resolve) =>
      wx.showModal({
        title: `撤回 V${version}`,
        content: '撤回后客户原链接将立即隐藏价格明细。',
        confirmColor: '#b4443b',
        success: resolve,
      }),
    );
    if (!modal.confirm) return;
    try {
      await api.request(`/quotes/${this.data.quoteId}/versions/${version}/withdraw`, {
        method: 'POST',
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '撤回失败', icon: 'none' });
    }
  },
  async openPdf(event) {
    wx.showLoading({ title: '生成 PDF' });
    try {
      const path = await api.download(
        `/documents/${this.data.quoteId}/versions/${event.currentTarget.dataset.version}/pdf`,
      );
      await new Promise((resolve, reject) =>
        wx.openDocument({
          filePath: path,
          fileType: 'pdf',
          showMenu: true,
          success: resolve,
          fail: reject,
        }),
      );
    } catch (error) {
      wx.showToast({ title: error.message || 'PDF 打开失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
});
