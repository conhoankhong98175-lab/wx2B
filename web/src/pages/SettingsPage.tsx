import { useEffect, useState } from 'react';

import type { RoundingMode } from '../../../shared/contracts.ts';
import { api, clearToken } from '../api.ts';
import { Button, Card, ErrorNotice, Field, Loading } from '../components.tsx';
import { useAsyncData } from '../hooks.ts';
import type { Merchant } from '../types.ts';

export function SettingsPage() {
  const merchant = useAsyncData(() => api<Merchant>('/merchant'));
  const [form, setForm] = useState<Merchant | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (merchant.data) setForm(merchant.data);
  }, [merchant.data]);

  if (merchant.loading || !form) return <Loading />;

  const save = async () => {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await api('/merchant', {
        method: 'PUT',
        body: JSON.stringify({
          name: form.name,
          logoUrl: form.logoUrl,
          contactName: form.contactName,
          contactPhone: form.contactPhone,
          contactWechat: form.contactWechat,
          defaultValidDays: form.defaultValidDays,
          defaultDeliveryPeriod: form.defaultDeliveryPeriod,
          defaultTerms: form.defaultTerms,
          roundingMode: form.roundingMode,
          onboardingCompleted: true,
        }),
      });
      setMessage('店铺资料已保存。新设置只用于之后创建的报价。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const exportData = async () => {
    try {
      const data = await api<unknown>('/merchant/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `店铺数据-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '导出失败');
    }
  };

  const deleteAccount = async () => {
    const confirmation = window.prompt(
      `此操作会永久删除价格库、报价、客户动作和全部链接。\n请输入完整店铺名称“${form.name}”确认：`,
    );
    if (confirmation !== form.name) return;
    try {
      await api('/merchant/account', {
        method: 'DELETE',
        body: JSON.stringify({ confirmation }),
      });
      clearToken();
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '删除失败');
    }
  };

  return (
    <>
      <div className="page-heading">
        <span className="eyebrow">你的品牌与默认条款</span>
        <h1>店铺设置</h1>
        <p>店铺名称和联系方式会进入客户报价页；历史正式版本不会被新设置覆盖。</p>
      </div>
      {(error || merchant.error) && <ErrorNotice message={error || merchant.error} />}
      {message && <div className="notice notice-success">{message}</div>}
      <div className="settings-layout">
        <Card title="公开资料">
          <div className="form-grid">
            <Field label="店铺名称 *" className="span-2">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="联系人">
              <input
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              />
            </Field>
            <Field label="联系电话">
              <input
                value={form.contactPhone}
                onChange={(e) => setForm({ ...form, contactPhone: e.target.value })}
              />
            </Field>
            <Field label="联系微信">
              <input
                value={form.contactWechat}
                onChange={(e) => setForm({ ...form, contactWechat: e.target.value })}
              />
            </Field>
            <Field
              label="Logo 地址"
              hint="支持公开 HTTPS 图片地址；客户页显示，PDF 以店铺名称作为稳定品牌标识。"
            >
              <input
                value={form.logoUrl}
                onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
                placeholder="https://…"
              />
            </Field>
          </div>
        </Card>
        <Card title="报价默认值">
          <div className="form-grid">
            <Field label="默认有效天数">
              <input
                type="number"
                min="1"
                max="365"
                value={form.defaultValidDays}
                onChange={(e) => setForm({ ...form, defaultValidDays: Number(e.target.value) })}
              />
            </Field>
            <Field label="总价取整">
              <select
                value={form.roundingMode}
                onChange={(e) => setForm({ ...form, roundingMode: e.target.value as RoundingMode })}
              >
                <option value="CENT">到分</option>
                <option value="JIAO">到角</option>
                <option value="YUAN">到元</option>
              </select>
            </Field>
            <Field label="默认交付周期" className="span-2">
              <input
                value={form.defaultDeliveryPeriod}
                onChange={(e) => setForm({ ...form, defaultDeliveryPeriod: e.target.value })}
              />
            </Field>
            <Field label="默认报价条款" className="span-2">
              <textarea
                rows={7}
                value={form.defaultTerms}
                onChange={(e) => setForm({ ...form, defaultTerms: e.target.value })}
              />
            </Field>
          </div>
        </Card>
      </div>
      <Card title="数据与安全" className="danger-zone">
        <p>可随时导出全部价格库、草稿、正式版本和客户动作。删除店铺后，所有客户链接立即失效。</p>
        <div className="button-row">
          <Button variant="secondary" onClick={() => void exportData()}>
            导出全部数据
          </Button>
          <Button variant="danger" onClick={() => void deleteAccount()}>
            永久删除店铺数据
          </Button>
        </div>
      </Card>
      <div className="sticky-actions">
        <Button disabled={saving || !form.name.trim()} onClick={() => void save()}>
          {saving ? '保存中…' : '保存设置'}
        </Button>
      </div>
    </>
  );
}
