const api = require('../../utils/api');
const format = require('../../utils/format');

const IMAGE_WIDTH = 750;
const IMAGE_PAGE_HEIGHT = 1800;
const IMAGE_SCALE = 2;

function canvasFont(size, bold) {
  return `${bold ? 'bold ' : ''}${size}px sans-serif`;
}

function wrapCanvasText(ctx, value, maxWidth) {
  const result = [];
  for (const paragraph of String(value || '').split('\n')) {
    if (!paragraph) {
      result.push('');
      continue;
    }
    let line = '';
    for (const character of Array.from(paragraph)) {
      const candidate = line + character;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        result.push(line);
        line = character;
      } else {
        line = candidate;
      }
    }
    if (line) result.push(line);
  }
  return result.length ? result : [''];
}

function taxModeText(calculation) {
  if (calculation.taxMode === 'NONE') return '不计税';
  if (calculation.taxMode === 'INCLUDED') return `单价含税 · 税率 ${calculation.taxRate}%`;
  return `税费另计 · 税率 ${calculation.taxRate}%`;
}

Page({
  data: {
    loading: true,
    error: '',
    token: '',
    available: false,
    quote: null,
    unavailable: null,
    stateLabel: '',
    stateMessage: '',
    canvasHeight: 2000,
  },
  onLoad(options) {
    this.setData({ token: options.token || '' });
    this.load();
  },
  async load() {
    try {
      const data = await api.request(`/public/quotes/${encodeURIComponent(this.data.token)}`, {
        public: true,
      });
      if (!data.available) {
        this.setData({ available: false, unavailable: data });
        return;
      }
      const messages = {
        ACCEPTED: '当前版本已被接受，价格或范围变化时需要重新确认新版本。',
        EXPIRED: '报价已超过有效期，请联系商家重新报价。',
        SUPERSEDED: '此报价已有新版本，请联系商家获取最新链接。',
        CHANGE_REQUESTED: '修改申请已提交，正在等待商家发布新版本。',
      };
      this.setData({
        available: true,
        quote: data.quote,
        stateLabel: format.stateLabel(data.quote.state),
        stateMessage: messages[data.quote.state] || '',
      });
      await this.recordView(data.quote);
    } catch (error) {
      this.setData({ error: error.message || '报价链接无效' });
    } finally {
      this.setData({ loading: false });
    }
  },
  async recordView(quote) {
    const key = `view-${quote.quoteNumber}-v${quote.version}`;
    let requestId = wx.getStorageSync(key);
    if (!requestId) {
      requestId = api.requestId('view');
      wx.setStorageSync(key, requestId);
    }
    try {
      await api.request(`/public/quotes/${encodeURIComponent(this.data.token)}/actions`, {
        method: 'POST',
        public: true,
        data: {
          type: 'VIEW',
          requestId,
          anonymousId: wx.getStorageSync('quote_anonymous') || this.createAnonymous(),
          message: '',
        },
      });
    } catch {
      /* 查看记录失败不阻断客户读报价 */
    }
  },
  createAnonymous() {
    const value = api.requestId('anon');
    wx.setStorageSync('quote_anonymous', value);
    return value;
  },
  onShareAppMessage() {
    return {
      title: `${this.data.quote?.merchant.name || '报价单'} · V${this.data.quote?.version || ''}`,
      path: `/pages/public-quote/index?token=${encodeURIComponent(this.data.token)}`,
    };
  },
  async submitAction(type, message) {
    try {
      await api.request(`/public/quotes/${encodeURIComponent(this.data.token)}/actions`, {
        method: 'POST',
        public: true,
        data: {
          type,
          requestId: api.requestId(type.toLowerCase()),
          anonymousId: wx.getStorageSync('quote_anonymous') || this.createAnonymous(),
          message: message || '',
        },
      });
      wx.showToast({
        title: type === 'ACCEPT' ? '已接受当前版本' : '已发送给商家',
        icon: 'success',
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '提交失败', icon: 'none' });
    }
  },
  accept() {
    wx.showModal({
      title: `接受 V${this.data.quote.version}`,
      content: '确认当前价格与服务范围？此操作不等同于付款或电子合同。',
      confirmText: '确认接受',
      success: (result) => {
        if (result.confirm) this.submitAction('ACCEPT', '');
      },
    });
  },
  question() {
    wx.showModal({
      title: '有问题',
      editable: true,
      placeholderText: '请填写问题',
      success: (result) => {
        if (result.confirm && result.content?.trim())
          this.submitAction('QUESTION', result.content.trim());
      },
    });
  },
  changeRequest() {
    wx.showModal({
      title: '申请修改',
      editable: true,
      placeholderText: '请说明要修改的尺寸、材料或工艺',
      success: (result) => {
        if (result.confirm && result.content?.trim())
          this.submitAction('CHANGE_REQUEST', result.content.trim());
      },
    });
  },
  callMerchant() {
    const phone =
      this.data.quote?.merchant.contactPhone || this.data.unavailable?.merchant.contactPhone;
    if (phone) wx.makePhoneCall({ phoneNumber: phone });
  },
  async openPdf() {
    wx.showLoading({ title: '生成 PDF' });
    try {
      const path = await api.download(
        `/public/documents/${encodeURIComponent(this.data.token)}/pdf`,
        { public: true },
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
  async saveImage() {
    const quote = this.data.quote;
    if (!quote) return;
    wx.showLoading({ title: '生成长图' });
    try {
      this.setData({ canvasHeight: IMAGE_PAGE_HEIGHT });
      await new Promise((resolve) => setTimeout(resolve, 80));
      const result = await new Promise((resolve, reject) =>
        wx
          .createSelectorQuery()
          .in(this)
          .select('#quoteCanvas')
          .fields({ node: true, size: true })
          .exec((values) =>
            values[0]?.node ? resolve(values[0]) : reject(new Error('画布初始化失败')),
          ),
      );
      const canvas = result.node;
      canvas.width = IMAGE_WIDTH * IMAGE_SCALE;
      canvas.height = IMAGE_PAGE_HEIGHT * IMAGE_SCALE;
      const ctx = canvas.getContext('2d');
      const left = 48;
      const right = 702;
      const rows = [];
      const text = (value, size = 24, color = '#17211f', bold = false) => {
        ctx.font = canvasFont(size, bold);
        for (const line of wrapCanvasText(ctx, value, right - left)) {
          rows.push({ type: 'text', value: line, size, color, bold, height: size + 18 });
        }
      };
      const pair = (label, value, bold = false) => {
        ctx.font = canvasFont(24, bold);
        wrapCanvasText(ctx, label, 470).forEach((line, index) =>
          rows.push({
            type: 'pair',
            label: line,
            value: index === 0 ? value : '',
            bold,
            height: 48,
          }),
        );
      };
      const divider = () => rows.push({ type: 'divider', height: 28 });
      text('报价单', 40, '#0b6b5f', true);
      text(quote.merchant.name, 30, '#17211f', true);
      text(`${quote.quoteNumber} · V${quote.version}`, 22, '#697471');
      text(`状态：${this.data.stateLabel}`, 22, '#697471');
      text(`客户：${quote.customerName}`, 23);
      if (quote.projectName) text(`项目：${quote.projectName}`, 23);
      text(`有效至：${quote.validUntil} 23:59`, 23);
      text(`交付周期：${quote.deliveryPeriod || '双方另行确认'}`, 23);
      divider();
      quote.calculation.lines.forEach((line, index) => {
        text(`${index + 1}. ${line.name}`, 27, '#17211f', true);
        text(
          `数量 ${line.quantity} ${line.unit}${line.billableArea ? ' · 计费面积 ' + line.billableArea + '㎡' : ''}`,
          21,
          '#697471',
        );
        if (line.description) text(`说明：${line.description}`, 21, '#697471');
        line.addOns.forEach((item) => pair(`＋ ${item.name}`, `￥${item.amount}`));
        pair('项目合计', `￥${line.lineTotal}`, true);
        divider();
      });
      if (quote.calculation.orderAddOns.length) {
        text('整单附加费用', 24, '#17211f', true);
        quote.calculation.orderAddOns.forEach((item) => pair(item.name, `￥${item.amount}`));
      }
      pair('小计', `￥${quote.calculation.subtotal}`);
      if (quote.calculation.discountAmount !== '0.00')
        pair('优惠', `-￥${quote.calculation.discountAmount}`);
      if (quote.calculation.manualAdjustment !== '0.00')
        pair('手工调整', `￥${quote.calculation.manualAdjustment}`);
      pair('税务模式', taxModeText(quote.calculation));
      if (quote.calculation.taxMode !== 'NONE')
        pair(
          quote.calculation.taxMode === 'INCLUDED' ? '其中税额' : '税额',
          `￥${quote.calculation.taxAmount}`,
        );
      if (quote.calculation.roundingAdjustment !== '0.00')
        pair('取整调整', `￥${quote.calculation.roundingAdjustment}`);
      pair('报价总额', `￥${quote.calculation.total}`, true);
      divider();
      if (quote.notes) {
        text('备注', 24, '#17211f', true);
        text(quote.notes, 21, '#4b5754');
      }
      if (quote.terms) {
        text('报价条款', 24, '#17211f', true);
        text(quote.terms, 21, '#4b5754');
      }
      divider();
      text(quote.merchant.contactName || quote.merchant.name, 23, '#17211f', true);
      if (quote.merchant.contactPhone || quote.merchant.contactWechat) {
        text(
          `${quote.merchant.contactPhone || ''}${quote.merchant.contactWechat ? ' · 微信 ' + quote.merchant.contactWechat : ''}`,
          21,
          '#4b5754',
        );
      }
      text('接受报价用于确认当前价格与范围，不等同于付款或电子合同。', 18, '#78827f');

      const pages = [];
      let page = [];
      let usedHeight = 100;
      for (const row of rows) {
        if (page.length && usedHeight + row.height > IMAGE_PAGE_HEIGHT - 70) {
          pages.push(page);
          page = [];
          usedHeight = 100;
        }
        page.push(row);
        usedHeight += row.height;
      }
      if (page.length) pages.push(page);

      const paths = [];
      for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
        canvas.width = IMAGE_WIDTH * IMAGE_SCALE;
        canvas.height = IMAGE_PAGE_HEIGHT * IMAGE_SCALE;
        const pageContext = canvas.getContext('2d');
        pageContext.scale(IMAGE_SCALE, IMAGE_SCALE);
        pageContext.fillStyle = '#f3f1e9';
        pageContext.fillRect(0, 0, IMAGE_WIDTH, IMAGE_PAGE_HEIGHT);
        pageContext.fillStyle = '#fff';
        pageContext.fillRect(20, 20, 710, IMAGE_PAGE_HEIGHT - 40);
        pageContext.font = canvasFont(18, false);
        pageContext.fillStyle = '#78827f';
        pageContext.textAlign = 'right';
        pageContext.fillText(`第 ${pageIndex + 1} / ${pages.length} 页`, right, 55);
        let y = 90;
        for (const row of pages[pageIndex]) {
          if (row.type === 'text') {
            pageContext.font = canvasFont(row.size, row.bold);
            pageContext.fillStyle = row.color;
            pageContext.textAlign = 'left';
            pageContext.fillText(row.value, left, y);
          } else if (row.type === 'pair') {
            pageContext.font = canvasFont(24, row.bold);
            pageContext.fillStyle = '#46534f';
            pageContext.textAlign = 'left';
            pageContext.fillText(row.label, left, y);
            pageContext.fillStyle = row.bold ? '#0b6b5f' : '#17211f';
            pageContext.textAlign = 'right';
            pageContext.fillText(row.value, right, y);
          } else {
            pageContext.strokeStyle = '#dfe6e2';
            pageContext.beginPath();
            pageContext.moveTo(left, y);
            pageContext.lineTo(right, y);
            pageContext.stroke();
          }
          y += row.height;
        }
        const imageHeight = Math.min(IMAGE_PAGE_HEIGHT, y + 40);
        const path = await new Promise((resolve, reject) =>
          wx.canvasToTempFilePath(
            {
              canvas,
              x: 0,
              y: 0,
              width: IMAGE_WIDTH * IMAGE_SCALE,
              height: imageHeight * IMAGE_SCALE,
              destWidth: IMAGE_WIDTH * IMAGE_SCALE,
              destHeight: imageHeight * IMAGE_SCALE,
              fileType: 'png',
              success: (value) => resolve(value.tempFilePath),
              fail: reject,
            },
            this,
          ),
        );
        paths.push(path);
      }
      for (const path of paths) {
        await new Promise((resolve, reject) =>
          wx.saveImageToPhotosAlbum({ filePath: path, success: resolve, fail: reject }),
        );
      }
      wx.showToast({ title: `已保存 ${paths.length} 张`, icon: 'success' });
    } catch (error) {
      const message = error.message || error.errMsg || '长图生成失败';
      if (/auth deny|authorize|permission/i.test(message)) {
        const result = await new Promise((resolve) =>
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中允许保存到相册，然后重新点击保存长图。',
            confirmText: '打开设置',
            success: resolve,
          }),
        );
        if (result.confirm) wx.openSetting();
      } else {
        wx.showToast({ title: message, icon: 'none' });
      }
    } finally {
      wx.hideLoading();
    }
  },
});
