const api = require('../../utils/api');

Page({
  data: {
    loading: true,
    error: '',
    tab: 'products',
    categories: [],
    categoryNames: ['未分类'],
    categoryIndex: 0,
    products: [],
    visibleProducts: [],
    query: '',
    addOns: [],
    editing: false,
    formType: 'product',
    form: null,
    formulaOptions: ['固定价', '数量 × 单价', '面积 × 单价'],
    formulaValues: ['FIXED', 'QUANTITY', 'AREA'],
    formulaIndex: 2,
    addonOptions: ['固定金额', '按数量', '按面积', '按比例'],
    addonValues: ['FIXED', 'QUANTITY', 'AREA', 'PERCENT'],
    addonIndex: 0,
  },
  onShow() {
    this.load();
  },
  async load() {
    this.setData({ loading: true, error: '' });
    try {
      const result = await api.request('/catalog');
      const products = result.products.map((item) => ({
        ...item,
        formulaLabel: { FIXED: '固定价', QUANTITY: '数量计价', AREA: '面积计价' }[item.formulaType],
      }));
      this.setData({
        categories: result.categories,
        categoryNames: ['未分类', ...result.categories.map((item) => item.name)],
        products,
        visibleProducts: products,
        query: '',
        addOns: result.addOns.map((item) => ({
          ...item,
          pricingLabel: {
            FIXED: '固定金额',
            QUANTITY: '按数量',
            AREA: '按面积',
            PERCENT: '按比例',
          }[item.pricingType],
        })),
      });
    } catch (error) {
      this.setData({ error: error.message || '加载失败' });
    } finally {
      this.setData({ loading: false });
    }
  },
  setTab(event) {
    this.setData({ tab: event.currentTarget.dataset.tab, editing: false });
  },
  onSearch(event) {
    const query = event.detail.value.trim().toLowerCase();
    this.setData({
      query: event.detail.value,
      visibleProducts: this.data.products.filter(
        (item) =>
          !query ||
          item.name.toLowerCase().includes(query) ||
          item.code.toLowerCase().includes(query),
      ),
    });
  },
  noop() {},
  newItem() {
    if (this.data.tab === 'products') {
      this.setData({
        editing: true,
        formType: 'product',
        formulaIndex: 2,
        categoryIndex: 0,
        form: {
          categoryId: null,
          code: '',
          name: '',
          formulaType: 'AREA',
          unit: '㎡',
          salePrice: '0',
          costPrice: '',
          minimumCharge: '0',
          lossRate: '0',
          notes: '',
          enabled: true,
          isDemo: false,
        },
      });
    } else {
      this.setData({
        editing: true,
        formType: 'addon',
        addonIndex: 0,
        products: this.data.products.map((product) => ({ ...product, applicable: false })),
        form: {
          name: '',
          pricingType: 'FIXED',
          unit: '项',
          price: '0',
          notes: '',
          enabled: true,
          applicableProductIds: [],
        },
      });
    }
  },
  editProduct(event) {
    const form = {
      ...this.data.products.find((product) => product.id === event.currentTarget.dataset.id),
    };
    const categoryPosition = this.data.categories.findIndex(
      (category) => category.id === form.categoryId,
    );
    this.setData({
      editing: true,
      formType: 'product',
      form,
      formulaIndex: this.data.formulaValues.indexOf(form.formulaType),
      categoryIndex: categoryPosition >= 0 ? categoryPosition + 1 : 0,
    });
  },
  editAddon(event) {
    const form = { ...this.data.addOns[Number(event.currentTarget.dataset.index)] };
    this.setData({
      editing: true,
      formType: 'addon',
      form,
      addonIndex: this.data.addonValues.indexOf(form.pricingType),
      products: this.data.products.map((product) => ({
        ...product,
        applicable: form.applicableProductIds.includes(product.id),
      })),
    });
  },
  closeForm() {
    this.setData({ editing: false, form: null });
  },
  onFormField(event) {
    const form = { ...this.data.form };
    form[event.currentTarget.dataset.field] = event.detail.value;
    this.setData({ form });
  },
  onFormula(event) {
    const index = Number(event.detail.value);
    this.setData({ formulaIndex: index, 'form.formulaType': this.data.formulaValues[index] });
  },
  onCategory(event) {
    const index = Number(event.detail.value);
    this.setData({
      categoryIndex: index,
      'form.categoryId': index === 0 ? null : this.data.categories[index - 1].id,
    });
  },
  onAddonType(event) {
    const index = Number(event.detail.value);
    this.setData({ addonIndex: index, 'form.pricingType': this.data.addonValues[index] });
  },
  onEnabled(event) {
    this.setData({ 'form.enabled': event.detail.value });
  },
  onApplicableProducts(event) {
    this.setData({
      'form.applicableProductIds': event.detail.value,
      products: this.data.products.map((product) => ({
        ...product,
        applicable: event.detail.value.includes(product.id),
      })),
    });
  },
  async save() {
    const form = { ...this.data.form };
    try {
      if (this.data.formType === 'product') {
        form.costPrice = form.costPrice || null;
        await api.request(form.id ? `/catalog/products/${form.id}` : '/catalog/products', {
          method: form.id ? 'PUT' : 'POST',
          data: form,
        });
      } else {
        await api.request(form.id ? `/catalog/addons/${form.id}` : '/catalog/addons', {
          method: form.id ? 'PUT' : 'POST',
          data: form,
        });
      }
      this.closeForm();
      await this.load();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (error) {
      this.setData({ error: error.message || '保存失败' });
    }
  },
  async addCategory() {
    const result = await new Promise((resolve) =>
      wx.showModal({
        title: '新建分类',
        editable: true,
        placeholderText: '分类名称',
        success: resolve,
      }),
    );
    if (!result.confirm || !result.content?.trim()) return;
    try {
      await api.request('/catalog/categories', {
        method: 'POST',
        data: { name: result.content.trim(), sortOrder: 0, enabled: true },
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '创建失败', icon: 'none' });
    }
  },
  async editCategory(event) {
    const category = this.data.categories[Number(event.currentTarget.dataset.index)];
    const result = await new Promise((resolve) =>
      wx.showModal({
        title: '编辑分类',
        editable: true,
        content: category.name,
        placeholderText: '分类名称',
        success: resolve,
      }),
    );
    if (!result.confirm || !result.content?.trim()) return;
    try {
      await api.request(`/catalog/categories/${category.id}`, {
        method: 'PUT',
        data: { ...category, name: result.content.trim() },
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '更新失败', icon: 'none' });
    }
  },
  async toggleCategory(event) {
    const category = this.data.categories[Number(event.currentTarget.dataset.index)];
    try {
      await api.request(`/catalog/categories/${category.id}`, {
        method: 'PUT',
        data: { ...category, enabled: event.detail.value },
      });
      await this.load();
    } catch (error) {
      wx.showToast({ title: error.message || '更新失败', icon: 'none' });
    }
  },
});
