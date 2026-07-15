const api = require('../../utils/api');
const format = require('../../utils/format');

Page({
  data: {
    loading: true,
    error: '',
    items: [],
    query: '',
    state: '',
    stateOptions: ['全部状态', ...Object.values(format.labels)],
    stateIndex: 0,
    dateFrom: '',
    dateTo: '',
  },

  onShow() {
    this.load();
  },

  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const stateKeys = ['', ...Object.keys(format.labels)];
      const result = await api.request(
        `/quotes?q=${encodeURIComponent(this.data.query)}&state=${stateKeys[this.data.stateIndex] || ''}&dateFrom=${this.data.dateFrom}&dateTo=${this.data.dateTo}`,
      );
      this.setData({
        items: result.items.map((item) => ({
          ...item,
          amountLabel: format.money(item.total),
          stateLabel: format.stateLabel(item.hasDraft ? 'DRAFT' : item.state),
        })),
      });
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSearch(event) {
    this.setData({ query: event.detail.value });
  },
  submitSearch() {
    this.load();
  },
  onState(event) {
    this.setData({ stateIndex: Number(event.detail.value) }, () => this.load());
  },
  onDateFrom(event) {
    this.setData({ dateFrom: event.detail.value }, () => this.load());
  },
  onDateTo(event) {
    this.setData({ dateTo: event.detail.value }, () => this.load());
  },
  clearDates() {
    this.setData({ dateFrom: '', dateTo: '' }, () => this.load());
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
});
