import type { QuoteState } from '../../shared/contracts.ts';

export const STATE_LABELS: Record<QuoteState | 'DRAFT', string> = {
  DRAFT: '草稿',
  ACTIVE: '待客户反馈',
  CHANGE_REQUESTED: '申请修改',
  ACCEPTED: '已接受',
  EXPIRED: '已过期',
  WITHDRAWN: '已撤回',
  SUPERSEDED: '已被替代',
};

export function money(value: string | null | undefined): string {
  return value === null || value === undefined ? '—' : `￥${value}`;
}

export function shortDate(value: string | null | undefined): string {
  if (!value) return '—';
  return value.slice(0, 10);
}

export function todayPlus(days: number, referenceDate = new Date()): string {
  const date = new Date(referenceDate);
  date.setDate(date.getDate() + days);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
