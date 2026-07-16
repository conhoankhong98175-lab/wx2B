const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    error: '',
    saved: false,
    form: null,
    roundingOptions: ['到分', '到角', '到元'],
    roundingValues: ['CENT', 'JIAO', 'YUAN'],
    roundingIndex: 0,
  },
  onShow() {
    if (!this.data.form) this.load();
  },
  async load() {
    try {
      const form = await api.request('/merchant');
      this.setData({ form, roundingIndex: this.data.roundingValues.indexOf(form.roundingMode) });
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
  onField(event) {
    this.setData({
      [`form.${event.currentTarget.dataset.field}`]: event.detail.value,
      saved: false,
    });
  },
  onValidDays(event) {
    this.setData({ 'form.defaultValidDays': Number(event.detail.value), saved: false });
  },
  onRounding(event) {
    const index = Number(event.detail.value);
    this.setData({
      roundingIndex: index,
      'form.roundingMode': this.data.roundingValues[index],
      saved: false,
    });
  },
  async save() {
    this.setData({ error: '' });
    try {
      const form = this.data.form;
      await api.request('/merchant', {
        method: 'PUT',
        data: {
          name: form.name,
          logoUrl: form.logoUrl || '',
          contactName: form.contactName || '',
          contactPhone: form.contactPhone || '',
          contactWechat: form.contactWechat || '',
          defaultValidDays: form.defaultValidDays,
          defaultDeliveryPeriod: form.defaultDeliveryPeriod || '',
          defaultTerms: form.defaultTerms || '',
          roundingMode: form.roundingMode,
          onboardingCompleted: true,
        },
      });
      this.setData({ saved: true });
      wx.showToast({ title: '设置已保存', icon: 'success' });
    } catch (error) {
      this.setData({ error: error.message || '保存失败' });
    }
  },
  async exportData() {
    wx.showLoading({ title: '正在导出' });
    try {
      const data = await api.request('/merchant/export');
      const path = `${wx.env.USER_DATA_PATH}/店铺数据-${Date.now()}.json`;
      wx.getFileSystemManager().writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
      if (wx.canIUse('shareFileMessage')) {
        await new Promise((resolve, reject) =>
          wx.shareFileMessage({
            filePath: path,
            fileName: '店铺数据.json',
            success: resolve,
            fail: reject,
          }),
        );
      } else {
        wx.showToast({ title: '当前微信版本不支持文件转发', icon: 'none' });
      }
    } catch (error) {
      wx.showToast({ title: error.message || error.errMsg || '导出失败', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },
  openPrivacyContract() {
    if (!wx.openPrivacyContract) {
      wx.showToast({ title: '请升级微信后查看隐私保护指引', icon: 'none' });
      return;
    }
    wx.openPrivacyContract({
      fail: (error) =>
        wx.showToast({ title: error.errMsg || '隐私保护指引打开失败', icon: 'none' }),
    });
  },
  deleteAccount() {
    wx.showModal({
      title: '永久删除店铺数据',
      editable: true,
      content: `请输入完整店铺名称“${this.data.form.name}”确认。所有报价链接将立即失效。`,
      placeholderText: this.data.form.name,
      confirmColor: '#b4443b',
      success: async (result) => {
        if (!result.confirm || result.content !== this.data.form.name) return;
        try {
          await api.request('/merchant/account', {
            method: 'DELETE',
            data: { confirmation: result.content },
          });
          wx.clearStorageSync();
          wx.reLaunch({ url: '/pages/home/index' });
        } catch (error) {
          wx.showToast({ title: error.message || '删除失败', icon: 'none' });
        }
      },
    });
  },
});
