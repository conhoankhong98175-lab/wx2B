import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

import { ApiError, publicApi, requestId } from '../api.ts';
import { Button, ErrorNotice, Loading, StatusPill } from '../components.tsx';
import { STATE_LABELS, money } from '../format.ts';
import { downloadQuoteImage } from '../long-image.ts';
import type { PublicQuoteResponse } from '../types.ts';

const ANONYMOUS_KEY = 'quote_anonymous_id';

function anonymousId(): string {
  const existing = localStorage.getItem(ANONYMOUS_KEY);
  if (existing) return existing;
  const value = crypto.randomUUID();
  localStorage.setItem(ANONYMOUS_KEY, value);
  return value;
}

export function PublicQuotePage() {
  const { token = '' } = useParams();
  const [data, setData] = useState<PublicQuoteResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await publicApi<PublicQuoteResponse>(`/quotes/${encodeURIComponent(token)}`);
      setData(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '报价链接无效');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!data?.available || !data.quote) return;
    const key = `quote_view_request_${data.quote.quoteNumber}_v${data.quote.version}`;
    let viewRequest = sessionStorage.getItem(key);
    if (!viewRequest) {
      viewRequest = requestId('view');
      sessionStorage.setItem(key, viewRequest);
    }
    void publicApi(`/quotes/${encodeURIComponent(token)}/actions`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'VIEW',
        requestId: viewRequest,
        anonymousId: anonymousId(),
        message: '',
      }),
    }).catch(() => undefined);
  }, [data, token]);

  if (loading) return <Loading label="正在打开报价…" />;
  if (error || !data)
    return (
      <main className="public-error">
        <ErrorNotice message={error || '报价不存在'} />
      </main>
    );
  if (!data.available || !data.quote) {
    return (
      <main className="public-error">
        <div className="public-merchant">{data.merchant?.name ?? '报价单'}</div>
        <h1>{data.message ?? '报价当前不可查看'}</h1>
        <p>
          {data.quoteNumber} {data.version ? `· V${data.version}` : ''}
        </p>
        {data.merchant?.contactPhone && (
          <a href={`tel:${data.merchant.contactPhone}`}>联系商家：{data.merchant.contactPhone}</a>
        )}
      </main>
    );
  }
  const quote = data.quote;
  const canAct = quote.state === 'ACTIVE';
  const stateMessage: Partial<Record<typeof quote.state, string>> = {
    ACCEPTED: '当前版本已被接受，若价格或范围发生变化，需要重新确认新版本。',
    EXPIRED: '此报价已超过有效期，不能接受或申请修改，请联系商家重新报价。',
    SUPERSEDED: '此报价已有新版本，当前版本不能继续操作，请联系商家获取最新链接。',
    CHANGE_REQUESTED: '修改申请已提交，正在等待商家发布新版本。',
  };

  const action = async (type: 'ACCEPT' | 'QUESTION' | 'CHANGE_REQUEST') => {
    let message = '';
    if (
      type === 'ACCEPT' &&
      !window.confirm(
        `确认接受 ${quote.quoteNumber} V${quote.version} 的报价内容？\n\n此操作用于确认当前价格与服务范围，不等同于付款或电子合同。`,
      )
    )
      return;
    if (type === 'QUESTION') message = window.prompt('请填写你的问题：')?.trim() ?? '';
    if (type === 'CHANGE_REQUEST') message = window.prompt('请说明需要修改的内容：')?.trim() ?? '';
    if ((type === 'QUESTION' || type === 'CHANGE_REQUEST') && !message) return;
    setBusy(type);
    setError('');
    try {
      await publicApi(`/quotes/${encodeURIComponent(token)}/actions`, {
        method: 'POST',
        body: JSON.stringify({
          type,
          requestId: requestId(type.toLowerCase()),
          anonymousId: anonymousId(),
          message,
        }),
      });
      setDone(
        type === 'ACCEPT'
          ? '已接受当前报价版本'
          : type === 'QUESTION'
            ? '问题已发送给商家'
            : '修改申请已发送给商家',
      );
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '提交失败，请稍后重试');
    } finally {
      setBusy('');
    }
  };

  const downloadPdf = async () => {
    setBusy('PDF');
    try {
      const response = await fetch(`/api/public/documents/${encodeURIComponent(token)}/pdf`);
      if (!response.ok) throw new Error('PDF 生成失败');
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${quote.quoteNumber}-V${quote.version}.pdf`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'PDF 下载失败');
    } finally {
      setBusy('');
    }
  };

  const downloadImages = async () => {
    setBusy('IMAGE');
    setError('');
    try {
      await downloadQuoteImage(quote);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '长图生成失败');
    } finally {
      setBusy('');
    }
  };

  return (
    <main className="public-page">
      <article className="public-quote">
        <header className="public-header">
          {quote.merchant.logoUrl && <img src={quote.merchant.logoUrl} alt="商家 Logo" />}
          <div>
            <span>报价单</span>
            <h1>{quote.merchant.name}</h1>
          </div>
          <StatusPill state={quote.state} label={STATE_LABELS[quote.state]} />
        </header>
        {stateMessage[quote.state] && (
          <div className={`public-state-banner state-${quote.state.toLowerCase()}`}>
            {stateMessage[quote.state]}
          </div>
        )}
        <section className="public-meta">
          <div>
            <span>报价编号</span>
            <strong>{quote.quoteNumber}</strong>
          </div>
          <div>
            <span>版本</span>
            <strong>V{quote.version}</strong>
          </div>
          <div>
            <span>客户</span>
            <strong>{quote.customerName}</strong>
          </div>
          <div>
            <span>有效至</span>
            <strong>{quote.validUntil} 23:59</strong>
          </div>
          {quote.projectName && (
            <div className="wide">
              <span>项目</span>
              <strong>{quote.projectName}</strong>
            </div>
          )}
          {quote.deliveryPeriod && (
            <div className="wide">
              <span>交付周期</span>
              <strong>{quote.deliveryPeriod}</strong>
            </div>
          )}
        </section>
        <section className="public-lines">
          <h2>报价明细</h2>
          {quote.calculation.lines.map((line, index) => (
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
              {line.minimumApplied && <small>已应用最低收费 {money(line.minimumCharge)}</small>}
              {line.addOns.map((item) => (
                <div className="public-addon" key={item.id}>
                  <span>＋ {item.name}</span>
                  <span>{money(item.amount)}</span>
                </div>
              ))}
            </div>
          ))}
          {quote.calculation.orderAddOns.map((item) => (
            <div className="public-addon order" key={item.id}>
              <span>{item.name}</span>
              <span>{money(item.amount)}</span>
            </div>
          ))}
        </section>
        <section className="public-summary">
          <div>
            <span>小计</span>
            <strong>{money(quote.calculation.subtotal)}</strong>
          </div>
          {quote.calculation.discountAmount !== '0.00' && (
            <div>
              <span>优惠</span>
              <strong>-{money(quote.calculation.discountAmount)}</strong>
            </div>
          )}
          {quote.calculation.manualAdjustment !== '0.00' && (
            <div>
              <span>调整</span>
              <strong>{money(quote.calculation.manualAdjustment)}</strong>
            </div>
          )}
          {quote.calculation.taxMode !== 'NONE' && (
            <div>
              <span>
                {quote.calculation.taxMode === 'EXTRA' ? '另计税费' : '其中税额'}（
                {quote.calculation.taxRate}%）
              </span>
              <strong>{money(quote.calculation.taxAmount)}</strong>
            </div>
          )}
          {quote.calculation.roundingAdjustment !== '0.00' && (
            <div>
              <span>取整调整</span>
              <strong>{money(quote.calculation.roundingAdjustment)}</strong>
            </div>
          )}
          <div className="public-total">
            <span>报价总额</span>
            <strong>{money(quote.calculation.total)}</strong>
          </div>
        </section>
        {(quote.notes || quote.terms) && (
          <section className="public-terms">
            {quote.notes && (
              <>
                <h2>备注</h2>
                <p>{quote.notes}</p>
              </>
            )}
            {quote.terms && (
              <>
                <h2>报价条款</h2>
                <p>{quote.terms}</p>
              </>
            )}
          </section>
        )}
        <footer className="public-contact">
          <strong>{quote.merchant.contactName || quote.merchant.name}</strong>
          <span>
            {[
              quote.merchant.contactPhone,
              quote.merchant.contactWechat ? `微信 ${quote.merchant.contactWechat}` : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <small>接受报价用于确认当前版本的价格与范围，不等同于付款或电子合同。</small>
        </footer>
      </article>
      {(error || done) && (
        <div className={`public-toast ${error ? 'error' : ''}`}>{error || done}</div>
      )}
      <div className="public-export-row">
        <Button variant="secondary" disabled={!!busy} onClick={() => void downloadPdf()}>
          {busy === 'PDF' ? '生成中…' : '下载 PDF'}
        </Button>
        <Button variant="secondary" disabled={!!busy} onClick={() => void downloadImages()}>
          {busy === 'IMAGE' ? '分页生成中…' : '保存分页长图'}
        </Button>
      </div>
      <div className="public-actions">
        <Button
          variant="secondary"
          disabled={!!busy || quote.state === 'WITHDRAWN'}
          onClick={() => void action('QUESTION')}
        >
          有问题
        </Button>
        <Button
          title={!canAct ? (stateMessage[quote.state] ?? '当前状态不能申请修改') : ''}
          variant="secondary"
          disabled={!!busy || !canAct}
          onClick={() => void action('CHANGE_REQUEST')}
        >
          申请修改
        </Button>
        <Button
          title={!canAct ? (stateMessage[quote.state] ?? '当前状态不能接受报价') : ''}
          disabled={!!busy || !canAct}
          onClick={() => void action('ACCEPT')}
        >
          {quote.state === 'ACCEPTED' ? '已接受' : '接受报价'}
        </Button>
      </div>
    </main>
  );
}
