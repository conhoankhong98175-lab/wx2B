import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api.ts';
import { Button, Card, EmptyState, ErrorNotice, Loading, StatusPill } from '../components.tsx';
import { STATE_LABELS, money, shortDate } from '../format.ts';
import { useAsyncData } from '../hooks.ts';
import type { QuoteListItem } from '../types.ts';

export function QuotesPage() {
  const [query, setQuery] = useState('');
  const [state, setState] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const quotes = useAsyncData(
    () =>
      api<{ items: QuoteListItem[] }>(
        `/quotes?q=${encodeURIComponent(query)}&state=${encodeURIComponent(state)}&dateFrom=${dateFrom}&dateTo=${dateTo}`,
      ),
    `${query}|${state}|${dateFrom}|${dateTo}`,
  );

  return (
    <>
      <div className="page-heading heading-with-action">
        <div>
          <span className="eyebrow">每一版都有据可查</span>
          <h1>报价</h1>
          <p>搜索客户和报价编号，继续草稿、跟进状态或快速复制历史报价。</p>
        </div>
        <Link to="/quotes/new">
          <Button>＋ 新建报价</Button>
        </Link>
      </div>
      {quotes.error && <ErrorNotice message={quotes.error} />}
      <Card>
        <div className="toolbar quote-filters">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索编号、客户或项目"
          />
          <select value={state} onChange={(event) => setState(event.target.value)}>
            <option value="">全部状态</option>
            {Object.entries(STATE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label>
            <span className="sr-only">开始日期</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label>
            <span className="sr-only">结束日期</span>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
        </div>
        {quotes.loading ? (
          <Loading />
        ) : (quotes.data?.items.length ?? 0) === 0 ? (
          <EmptyState
            title={query || state || dateFrom || dateTo ? '没有匹配的报价' : '还没有报价'}
            text={
              query || state || dateFrom || dateTo
                ? '换一个关键词或状态试试。'
                : '创建第一份报价，客户打开后的动作会自动回到这里。'
            }
            action={
              !query && !state && !dateFrom && !dateTo ? (
                <Link to="/quotes/new">
                  <Button>创建报价</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <div className="quote-card-list">
            {quotes.data?.items.map((item) => (
              <Link
                key={item.id}
                to={item.hasDraft ? `/quotes/${item.id}/edit` : `/quotes/${item.id}`}
              >
                <div className="quote-card-main">
                  <div className="quote-number">
                    {item.quoteNumber}
                    {item.currentVersion ? ` · V${item.currentVersion}` : ''}
                  </div>
                  <h3>{item.customerName}</h3>
                  <p>{item.projectName || '未填写项目名称'}</p>
                </div>
                <div className="quote-card-meta">
                  <strong>{money(item.total)}</strong>
                  <span>有效至 {shortDate(item.validUntil)}</span>
                </div>
                <div className="quote-card-state">
                  <StatusPill
                    state={item.hasDraft ? 'DRAFT' : item.state}
                    label={
                      item.hasDraft ? `V${item.draftVersion ?? ''} 草稿` : STATE_LABELS[item.state]
                    }
                  />
                  {item.viewed && <small>客户已查看</small>}
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </>
  );
}
