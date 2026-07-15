import { useMemo, useState } from 'react';

import { api } from '../api.ts';
import { Button, Card, EmptyState, ErrorNotice, Field, Loading } from '../components.tsx';
import { money } from '../format.ts';
import { useAsyncData } from '../hooks.ts';
import type { AddOnPricingType, FormulaType } from '../../../shared/contracts.ts';
import type { CatalogProductView, CatalogResponse, Category } from '../types.ts';

const formulaLabels: Record<FormulaType, string> = {
  FIXED: '固定价',
  QUANTITY: '数量 × 单价',
  AREA: '长 × 宽 × 数量 × 单价',
};
const addOnLabels: Record<AddOnPricingType, string> = {
  FIXED: '固定金额',
  QUANTITY: '按数量',
  AREA: '按面积',
  PERCENT: '按项目金额比例',
};

interface ProductForm {
  id?: string;
  categoryId: string;
  code: string;
  name: string;
  formulaType: FormulaType;
  unit: string;
  salePrice: string;
  costPrice: string;
  minimumCharge: string;
  lossRate: string;
  notes: string;
  enabled: boolean;
  isDemo: boolean;
}

interface AddOnForm {
  id?: string;
  name: string;
  pricingType: AddOnPricingType;
  unit: string;
  price: string;
  notes: string;
  enabled: boolean;
  applicableProductIds: string[];
}

const emptyProduct: ProductForm = {
  categoryId: '',
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
};

