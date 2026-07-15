const api = require('../../utils/api');
const format = require('../../utils/format');

Page({
  data: {
    loading: true,
    error: '',
    merchant: null,
    quotes: [],
    notifications: [],
    metrics: { all: 0, pending: 0, viewed: 0, accepted: 0 },
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      await api.ensureLogin();
      const [merchant, quoteResult, notificationResult] = await Promise.all([
        api.request('/merchant'),
        api.request('/quotes'),
        api.request('/quotes/notifications/list'),
      ]);
      const quotes = quoteResult.items.map((item) => ({
        ...item,
        stateLabel: format.stateLabel(item.hasDraft ? 'DRAFT' : item.state),
        amountLabel: format.money(item.total),
      }));
      this.setData({
        merchant,
        quotes: quotes.slice(0, 6),
        notifications: notificationResult.items.filter((item) => !item.resolvedAt).slice(0, 5),
        metrics: {
          all: quotes.length,
          pending: quotes.filter(
            (item) => item.state === 'ACTIVE' || item.state === 'CHANGE_REQUESTED',
          ).length,
          viewed: quotes.filter((item) => item.viewed).length,
          accepted: quotes.filter((item) => item.state === 'ACCEPTED').length,
        },
      });
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  newQuote() {
    wx.navigateTo({ url: '/pages/editor/index' });
  },

  openQuote(event) {
    const { id, draft } = event.currentTarget.dataset;
    wx.navigateTo({
      url: draft ? `/pages/editor/index?id=${id}` : `/pages/quote-detail/index?id=${id}`,
    });
  },

  async resolveNotification(event) {
    try {
      await api.request(`/quotes/notifications/${event.currentTarget.dataset.id}/resolve`, {
        method: 'POST',
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' });
    }
  },
});
