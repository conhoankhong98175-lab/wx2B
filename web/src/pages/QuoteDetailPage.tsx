import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api } from '../api.ts';
import { Button, Card, ErrorNotice, Loading, StatusPill } from '../components.tsx';
import { STATE_LABELS, money, shortDate } from '../format.ts';
import { useAsyncData } from '../hooks.ts';
import type { QuoteDetail } from '../types.ts';

export function QuoteDetailPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const quote = useAsyncData(() => api<QuoteDetail>(`/quotes/${id}`), id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [copied, setCopied] = useState('');

  if (quote.loading) return <Loading />;
  if (!quote.data) return <ErrorNotice message={quote.error || '报价不存在'} />;
  const current =
    quote.data.versions.find((item) => item.version === quote.data?.currentVersion) ??
    quote.data.versions[0];

  const newVersion = async () => {
    setBusy('version');
    setError('');
    try {
      await api(`/quotes/${id}/new-version`, { method: 'POST' });
      void navigate(`/quotes/${id}/edit`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建新版本');
    } finally {
      setBusy('');
    }
  };

  const copyQuote = async () => {
    setBusy('copy');
    setError('');
    try {
      const keepCustomer = window.confirm('是否保留当前客户名称和联系方式？');
      const result = await api<{ id: string }>(`/quotes/${id}/copy`, {
        method: 'POST',
        body: JSON.stringify({ keepCustomer }),
      });
      void navigate(`/quotes/${result.id}/edit`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '复制失败');
    } finally {
      setBusy('');
    }
  };

  const withdraw = async (version: number) => {
    if (!window.confirm(`确认撤回 V${version}？客户原链接将立即隐藏价格明细。`)) return;
    setBusy(`withdraw-${version}`);
    setError('');
    try {
      await api(`/quotes/${id}/versions/${version}/withdraw`, { method: 'POST' });
      await quote.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '撤回失败');
    } finally {
      setBusy('');
    }
  };

  const copyShare = async (url: string, version: number) => {
    await navigator.clipboard.writeText(url);
    setCopied(`V${version}`);
    window.setTimeout(() => setCopied(''), 1800);
  };

  return (
    <>
      <div className="page-heading heading-with-action">
        <div>
          <Link className="back-link" to="/quotes">
            ← 返回报价列表
          </Link>
          <h1>{quote.data.customerName}</h1>
          <p>
            {quote.data.quoteNumber} · {quote.data.projectName || '未填写项目名称'}
          </p>
        </div>
        <div className="button-row">
          <Button variant="secondary" disabled={!!busy} onClick={() => void copyQuote()}>
            {busy === 'copy' ? '复制中…' : '复制为新报价'}
          </Button>
          <Button disabled={!!busy || !!quote.data.draft} onClick={() => void newVersion()}>
            {busy === 'version' ? '创建中…' : '复制为新版本'}
          </Button>
        </div>
      </div>
      {(error || quote.error) && <ErrorNotice message={error || quote.error} />}
      {!quote.data.sharingAvailable && (
        <div className="notice notice-info">
          当前为 Windows 本地模式：数据只保存在本机，可下载
          PDF；客户链接、客户动作和微信小程序同步仅在部署公网服务后可用。
        </div>
      )}
      {quote.data.draft && (
        <div className="notice notice-info">
          V{quote.data.draftVersion} 草稿尚未发布。<Link to={`/quotes/${id}/edit`}>继续编辑 →</Link>
        </div>
      )}
      {current && (
        <div className="metric-grid detail-metrics">
          <Card className="metric-card accent">
            <span>当前版本</span>
            <strong>V{current.version}</strong>
            <small>
              <StatusPill state={current.state} label={STATE_LABELS[current.state]} />
            </small>
          </Card>
          <Card className="metric-card">
            <span>报价总额</span>
            <strong>{money(current.calculation.total)}</strong>
            <small>有效至 {shortDate(current.validUntil)}</small>
          </Card>
          <Card className="metric-card">
            <span>客户查看</span>
            <strong>{current.viewCount}</strong>
            <small>
              {current.firstViewedAt
                ? `首次 ${new Date(current.firstViewedAt).toLocaleString('zh-CN')}`
                : '尚未打开'}
            </small>
          </Card>
          <Card className="metric-card success">
            <span>客户确认</span>
            <strong>{current.acceptedAt ? '已接受' : '等待中'}</strong>
            <small>
              {current.acceptedAt
                ? new Date(current.acceptedAt).toLocaleString('zh-CN')
                : '以具体版本为准'}
            </small>
          </Card>
        </div>
      )}

      <Card title="版本记录">
        <div className="version-list">
          {quote.data.versions.map((version) => (
            <article key={version.id} className="version-card">
              <div className="version-title">
                <div>
                  <strong>V{version.version}</strong>
                  <StatusPill state={version.state} label={STATE_LABELS[version.state]} />
                </div>
                <strong>{money(version.calculation.total)}</strong>
              </div>
              <div className="version-meta">
                <span>发布于 {new Date(version.publishedAt).toLocaleString('zh-CN')}</span>
                <span>有效至 {version.validUntil}</span>
                <span>
                  {version.firstViewedAt ? `客户查看 ${version.viewCount} 次` : '客户未查看'}
                </span>
              </div>
              <div className="version-lines">
                {version.calculation.lines.map((line) => (
                  <div key={line.id}>
                    <span>
                      {line.name} × {line.quantity}
                    </span>
                    <strong>{money(line.lineTotal)}</strong>
                  </div>
                ))}
              </div>
              {version.actions.some((action) => action.type !== 'VIEW') && (
                <div className="action-timeline">
                  <strong>客户动态</strong>
                  {version.actions
                    .filter((action) => action.type !== 'VIEW')
                    .map((action) => (
                      <div key={action.id}>
                        <span>
                          {action.type === 'ACCEPT'
                            ? '接受报价'
                            : action.type === 'QUESTION'
                              ? '客户问题'
                              : '申请修改'}
                        </span>
                        {action.message && <p>{action.message}</p>}
                        <small>{new Date(action.createdAt).toLocaleString('zh-CN')}</small>
                      </div>
                    ))}
                </div>
              )}
              <div className="version-actions">
                {version.shareUrl && (
                  <Button
                    variant="secondary"
                    onClick={() => void copyShare(version.shareUrl!, version.version)}
                    disabled={version.state === 'WITHDRAWN'}
                  >
                    {copied === `V${version.version}` ? '已复制链接' : '复制客户链接'}
                  </Button>
                )}
                <a
                  className="button button-secondary"
                  href={`/api/documents/${id}/versions/${version.version}/pdf`}
                  onClick={(event) => {
                    event.preventDefault();
                    void fetch(`/api/documents/${id}/versions/${version.version}/pdf`, {
                      headers: {
                        authorization: `Bearer ${localStorage.getItem('diangao_access_token') ?? ''}`,
                      },
                    })
                      .then(async (response) => {
                        if (!response.ok) throw new Error('PDF 生成失败');
                        const blob = await response.blob();
                        const url = URL.createObjectURL(blob);
                        const anchor = document.createElement('a');
                        anchor.href = url;
                        anchor.download = `${quote.data?.quoteNumber}-V${version.version}.pdf`;
                        anchor.click();
                        URL.revokeObjectURL(url);
                      })
                      .catch((reason: unknown) =>
                        setError(reason instanceof Error ? reason.message : 'PDF 下载失败'),
                      );
                  }}
                >
                  下载 PDF
                </a>
                {(version.state === 'ACTIVE' || version.state === 'CHANGE_REQUESTED') && (
                  <Button
                    variant="danger"
                    disabled={!!busy}
                    onClick={() => void withdraw(version.version)}
                  >
                    {busy === `withdraw-${version.version}` ? '撤回中…' : '撤回'}
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      </Card>
    </>
  );
}