export function CatalogPage() {
  const catalog = useAsyncData(() => api<CatalogResponse>('/catalog'));
  const [tab, setTab] = useState<'products' | 'addons'>('products');
  const [search, setSearch] = useState('');
  const [productForm, setProductForm] = useState<ProductForm | null>(null);
  const [addOnForm, setAddOnForm] = useState<AddOnForm | null>(null);
  const [categoryForm, setCategoryForm] = useState<Category | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const products = useMemo(() => {
    const value = search.trim().toLowerCase();
    return (catalog.data?.products ?? []).filter(
      (item) =>
        !value ||
        item.name.toLowerCase().includes(value) ||
        item.code.toLowerCase().includes(value),
    );
  }, [catalog.data, search]);

  if (catalog.loading) return <Loading />;

  const editProduct = (product: CatalogProductView) => {
    setProductForm({
      id: product.id,
      categoryId: product.categoryId ?? '',
      code: product.code,
      name: product.name,
      formulaType: product.formulaType,
      unit: product.unit,
      salePrice: product.salePrice,
      costPrice: product.costPrice ?? '',
      minimumCharge: product.minimumCharge,
      lossRate: product.lossRate,
      notes: product.notes,
      enabled: product.enabled,
      isDemo: product.isDemo,
    });
  };

  const saveProduct = async () => {
    if (!productForm) return;
    setSaving(true);
    setError('');
    try {
      const body = {
        ...productForm,
        categoryId: productForm.categoryId || null,
        costPrice: productForm.costPrice || null,
      };
      await api(productForm.id ? `/catalog/products/${productForm.id}` : '/catalog/products', {
        method: productForm.id ? 'PUT' : 'POST',
        body: JSON.stringify(body),
      });
      setProductForm(null);
      await catalog.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveAddOn = async () => {
    if (!addOnForm) return;
    setSaving(true);
    setError('');
    try {
      await api(addOnForm.id ? `/catalog/addons/${addOnForm.id}` : '/catalog/addons', {
        method: addOnForm.id ? 'PUT' : 'POST',
        body: JSON.stringify(addOnForm),
      });
      setAddOnForm(null);
      await catalog.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const saveCategory = async () => {
    if (!categoryForm) return;
    setSaving(true);
    setError('');
    try {
      const exists = catalog.data?.categories.some((item) => item.id === categoryForm.id);
      await api(exists ? `/catalog/categories/${categoryForm.id}` : '/catalog/categories', {
        method: exists ? 'PUT' : 'POST',
        body: JSON.stringify(categoryForm),
      });
      setCategoryForm(null);
      await catalog.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '分类保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="page-heading heading-with-action">
        <div>
          <span className="eyebrow">先把高频规则录一次</span>
          <h1>价格库</h1>
          <p>销售价、最低收费、损耗和工艺规则会在发布时冻结，不影响历史报价。</p>
        </div>
        <Button
          onClick={() =>
            tab === 'products'
              ? setProductForm({ ...emptyProduct })
              : setAddOnForm({
                  name: '',
                  pricingType: 'FIXED',
                  unit: '项',
                  price: '0',
                  notes: '',
                  enabled: true,
                  applicableProductIds: [],
                })
          }
        >
          ＋ 新建{tab === 'products' ? '产品' : '附加项'}
        </Button>
      </div>
      {(error || catalog.error) && <ErrorNotice message={error || catalog.error} />}
      <div className="tab-row">
        <button className={tab === 'products' ? 'active' : ''} onClick={() => setTab('products')}>
          产品与材料
        </button>
        <button className={tab === 'addons' ? 'active' : ''} onClick={() => setTab('addons')}>
          工艺与附加项
        </button>
      </div>

      {tab === 'products' ? (
        <>
          <Card
            title="产品分类"
            action={
              <Button
                variant="secondary"
                onClick={() =>
                  setCategoryForm({
                    id: crypto.randomUUID(),
                    name: '',
                    sortOrder: (catalog.data?.categories.length ?? 0) + 1,
                    enabled: true,
                  })
                }
              >
                ＋ 分类
              </Button>
            }
          >
            <div className="button-row">
              {catalog.data?.categories.map((category) => (
                <Button
                  key={category.id}
                  variant="ghost"
                  onClick={() => setCategoryForm({ ...category })}
                >
                  {category.name} · {category.enabled ? '启用' : '停用'}
                </Button>
              ))}
            </div>
          </Card>
          <Card>
            <div className="toolbar">
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索产品名称或编码"
              />
              <span>{products.length} 个产品</span>
            </div>
            {products.length === 0 ? (
              <EmptyState title="没有找到产品" text="新建常用产品，或换一个关键词。" />
            ) : (
              <div className="data-table catalog-table">
                <div className="table-head">
                  <span>产品</span>
                  <span>计价方式</span>
                  <span>销售价</span>
                  <span>最低收费</span>
                  <span>状态</span>
                  <span />
                </div>
                {products.map((product) => (
                  <div className="table-row" key={product.id}>
                    <span>
                      <strong>{product.name}</strong>
                      <small>
                        {product.code || '无编码'}
                        {product.isDemo ? ' · 演示价格' : ''}
                      </small>
                    </span>
                    <span>{formulaLabels[product.formulaType]}</span>
                    <span>
                      {money(product.salePrice)} / {product.unit}
                    </span>
                    <span>{money(product.minimumCharge)}</span>
                    <span className={product.enabled ? 'text-success' : 'muted'}>
                      {product.enabled ? '启用' : '已停用'}
                    </span>
                    <span>
                      <Button variant="ghost" onClick={() => editProduct(product)}>
                        编辑
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card>
          {(catalog.data?.addOns.length ?? 0) === 0 ? (
            <EmptyState title="还没有附加项" text="把安装、运输、覆膜、包边等常用费用录进来。" />
          ) : (
            <div className="data-table addon-table">
              <div className="table-head">
                <span>名称</span>
                <span>计价方式</span>
                <span>价格</span>
                <span>状态</span>
                <span />
              </div>
              {catalog.data?.addOns.map((item) => (
                <div className="table-row" key={item.id}>
                  <span>
                    <strong>{item.name}</strong>
                    <small>{item.notes}</small>
                  </span>
                  <span>{addOnLabels[item.pricingType]}</span>
                  <span>
                    {item.pricingType === 'PERCENT'
                      ? `${item.price}%`
                      : `${money(item.price)} / ${item.unit}`}
                  </span>
                  <span className={item.enabled ? 'text-success' : 'muted'}>
                    {item.enabled ? '启用' : '已停用'}
                  </span>
                  <span>
                    <Button variant="ghost" onClick={() => setAddOnForm({ ...item })}>
                      编辑
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {productForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setProductForm(null)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>{productForm.id ? '编辑产品' : '新建产品'}</h2>
              <button onClick={() => setProductForm(null)}>×</button>
            </div>
            <div className="form-grid">
              <Field label="产品名称" className="span-2">
                <input
                  value={productForm.name}
                  onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                />
              </Field>
              <Field label="产品编码">
                <input
                  value={productForm.code}
                  onChange={(e) => setProductForm({ ...productForm, code: e.target.value })}
                />
              </Field>
              <Field label="分类">
                <select
                  value={productForm.categoryId}
                  onChange={(e) => setProductForm({ ...productForm, categoryId: e.target.value })}
                >
                  <option value="">未分类</option>
                  {catalog.data?.categories
                    .filter((item) => item.enabled)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="计价公式">
                <select
                  value={productForm.formulaType}
                  onChange={(e) =>
                    setProductForm({ ...productForm, formulaType: e.target.value as FormulaType })
                  }
                >
                  {Object.entries(formulaLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="计价单位">
                <input
                  value={productForm.unit}
                  onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })}
                />
              </Field>
              <Field label="销售价（元）">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={productForm.salePrice}
                  onChange={(e) => setProductForm({ ...productForm, salePrice: e.target.value })}
                />
              </Field>
              <Field label="成本价（选填）">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={productForm.costPrice}
                  onChange={(e) => setProductForm({ ...productForm, costPrice: e.target.value })}
                />
              </Field>
              <Field label="最低收费（元）">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={productForm.minimumCharge}
                  onChange={(e) =>
                    setProductForm({ ...productForm, minimumCharge: e.target.value })
                  }
                />
              </Field>
              <Field label="损耗率（%）">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  value={productForm.lossRate}
                  onChange={(e) => setProductForm({ ...productForm, lossRate: e.target.value })}
                />
              </Field>
              <Field label="备注" className="span-2">
                <textarea
                  value={productForm.notes}
                  onChange={(e) => setProductForm({ ...productForm, notes: e.target.value })}
                />
              </Field>
              <label className="check-row span-2">
                <input
                  type="checkbox"
                  checked={productForm.enabled}
                  onChange={(e) => setProductForm({ ...productForm, enabled: e.target.checked })}
                />
                允许用于新报价
              </label>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setProductForm(null)}>
                取消
              </Button>
              <Button disabled={saving || !productForm.name} onClick={() => void saveProduct()}>
                {saving ? '保存中…' : '保存产品'}
              </Button>
            </div>
          </div>
        </div>
      )}
      {categoryForm && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setCategoryForm(null)}
        >
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>产品分类</h2>
              <button onClick={() => setCategoryForm(null)}>×</button>
            </div>
            <div className="form-grid">
              <Field label="分类名称">
                <input
                  value={categoryForm.name}
                  onChange={(event) =>
                    setCategoryForm({ ...categoryForm, name: event.target.value })
                  }
                />
              </Field>
              <Field label="排序">
                <input
                  type="number"
                  value={categoryForm.sortOrder}
                  onChange={(event) =>
                    setCategoryForm({ ...categoryForm, sortOrder: Number(event.target.value) })
                  }
                />
              </Field>
              <label className="check-row span-2">
                <input
                  type="checkbox"
                  checked={categoryForm.enabled}
                  onChange={(event) =>
                    setCategoryForm({ ...categoryForm, enabled: event.target.checked })
                  }
                />
                启用分类
              </label>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setCategoryForm(null)}>
                取消
              </Button>
              <Button
                disabled={saving || !categoryForm.name.trim()}
                onClick={() => void saveCategory()}
              >
                保存分类
              </Button>
            </div>
          </div>
        </div>
      )}

      {addOnForm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setAddOnForm(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>{addOnForm.id ? '编辑附加项' : '新建附加项'}</h2>
              <button onClick={() => setAddOnForm(null)}>×</button>
            </div>
            <div className="form-grid">
              <Field label="名称" className="span-2">
                <input
                  value={addOnForm.name}
                  onChange={(e) => setAddOnForm({ ...addOnForm, name: e.target.value })}
                />
              </Field>
              <Field label="计价方式">
                <select
                  value={addOnForm.pricingType}
                  onChange={(e) =>
                    setAddOnForm({ ...addOnForm, pricingType: e.target.value as AddOnPricingType })
                  }
                >
                  {Object.entries(addOnLabels).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="单位">
                <input
                  value={addOnForm.unit}
                  onChange={(e) => setAddOnForm({ ...addOnForm, unit: e.target.value })}
                />
              </Field>
              <Field label={addOnForm.pricingType === 'PERCENT' ? '比例（%）' : '价格（元）'}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={addOnForm.price}
                  onChange={(e) => setAddOnForm({ ...addOnForm, price: e.target.value })}
                />
              </Field>
              <Field label="备注" className="span-2">
                <textarea
                  value={addOnForm.notes}
                  onChange={(e) => setAddOnForm({ ...addOnForm, notes: e.target.value })}
                />
              </Field>
              <fieldset className="span-2 checkbox-fieldset">
                <legend>适用产品（不选表示全部产品）</legend>
                <div className="checkbox-grid">
                  {catalog.data?.products.map((product) => (
                    <label className="check-row" key={product.id}>
                      <input
                        type="checkbox"
                        checked={addOnForm.applicableProductIds.includes(product.id)}
                        onChange={(event) =>
                          setAddOnForm({
                            ...addOnForm,
                            applicableProductIds: event.target.checked
                              ? [...addOnForm.applicableProductIds, product.id]
                              : addOnForm.applicableProductIds.filter((id) => id !== product.id),
                          })
                        }
                      />
                      {product.name}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className="check-row span-2">
                <input
                  type="checkbox"
                  checked={addOnForm.enabled}
                  onChange={(e) => setAddOnForm({ ...addOnForm, enabled: e.target.checked })}
                />
                允许用于新报价
              </label>
            </div>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setAddOnForm(null)}>
                取消
              </Button>
              <Button disabled={saving || !addOnForm.name} onClick={() => void saveAddOn()}>
                {saving ? '保存中…' : '保存附加项'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
