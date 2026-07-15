import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type {
  DraftAddOnInput,
  DraftLineInput,
  QuoteCalculation,
  QuoteDraftData,
} from '../../../shared/contracts.ts';
import { calculateQuote } from '../../../shared/pricing.ts';
import { api, ApiError } from '../api.ts';
import { Button, Card, ErrorNotice, Field, Loading } from '../components.tsx';
import { money, todayPlus } from '../format.ts';
import { GenerationQueue } from '../generation-queue.ts';
import type { CatalogProductView, CatalogResponse, Merchant, QuoteDetail } from '../types.ts';

interface DraftSaveResponse {
  id?: string;
  quoteNumber?: string;
  draftRevision: number;
  calculation: QuoteCalculation | null;
  calculationHash: string | null;
}

interface SavedDraft {
  id: string;
  draftRevision: number;
  calculation: QuoteCalculation;
  calculationHash: string;
  current: boolean;
}

class StaleEditorSessionError extends Error {
  constructor() {
    super('报价编辑页面已切换');
    this.name = 'StaleEditorSessionError';
  }
}

function createDefaultDraft(merchant: Merchant): QuoteDraftData {
  return {
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
    validUntil: todayPlus(merchant.defaultValidDays),
    deliveryPeriod: merchant.defaultDeliveryPeriod,
    notes: '',
    terms: merchant.defaultTerms,
  };
}

function createLine(product: CatalogProductView): DraftLineInput {
  return {
    id: crypto.randomUUID(),
    productId: product.id,
    quantity: '1',
    ...(product.formulaType === 'AREA'
      ? {
          length: { value: '1', unit: 'm' as const },
          width: { value: '1', unit: 'm' as const },
        }
      : {}),
    addOns: [],
    description: '',
  };
}

function createAddOn(addOnId: string): DraftAddOnInput {
  return { id: crypto.randomUUID(), addOnId };
}

function recoveryKey(quoteId: string): string {
  return `diangao_draft_recovery_${quoteId || 'new'}`;
}

