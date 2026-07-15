import { Link } from 'react-router-dom';

import { api } from '../api.ts';
import { Button, Card, EmptyState, ErrorNotice, Loading, StatusPill } from '../components.tsx';
import { STATE_LABELS, money, shortDate } from '../format.ts';
import { useAsyncData } from '../hooks.ts';
import type { NotificationItem, QuoteListItem } from '../types.ts';

export function HomePage() {
  const quotes = useAsyncData(() => api<{ items: QuoteListItem[] }>('/quotes'));
  const notifications = useAsyncData(() =>
    api<{ items: NotificationItem[] }>('/quotes/notifications/list'),
  );
  const resolveNotification = async (notificationId: string) => {
    await api(`/quotes/notifications/${notificationId}/resolve`, { method: 'POST' });
    await notifications.reload();
  };

  if (quotes.loading) return <Loading />;
  const items = quotes.data?.items ?? [];
  const active = items.filter(
    (item) => item.state === 'ACTIVE' || item.state === 'CHANGE_REQUESTED',
  );
  const accepted = items.filter((item) => item.state === 'ACCEPTED');
  const viewed = items.filter((item) => item.viewed);

  return (
    <>
      <div className="page-heading heading-with-action">
        <div>
          <span className="eyebrow">今天从快速回复开始</span>
          <h1>报价工作台</h1>
          <p>用自己的价格规则算清、发出，并确认客户接受的是哪一版。</p>
        </div>
        <Link to="/quotes/new">
          <Button className="large-action">＋ 新建报价</Button>
        </Link>
      </div>
      {quotes.error && <ErrorNotice message={quotes.error} />}

      <div className="metric-grid">
        <Card className="metric-card">
          <span>全部报价</span>
          <strong>{items.length}</strong>
          <small>含草稿和历史版本</small>
        </Card>
        <Card className="metric-card accent">
          <span>待客户反馈</span>
          <strong>{active.length}</strong>
          <small>需要继续跟进</small>
        </Card>
        <Card className="metric-card">
          <span>客户已查看</span>
          <strong>{viewed.length}</strong>
          <small>真实打开过报价页</small>
        </Card>
        <Card className="metric-card success">
          <span>客户已接受</span>
          <strong>{accepted.length}</strong>
          <small>已确认具体版本</small>
        </Card>
      </div>

      <div className="two-column">
        <Card
          title="最近报价"
          action={
            <Link className="text-link" to="/quotes">
              查看全部 →
            </Link>
          }
        >
          {items.length === 0 ? (
            <EmptyState
              title="还没有报价"
              text="先用演示价格库完成第一份报价，再逐步替换成你的真实价格。"
              action={
                <Link to="/quotes/new">
                  <Button>创建第一份报价</Button>
                </Link>
              }
            />
          ) : (
            <div className="compact-list">
              {items.slice(0, 6).map((item) => (
                <Link
                  key={item.id}
                  to={item.hasDraft ? `/quotes/${item.id}/edit` : `/quotes/${item.id}`}
                >
                  <div>
                    <strong>{item.customerName}</strong>
                    <span>{item.projectName || item.quoteNumber}</span>
                  </div>
                  <div className="list-value">
                    <strong>{money(item.total)}</strong>
                    <span>{shortDate(item.updatedAt)}</span>
                  </div>
                  <StatusPill state={item.state} label={STATE_LABELS[item.state]} />
                </Link>
              ))}
            </div>
          )}
        </Card>

        <Card title="客户动态">
          {notifications.loading ? (
            <Loading />
          ) : (notifications.data?.items.length ?? 0) === 0 ? (
            <EmptyState title="暂无客户动态" text="客户查看、接受或申请修改后会显示在这里。" />
          ) : (
            <div className="timeline-list">
              {notifications.data?.items
                .filter((item) => !item.resolvedAt)
                .slice(0, 8)
                .map((item) => (
                  <div className="timeline-item" key={item.id}>
                    <span className={`timeline-dot type-${item.type.toLowerCase()}`} />
                    <Link to={`/quotes/${item.quoteId}`}>
                      <strong>{item.title}</strong>
                      <p>{item.body}</p>
                      <small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small>
                    </Link>
                    <Button variant="ghost" onClick={() => void resolveNotification(item.id)}>
                      完成
                    </Button>
                  </div>
                ))}
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