export function QuoteEditorPage() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const [quoteId, setQuoteId] = useState(routeId ?? '');
  const [quoteNumber, setQuoteNumber] = useState('');
  const [draftVersion, setDraftVersion] = useState(1);
  const [draft, setDraftState] = useState<QuoteDraftData | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [merchant, setMerchant] = useState<Merchant | null>(null);
  const [calculation, setCalculation] = useState<QuoteCalculation | null>(null);
  const [calculationHash, setCalculationHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadedRouteId, setLoadedRouteId] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [previewHash, setPreviewHash] = useState<string | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [error, setError] = useState('');
  const initialized = useRef(false);
  const latestDraft = useRef<QuoteDraftData | null>(null);
  const autoSaveTimer = useRef<number | null>(null);
  const quoteIdRef = useRef(routeId ?? '');
  const draftRevisionRef = useRef<number | null>(null);
  const pendingSaveCount = useRef(0);
  const mounted = useRef(true);
  const editorSession = useRef(0);
  const [saveQueue] = useState(() => new GenerationQueue());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const persistSnapshot = useCallback(
    async (snapshot: QuoteDraftData, generation: number, session: number): Promise<SavedDraft> => {
      pendingSaveCount.current += 1;
      if (mounted.current) setSaving(true);
      const queued = saveQueue.enqueue(generation, async () => {
        if (editorSession.current !== session) throw new StaleEditorSessionError();
        if (mounted.current && saveQueue.isCurrent(generation)) setSaveState('正在同步…');
        const currentQuoteId = quoteIdRef.current;
        let response: DraftSaveResponse;
        if (currentQuoteId) {
          const revision = draftRevisionRef.current;
          if (!Number.isInteger(revision)) {
            throw new Error('草稿修订号缺失，请刷新报价后重试');
          }
          response = await api<DraftSaveResponse>(`/quotes/${currentQuoteId}/draft`, {
            method: 'PUT',
            headers: { 'if-match': String(revision) },
            body: JSON.stringify(snapshot),
          });
        } else {
          response = await api<DraftSaveResponse>('/quotes', {
            method: 'POST',
            body: JSON.stringify(snapshot),
          });
        }
        if (editorSession.current !== session) throw new StaleEditorSessionError();
        if (!response.calculation || !response.calculationHash) {
          throw new Error('报价计算尚未完成');
        }
        if (!Number.isInteger(response.draftRevision)) {
          throw new Error('服务器未返回有效草稿修订号');
        }
        const savedId = response.id ?? currentQuoteId;
        if (!savedId) throw new Error('服务器未返回报价编号');
        quoteIdRef.current = savedId;
        draftRevisionRef.current = response.draftRevision;
        if (!currentQuoteId && mounted.current) {
          setQuoteId(savedId);
          if (response.quoteNumber) setQuoteNumber(response.quoteNumber);
          window.history.replaceState(null, '', `/quotes/${savedId}/edit`);
        }
        return {
          id: savedId,
          draftRevision: response.draftRevision,
          calculation: response.calculation,
          calculationHash: response.calculationHash,
        };
      });

      try {
        const completed = await queued;
        const isCurrent =
          editorSession.current === session && completed.current && saveQueue.isCurrent(generation);
        if (isCurrent && mounted.current) {
          setCalculation(completed.value.calculation);
          setCalculationHash(completed.value.calculationHash);
          setDirty(false);
          setSaveState('已同步');
          localStorage.removeItem(recoveryKey(''));
          localStorage.removeItem(recoveryKey(completed.value.id));
        } else {
          const newest = latestDraft.current;
          if (newest) {
            localStorage.setItem(recoveryKey(completed.value.id), JSON.stringify(newest));
          }
        }
        return { ...completed.value, current: isCurrent };
      } finally {
        pendingSaveCount.current -= 1;
        if (mounted.current && pendingSaveCount.current === 0) setSaving(false);
      }
    },
    [saveQueue],
  );

  useEffect(() => {
    let active = true;
    const session = editorSession.current + 1;
    editorSession.current = session;
    saveQueue.advance();
    quoteIdRef.current = routeId ?? '';
    draftRevisionRef.current = null;
    initialized.current = false;
    latestDraft.current = null;
    setLoading(true);
    setLoadedRouteId(null);
    setQuoteId(routeId ?? '');
    setQuoteNumber('');
    setDraftVersion(1);
    setDraftState(null);
    setCalculation(null);
    setCalculationHash(null);
    setCalculating(false);
    setSaving(false);
    setPublishing(false);
    setPreviewing(false);
    setPreviewHash(null);
    setProductQuery('');
    setDirty(false);
    setSaveState('');
    setError('');
    const load = async () => {
      try {
        const [catalogData, merchantData] = await Promise.all([
          api<CatalogResponse>('/catalog'),
          api<Merchant>('/merchant'),
        ]);
        if (!active || editorSession.current !== session) return;
        setCatalog(catalogData);
        setMerchant(merchantData);
        let nextDraft: QuoteDraftData;
        if (routeId) {
          const quote = await api<QuoteDetail>(`/quotes/${routeId}`);
          if (!active || editorSession.current !== session) return;
          if (!quote.draft) throw new Error('当前没有可编辑草稿，请从报价详情创建新版本');
          nextDraft = quote.draft;
          setQuoteNumber(quote.quoteNumber);
          setDraftVersion(quote.draftVersion ?? quote.currentVersion + 1);
          draftRevisionRef.current = quote.draftRevision;
        } else {
          nextDraft = createDefaultDraft(merchantData);
        }
        let recovered = false;
        const stored = localStorage.getItem(recoveryKey(routeId ?? ''));
        if (stored) {
          try {
            const parsed = JSON.parse(stored) as QuoteDraftData;
            if (parsed && Array.isArray(parsed.lines)) {
              nextDraft = parsed;
              recovered = true;
            }
          } catch {
            localStorage.removeItem(recoveryKey(routeId ?? ''));
          }
        }
        latestDraft.current = nextDraft;
        setDraftState(nextDraft);
        initialized.current = true;
        if (recovered) {
          setDirty(true);
          setSaveState('已恢复未同步草稿');
        }
      } catch (reason) {
        if (active && editorSession.current === session) {
          setError(reason instanceof Error ? reason.message : '无法加载报价');
        }
      } finally {
        if (active && editorSession.current === session) {
          setLoadedRouteId(routeId ?? '');
          setLoading(false);
        }
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, [routeId, saveQueue]);

  useEffect(() => {
    const generation = saveQueue.generation;
    let active = true;
    if (!draft || !catalog || draft.lines.length === 0) {
      setCalculation(null);
      setCalculationHash(null);
      setCalculating(false);
      return () => {
        active = false;
      };
    }
    try {
      setCalculation(calculateQuote(draft, catalog.products, catalog.addOns));
      setError('');
    } catch {
      setCalculation(null);
    }
    setCalculationHash(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        setCalculating(true);
        try {
          const result = await api<{ calculation: QuoteCalculation; calculationHash: string }>(
            '/quotes/calculate',
            {
              method: 'POST',
              body: JSON.stringify(draft),
            },
          );
          if (!active || !saveQueue.isCurrent(generation)) return;
          setCalculation(result.calculation);
          setCalculationHash(result.calculationHash);
          setError('');
        } catch (reason) {
          if (!active || !saveQueue.isCurrent(generation)) return;
          setCalculation(null);
          setCalculationHash(null);
          setError(reason instanceof Error ? reason.message : '计算失败');
        } finally {
          if (active && saveQueue.isCurrent(generation)) setCalculating(false);
        }
      })();
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [catalog, draft, saveQueue]);

  useEffect(() => {
    if (!draft || !dirty || !initialized.current) return;
    if (!draft.customerName.trim() || draft.lines.length === 0) {
      setSaveState('已在本机暂存，填写客户和项目后自动同步');
      return;
    }
    const snapshot = draft;
    const generation = saveQueue.generation;
    const session = editorSession.current;
    setSaveState('等待同步');
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await persistSnapshot(snapshot, generation, session);
        } catch (reason) {
          if (
            reason instanceof StaleEditorSessionError ||
            editorSession.current !== session ||
            !saveQueue.isCurrent(generation)
          )
            return;
          setSaveState('未同步，草稿仍保存在本机');
          setError(
            reason instanceof ApiError && reason.code === 'DRAFT_CHANGED'
              ? '草稿已在其他窗口更新，本机副本仍保留；请刷新后重新合并'
              : reason instanceof Error
                ? reason.message
                : '草稿保存失败',
          );
        }
      })();
    }, 900);
    autoSaveTimer.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (autoSaveTimer.current === timer) autoSaveTimer.current = null;
    };
  }, [dirty, draft, persistSnapshot, saveQueue]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const activeProducts = useMemo(
    () => catalog?.products.filter((item) => item.enabled) ?? [],
    [catalog],
  );
  const visibleProducts = useMemo(() => {
    const query = productQuery.trim().toLowerCase();
    if (!query) return activeProducts;
    return activeProducts.filter(
      (product) =>
        product.name.toLowerCase().includes(query) || product.code.toLowerCase().includes(query),
    );
  }, [activeProducts, productQuery]);
  const activeAddOns = useMemo(
    () => catalog?.addOns.filter((item) => item.enabled) ?? [],
    [catalog],
  );

  if (loading || loadedRouteId !== (routeId ?? '')) return <Loading />;
  if (!draft || !catalog || !merchant) return <ErrorNotice message={error || '无法编辑报价'} />;

  const setDraft = (next: QuoteDraftData) => {
    saveQueue.advance();
    latestDraft.current = next;
    setDraftState(next);
    setCalculationHash(null);
    setPreviewHash(null);
    setDirty(true);
    localStorage.setItem(recoveryKey(quoteIdRef.current), JSON.stringify(next));
  };

  const updateLine = (lineId: string, update: Partial<DraftLineInput>) => {
    setDraft({
      ...draft,
      lines: draft.lines.map((line) => (line.id === lineId ? { ...line, ...update } : line)),
    });
  };

  const persist = async (): Promise<{
    id: string;
    draftRevision: number;
    calculation: QuoteCalculation;
    calculationHash: string;
  }> => {
    if (autoSaveTimer.current !== null) {
      window.clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    if (!draft.customerName.trim()) throw new Error('请填写客户名称');
    if (draft.lines.length === 0) throw new Error('请至少添加一个报价项目');
    const generation = saveQueue.generation;
    const session = editorSession.current;
    const saved = await persistSnapshot(draft, generation, session);
    if (!saved.current || latestDraft.current !== draft) {
      throw new Error('草稿在保存时发生变化，请核对最新内容后重试');
    }
    setSaveState('已保存');
    return saved;
  };

  const saveOnly = async () => {
    setError('');
    try {
      await persist();
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.code === 'DRAFT_CHANGED'
          ? '草稿已在其他窗口更新，本机副本仍保留；请刷新后重新合并'
          : reason instanceof Error
            ? reason.message
            : '保存失败',
      );
    }
  };

  const publish = async () => {
    setError('');
    setPublishing(true);
    try {
      const persisted = await persist();
      if (!previewHash || persisted.calculationHash !== previewHash) {
        setCalculation(persisted.calculation);
        setCalculationHash(persisted.calculationHash);
        setPreviewHash(persisted.calculationHash);
        setPreviewing(true);
        setError('价格库或计算结果已变化，预览已更新；请核对新金额后再次确认发布');
        return;
      }
      const selectedProducts = draft.lines
        .map((line) => catalog.products.find((product) => product.id === line.productId))
        .filter((product): product is CatalogProductView => Boolean(product));
      const containsDemo = selectedProducts.some((product) => product.isDemo);
      const containsBelowCost =
        persisted.calculation.warnings.some(
          (warning) => warning.code === 'BELOW_COST' || warning.code === 'TOTAL_BELOW_COST',
        ) ?? false;
      const confirmDemoPrices =
        !containsDemo ||
        window.confirm('这份报价使用了演示价格。确认已经核对过本店真实价格并继续发布？');
      if (!confirmDemoPrices) return;
      const confirmBelowCost =
        !containsBelowCost || window.confirm('部分项目销售金额低于已录入成本。确认仍要发布？');
      if (!confirmBelowCost) return;
      setPreviewing(false);
      await api(`/quotes/${persisted.id}/publish`, {
        method: 'POST',
        body: JSON.stringify({
          confirmDemoPrices,
          confirmBelowCost,
          expectedCalculationHash: persisted.calculationHash,
          expectedDraftRevision: persisted.draftRevision,
        }),
      });
      void navigate(`/quotes/${persisted.id}`);
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'CALCULATION_CHANGED') {
        const details = reason.details as
          { calculation?: QuoteCalculation; calculationHash?: string } | undefined;
        if (details?.calculation) setCalculation(details.calculation);
        if (details?.calculationHash) setCalculationHash(details.calculationHash);
      }
      setError(
        reason instanceof ApiError && reason.code === 'DRAFT_CHANGED'
          ? '草稿已在其他窗口更新，本机副本仍保留；请刷新后重新合并'
          : reason instanceof Error
            ? reason.message
            : '发布失败',
      );
    } finally {
      setPublishing(false);
    }
  };

  return (
    <>
      <div className="page-heading heading-with-action editor-heading">
        <div>
          <Link className="back-link" to={quoteId ? `/quotes/${quoteId}` : '/quotes'}>
            ← 返回
          </Link>
          <h1>{quoteId ? '编辑报价草稿' : '新建报价'}</h1>
          <p>{saveState || '填写后可保存草稿或预览发布'}</p>
        </div>
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={saving || publishing}
            onClick={() => void saveOnly()}
          >
            {saving ? '保存中…' : '保存草稿'}
          </Button>
          <Button
            disabled={saving || publishing || calculating || !calculation || !calculationHash}
            onClick={() => {
              setPreviewHash(calculationHash);
              setPreviewing(true);
            }}
          >
            {publishing ? '发布中…' : '预览并发布'}
          </Button>
        </div>
      </div>
      {error && <ErrorNotice message={error} />}
      <div className="editor-layout">
        <div className="editor-main">
          <Card title="客户与项目">
            <div className="form-grid">
              <Field label="客户名称 *">
                <input
                  value={draft.customerName}
                  onChange={(e) => setDraft({ ...draft, customerName: e.target.value })}
                  placeholder="如：张先生 / XX 公司"
                />
              </Field>
              <Field label="联系方式（仅内部）">
                <input
                  value={draft.customerContact}
                  onChange={(e) => setDraft({ ...draft, customerContact: e.target.value })}
                  placeholder="手机或微信号"
                />
              </Field>
              <Field label="项目名称" className="span-2">
                <input
                  value={draft.projectName}
                  onChange={(e) => setDraft({ ...draft, projectName: e.target.value })}
                  placeholder="如：门头招牌制作"
                />
              </Field>
            </div>
          </Card>

          <Card
            title="报价项目"
            action={
              <div className="product-picker">
                <input
                  aria-label="搜索待添加产品"
                  value={productQuery}
                  placeholder="名称 / 编码"
                  onChange={(event) => setProductQuery(event.target.value)}
                />
                <select
                  className="add-select"
                  aria-label="添加产品"
                  value=""
                  onChange={(event) => {
                    const product = activeProducts.find((item) => item.id === event.target.value);
                    if (product) {
                      setDraft({ ...draft, lines: [...draft.lines, createLine(product)] });
                      setProductQuery('');
                    }
                  }}
                >
                  <option value="">
                    {visibleProducts.length === 0 ? '没有匹配产品' : '＋ 添加产品'}
                  </option>
                  {visibleProducts.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                      {product.code ? ` · ${product.code}` : ''}
                      {product.isDemo ? '（演示）' : ''}
                    </option>
                  ))}
                </select>
              </div>
            }
          >
            {draft.lines.length === 0 ? (
              <div className="editor-empty">从右上角选择产品，系统会按对应公式显示输入项。</div>
            ) : (
              <div className="line-editor-list">
                {draft.lines.map((line, index) => {
                  const product = catalog.products.find((item) => item.id === line.productId);
                  if (!product)
                    return (
                      <div key={line.id} className="notice notice-error">
                        产品已停用或删除，请移除此项目后重新选择。
                      </div>
                    );
                  const calculated = calculation?.lines.find((item) => item.id === line.id);
                  return (
                    <article className="line-editor" key={line.id}>
                      <div className="line-editor-title">
                        <div>
                          <span>{index + 1}</span>
                          <strong>{product.name}</strong>
                          {product.isDemo && <small>演示价格</small>}
                        </div>
                        <button
                          onClick={() =>
                            setDraft({
                              ...draft,
                              lines: draft.lines.filter((item) => item.id !== line.id),
                            })
                          }
                        >
                          移除
                        </button>
                      </div>
                      <div className="form-grid compact-grid">
                        {product.formulaType !== 'FIXED' && (
                          <Field label="数量">
                            <div className="input-unit">
                              <input
                                type="number"
                                min="0.0001"
                                step="any"
                                value={line.quantity}
                                onChange={(e) => updateLine(line.id, { quantity: e.target.value })}
                              />
                              <span>{product.unit}</span>
                            </div>
                          </Field>
                        )}
                        {product.formulaType === 'AREA' && (
                          <>
                            <Field label="长度">
                              <div className="input-unit">
                                <input
                                  type="number"
                                  min="0.0001"
                                  step="any"
                                  value={line.length?.value ?? ''}
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      length: {
                                        value: e.target.value,
                                        unit: line.length?.unit ?? 'm',
                                      },
                                    })
                                  }
                                />
                                <select
                                  value={line.length?.unit ?? 'm'}
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      length: {
                                        value: line.length?.value ?? '1',
                                        unit: e.target.value as 'mm' | 'cm' | 'm',
                                      },
                                    })
                                  }
                                >
                                  <option value="mm">mm</option>
                                  <option value="cm">cm</option>
                                  <option value="m">m</option>
                                </select>
                              </div>
                            </Field>
                            <Field label="宽度">
                              <div className="input-unit">
                                <input
                                  type="number"
                                  min="0.0001"
                                  step="any"
                                  value={line.width?.value ?? ''}
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      width: {
                                        value: e.target.value,
                                        unit: line.width?.unit ?? 'm',
                                      },
                                    })
                                  }
                                />
                                <select
                                  value={line.width?.unit ?? 'm'}
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      width: {
                                        value: line.width?.value ?? '1',
                                        unit: e.target.value as 'mm' | 'cm' | 'm',
                                      },
                                    })
                                  }
                                >
                                  <option value="mm">mm</option>
                                  <option value="cm">cm</option>
                                  <option value="m">m</option>
                                </select>
                              </div>
                            </Field>
                          </>
                        )}
                        <Field label="本次单价（可改）">
                          <div className="input-unit">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={line.unitPriceOverride ?? product.salePrice}
                              onChange={(e) =>
                                updateLine(line.id, { unitPriceOverride: e.target.value })
                              }
                            />
                            <span>元/{product.unit}</span>
                          </div>
                        </Field>
                        <Field label="项目说明" className="span-2">
                          <input
                            value={line.description}
                            onChange={(e) => updateLine(line.id, { description: e.target.value })}
                            placeholder="客户可见"
                          />
                        </Field>
                      </div>
                      <div className="addon-editor">
                        {line.addOns.map((selected) => {
                          const addOn = catalog.addOns.find((item) => item.id === selected.addOnId);
                          return (
                            <div key={selected.id}>
                              <span>{addOn?.name ?? '附加项已停用'}</span>
                              {(addOn?.pricingType === 'QUANTITY' ||
                                addOn?.pricingType === 'AREA') && (
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={selected.quantity ?? selected.area ?? ''}
                                  placeholder={
                                    addOn.pricingType === 'AREA' ? '默认计费面积' : '默认项目数量'
                                  }
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      addOns: line.addOns.map((item) =>
                                        item.id === selected.id
                                          ? {
                                              ...item,
                                              ...(addOn.pricingType === 'AREA'
                                                ? { area: e.target.value }
                                                : { quantity: e.target.value }),
                                            }
                                          : item,
                                      ),
                                    })
                                  }
                                />
                              )}
                              {addOn && (
                                <input
                                  type="number"
                                  min="0"
                                  step="any"
                                  value={selected.priceOverride ?? addOn.price}
                                  title="本次附加项单价"
                                  onChange={(e) =>
                                    updateLine(line.id, {
                                      addOns: line.addOns.map((item) =>
                                        item.id === selected.id
                                          ? { ...item, priceOverride: e.target.value }
                                          : item,
                                      ),
                                    })
                                  }
                                />
                              )}
                              <strong>
                                {money(
                                  calculated?.addOns.find((item) => item.id === selected.id)
                                    ?.amount,
                                )}
                              </strong>
                              <button
                                onClick={() =>
                                  updateLine(line.id, {
                                    addOns: line.addOns.filter((item) => item.id !== selected.id),
                                  })
                                }
                              >
                                ×
                              </button>
                            </div>
                          );
                        })}
                        <select
                          value=""
                          onChange={(e) =>
                            e.target.value &&
                            updateLine(line.id, {
                              addOns: [...line.addOns, createAddOn(e.target.value)],
                            })
                          }
                        >
                          <option value="">＋ 添加工艺/附加项</option>
                          {activeAddOns
                            .filter(
                              (item) =>
                                item.applicableProductIds.length === 0 ||
                                item.applicableProductIds.includes(product.id),
                            )
                            .map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.name}
                              </option>
                            ))}
                        </select>
                      </div>
                      {calculated && (
                        <div>
                          <div className="calculation-strip">
                            <span>
                              {calculated.actualArea
                                ? `实际面积 ${calculated.actualArea}㎡ · 计费面积 ${calculated.billableArea}㎡`
                                : `单价 ${money(calculated.unitPrice)}`}
                              {calculated.minimumApplied ? ' · 已应用最低收费' : ''}
                            </span>
                            <strong>{money(calculated.lineTotal)}</strong>
                          </div>
                          <details className="calculation-details">
                            <summary>展开计算过程</summary>
                            <p>
                              公式金额 {money(calculated.formulaAmount)}；损耗率{' '}
                              {calculated.lossRate}%；最低收费 {money(calculated.minimumCharge)}
                              ；计费基数 {money(calculated.baseAmount)}；附加项{' '}
                              {money(calculated.addOnTotal)}；项目合计 {money(calculated.lineTotal)}
                              。
                            </p>
                          </details>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
          </Card>

          <Card title="整单费用与条款">
            <div className="order-addon-list">
              {draft.orderAddOns.map((selected) => {
                const addOn = catalog.addOns.find((item) => item.id === selected.addOnId);
                return (
                  <div key={selected.id}>
                    <span>{addOn?.name ?? '附加项已停用'}</span>
                    {(addOn?.pricingType === 'QUANTITY' || addOn?.pricingType === 'AREA') && (
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={selected.quantity ?? selected.area ?? '1'}
                        title={addOn.pricingType === 'AREA' ? '面积' : '数量'}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            orderAddOns: draft.orderAddOns.map((item) =>
                              item.id === selected.id
                                ? {
                                    ...item,
                                    ...(addOn.pricingType === 'AREA'
                                      ? { area: event.target.value }
                                      : { quantity: event.target.value }),
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    )}
                    {addOn && (
                      <input
                        type="number"
                        min="0"
                        step="any"
                        value={selected.priceOverride ?? addOn.price}
                        title="本次附加项单价"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            orderAddOns: draft.orderAddOns.map((item) =>
                              item.id === selected.id
                                ? { ...item, priceOverride: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    )}
                    <strong>
                      {money(
                        calculation?.orderAddOns.find((item) => item.id === selected.id)?.amount,
                      )}
                    </strong>
                    <button
                      onClick={() =>
                        setDraft({
                          ...draft,
                          orderAddOns: draft.orderAddOns.filter((item) => item.id !== selected.id),
                        })
                      }
                    >
                      ×
                    </button>
                  </div>
                );
              })}
              <select
                value=""
                onChange={(e) =>
                  e.target.value &&
                  setDraft({
                    ...draft,
                    orderAddOns: [...draft.orderAddOns, createAddOn(e.target.value)],
                  })
                }
              >
                <option value="">＋ 添加整单费用</option>
                {activeAddOns.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-grid">
              <Field label="优惠方式">
                <select
                  value={draft.discountType}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      discountType: e.target.value as QuoteDraftData['discountType'],
                      discountValue: '0',
                    })
                  }
                >
                  <option value="NONE">无优惠</option>
                  <option value="FIXED">固定优惠金额</option>
                  <option value="PERCENT">折扣比例</option>
                </select>
              </Field>
              <Field label={draft.discountType === 'PERCENT' ? '优惠比例（%）' : '优惠金额（元）'}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  disabled={draft.discountType === 'NONE'}
                  value={draft.discountValue}
                  onChange={(e) => setDraft({ ...draft, discountValue: e.target.value })}
                />
              </Field>
              <Field label="手工调整（可正可负）">
                <input
                  type="number"
                  step="0.01"
                  value={draft.manualAdjustment}
                  onChange={(e) => setDraft({ ...draft, manualAdjustment: e.target.value })}
                />
              </Field>
              <Field label="调整原因">
                <input
                  disabled={draft.manualAdjustment === '0' || !draft.manualAdjustment}
                  value={draft.adjustmentReason}
                  onChange={(e) => setDraft({ ...draft, adjustmentReason: e.target.value })}
                />
              </Field>
              <Field label="税务模式">
                <select
                  value={draft.taxMode}
                  onChange={(e) =>
                    setDraft({ ...draft, taxMode: e.target.value as QuoteDraftData['taxMode'] })
                  }
                >
                  <option value="NONE">不计税</option>
                  <option value="INCLUDED">单价含税</option>
                  <option value="EXTRA">税费另计</option>
                </select>
              </Field>
              <Field label="税率（%）">
                <input
                  type="number"
                  min="0"
                  max="100"
                  step="0.01"
                  disabled={draft.taxMode === 'NONE'}
                  value={draft.taxRate}
                  onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })}
                />
              </Field>
              <Field label="总价取整">
                <select
                  value={draft.roundingMode}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      roundingMode: e.target.value as QuoteDraftData['roundingMode'],
                    })
                  }
                >
                  <option value="CENT">到分</option>
                  <option value="JIAO">到角</option>
                  <option value="YUAN">到元</option>
                </select>
              </Field>
              <Field label="有效至">
                <input
                  type="date"
                  value={draft.validUntil}
                  onChange={(e) => setDraft({ ...draft, validUntil: e.target.value })}
                />
              </Field>
              <Field label="交付周期" className="span-2">
                <input
                  value={draft.deliveryPeriod}
                  onChange={(e) => setDraft({ ...draft, deliveryPeriod: e.target.value })}
                />
              </Field>
              <Field label="客户可见备注" className="span-2">
                <textarea
                  value={draft.notes}
                  onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
                />
              </Field>
              <Field label="报价条款" className="span-2">
                <textarea
                  value={draft.terms}
                  onChange={(e) => setDraft({ ...draft, terms: e.target.value })}
                />
              </Field>
            </div>
          </Card>
        </div>

        <aside className="quote-preview-sidebar">
          <Card title="金额预览">
            {calculating && <div className="muted">正在重算…</div>}
            {!calculation ? (
              <p className="muted">添加项目并填写有效参数后显示。</p>
            ) : (
              <div className="summary-lines">
                <div>
                  <span>项目与附加费用</span>
                  <strong>{money(calculation.subtotal)}</strong>
                </div>
                {calculation.discountAmount !== '0.00' && (
                  <div>
                    <span>优惠</span>
                    <strong>-{money(calculation.discountAmount)}</strong>
                  </div>
                )}
                {calculation.manualAdjustment !== '0.00' && (
                  <div>
                    <span>手工调整</span>
                    <strong>{money(calculation.manualAdjustment)}</strong>
                  </div>
                )}
                {calculation.taxMode !== 'NONE' && (
                  <div>
                    <span>{calculation.taxMode === 'EXTRA' ? '另计税费' : '其中税额'}</span>
                    <strong>{money(calculation.taxAmount)}</strong>
                  </div>
                )}
                {calculation.roundingAdjustment !== '0.00' && (
                  <div>
                    <span>取整调整</span>
                    <strong>{money(calculation.roundingAdjustment)}</strong>
                  </div>
                )}
                <div className="summary-total">
                  <span>报价总额</span>
                  <strong>{money(calculation.total)}</strong>
                </div>
              </div>
            )}
            {calculation?.warnings.map((warning) => (
              <div
                className={`calculation-warning warning-${warning.code.toLowerCase()}`}
                key={`${warning.code}-${warning.lineId}`}
              >
                {warning.message}
              </div>
            ))}
            <div className="preview-note">发布时服务器会再次按相同规则重算并冻结版本。</div>
          </Card>
        </aside>
      </div>
      {previewing && calculation && (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={() => setPreviewing(false)}
        >
          <section
            className="modal customer-preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label="客户视角预览"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h2>客户视角预览</h2>
              <button aria-label="关闭预览" onClick={() => setPreviewing(false)}>
                ×
              </button>
            </div>
            <article className="public-quote preview-document">
              <header className="public-header">
                {merchant.logoUrl && <img src={merchant.logoUrl} alt="商家 Logo" />}
                <div>
                  <span>报价单 · 发布前预览</span>
                  <h1>{merchant.name}</h1>
                </div>
              </header>
              <section className="public-meta">
                <div>
                  <span>报价编号</span>
                  <strong>{quoteNumber || '发布后生成'}</strong>
                </div>
                <div>
                  <span>版本</span>
                  <strong>V{draftVersion} · 待发布</strong>
                </div>
                <div>
                  <span>客户</span>
                  <strong>{draft.customerName}</strong>
                </div>
                <div>
                  <span>有效至</span>
                  <strong>{draft.validUntil} 23:59</strong>
                </div>
                {draft.projectName && (
                  <div className="wide">
                    <span>项目</span>
                    <strong>{draft.projectName}</strong>
                  </div>
                )}
                {draft.deliveryPeriod && (
                  <div className="wide">
                    <span>交付周期</span>
                    <strong>{draft.deliveryPeriod}</strong>
                  </div>
                )}
              </section>
              <section className="public-lines">
                <h2>报价明细</h2>
                {calculation.lines.map((line, index) => (
                  <div className="public-line" key={line.id}>
                    <div className="public-line-title">
                      <strong>
                        {index + 1}. {line.name}
                      </strong>
                      <strong>{money(line.lineTotal)}</strong>
                    </div>
                    <p>
                      数量 {line.quantity} {line.unit}
                      {line.billableArea ? ` · 计费面积 ${line.billableArea}㎡` : ''} · 单价{' '}
                      {money(line.unitPrice)}
                    </p>
                    {line.description && <p>{line.description}</p>}
                    {line.minimumApplied && (
                      <small>已应用最低收费 {money(line.minimumCharge)}</small>
                    )}
                    {line.addOns.map((item) => (
                      <div className="public-addon" key={item.id}>
                        <span>＋ {item.name}</span>
                        <span>{money(item.amount)}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {calculation.orderAddOns.map((item) => (
                  <div className="public-addon order" key={item.id}>
                    <span>{item.name}</span>
                    <span>{money(item.amount)}</span>
                  </div>
                ))}
              </section>
              <section className="public-summary">
                <div>
                  <span>小计</span>
                  <strong>{money(calculation.subtotal)}</strong>
                </div>
                {calculation.discountAmount !== '0.00' && (
                  <div>
                    <span>优惠</span>
                    <strong>-{money(calculation.discountAmount)}</strong>
                  </div>
                )}
                {calculation.manualAdjustment !== '0.00' && (
                  <div>
                    <span>调整</span>
                    <strong>{money(calculation.manualAdjustment)}</strong>
                  </div>
                )}
                {calculation.taxMode !== 'NONE' && (
                  <div>
                    <span>
                      {calculation.taxMode === 'EXTRA' ? '另计税费' : '其中税额'}（
                      {calculation.taxRate}%）
                    </span>
                    <strong>{money(calculation.taxAmount)}</strong>
                  </div>
                )}
                {calculation.roundingAdjustment !== '0.00' && (
                  <div>
                    <span>取整调整</span>
                    <strong>{money(calculation.roundingAdjustment)}</strong>
                  </div>
                )}
                <div className="public-total">
                  <span>报价总额</span>
                  <strong>{money(calculation.total)}</strong>
                </div>
              </section>
              {(draft.notes || draft.terms) && (
                <section className="public-terms">
                  {draft.notes && (
                    <>
                      <h2>备注</h2>
                      <p>{draft.notes}</p>
                    </>
                  )}
                  {draft.terms && (
                    <>
                      <h2>报价条款</h2>
                      <p>{draft.terms}</p>
                    </>
                  )}
                </section>
              )}
              <footer className="public-contact">
                <strong>{merchant.contactName || merchant.name}</strong>
                <span>
                  {[
                    merchant.contactPhone,
                    merchant.contactWechat ? `微信 ${merchant.contactWechat}` : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <small>接受报价用于确认当前版本的价格与范围，不等同于付款或电子合同。</small>
              </footer>
            </article>
            <div className="modal-actions">
              <Button variant="secondary" onClick={() => setPreviewing(false)}>
                返回修改
              </Button>
              <Button disabled={saving || publishing} onClick={() => void publish()}>
                确认发布
              </Button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
