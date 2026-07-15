import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Draft = { customerName: string; lines: Array<{ id: string }>; marker: string };

interface EditorPageHarness {
  calculateTimer?: ReturnType<typeof setTimeout>;
  data: {
    addOns: unknown[];
    draft: Draft;
    draftRevision: number;
    products: unknown[];
    quoteId: string;
    syncState: string;
  };
  draftGeneration: number;
  lastPersistResult: unknown;
  persist: () => Promise<unknown>;
  saveTimer?: ReturnType<typeof setTimeout>;
  setData: (values: Record<string, unknown>, callback?: () => void) => void;
  setDraft: (draft: Draft) => void;
  syncedGeneration: number;
}

function deferred<T>() {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

function createHarness() {
  const storage = new Map<string, unknown>();
  const requests: Array<{
    options: { data: Draft; header: Record<string, string> };
    path: string;
    response: ReturnType<typeof deferred<Record<string, unknown>>>;
  }> = [];
  const api = {
    request(path: string, options: { data: Draft; header: Record<string, string> }) {
      const response = deferred<Record<string, unknown>>();
      requests.push({ options, path, response });
      return response.promise;
    },
  };
  let definition: Record<string, unknown> | undefined;
  const sandbox = {
    Page(value: Record<string, unknown>) {
      definition = value;
    },
    clearTimeout,
    console,
    module: { exports: {} },
    Promise,
    require(path: string) {
      if (path === '../../utils/api') return api;
      if (path === '../../utils/format') return { datePlus: () => '2099-12-31' };
      if (path === '../../utils/pricing') {
        return { calculate: () => ({ lines: [], orderAddOns: [], total: '1.00' }) };
      }
      throw new Error(`Unexpected require: ${path}`);
    },
    setTimeout,
    wx: {
      getStorageSync(key: string) {
        return storage.get(key);
      },
      removeStorageSync(key: string) {
        storage.delete(key);
      },
      setStorageSync(key: string, value: unknown) {
        storage.set(key, structuredClone(value));
      },
    },
  };
  runInNewContext(readFileSync(resolve('miniprogram/pages/editor/index.js'), 'utf8'), sandbox);
  if (!definition) throw new Error('Editor page was not registered');

  const page = {
    ...definition,
    data: structuredClone(definition.data),
    setData(
      this: { data: Record<string, unknown> },
      values: Record<string, unknown>,
      callback?: () => void,
    ) {
      Object.assign(this.data, values);
      callback?.();
    },
  } as unknown as EditorPageHarness;
  page.data.quoteId = 'quote-1';
  page.data.draftRevision = 1;
  page.data.draft = { customerName: '客户', lines: [{ id: 'line-1' }], marker: 'A' };
  page.data.products = [];
  page.data.addOns = [];
  page.draftGeneration = 0;
  page.syncedGeneration = 0;
  page.lastPersistResult = null;

  return { page, requests, storage };
}

const serverResult = (draftRevision: number) => ({
  calculation: { lines: [], orderAddOns: [], total: `${draftRevision}.00` },
  calculationHash: `hash-${draftRevision}`,
  draftRevision,
});

describe('小程序草稿串行同步', () => {
  it('旧请求完成时保留新草稿，并继续用新 revision 同步', async () => {
    const { page, requests, storage } = createHarness();
    const draftB: Draft = { customerName: '客户', lines: [{ id: 'line-1' }], marker: 'B' };
    const draftC: Draft = { customerName: '客户', lines: [{ id: 'line-1' }], marker: 'C' };

    page.setDraft(draftB);
    clearTimeout(page.calculateTimer);
    clearTimeout(page.saveTimer);
    const firstFlush = page.persist();
    expect(requests).toHaveLength(1);

    page.setDraft(draftC);
    clearTimeout(page.calculateTimer);
    clearTimeout(page.saveTimer);
    const joinedFlush = page.persist();
    requests[0]!.response.resolve(serverResult(2));

    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(storage.get('diangao_draft_recovery_quote-1')).toEqual(draftC);
    expect(requests[0]!.options.header['If-Match']).toBe('1');
    expect(requests[0]!.options.data).toEqual(draftB);
    expect(requests[1]!.options.header['If-Match']).toBe('2');
    expect(requests[1]!.options.data).toEqual(draftC);

    requests[1]!.response.resolve(serverResult(3));
    await Promise.all([firstFlush, joinedFlush]);
    expect(storage.has('diangao_draft_recovery_quote-1')).toBe(false);
    expect(page.data.syncState).toBe('已同步');
    expect(page.data.draftRevision).toBe(3);
  });

  it('DRAFT_CHANGED 不清理本地 recovery，也不误报已同步', async () => {
    const { page, requests, storage } = createHarness();
    const draft: Draft = { customerName: '客户', lines: [{ id: 'line-1' }], marker: 'local' };
    page.setDraft(draft);
    clearTimeout(page.calculateTimer);
    clearTimeout(page.saveTimer);
    const flush = page.persist();
    const error = Object.assign(new Error('草稿已变更'), { code: 'DRAFT_CHANGED' });
    requests[0]!.response.reject(error);

    await expect(flush).rejects.toMatchObject({ code: 'DRAFT_CHANGED' });
    expect(storage.get('diangao_draft_recovery_quote-1')).toEqual(draft);
    expect(page.data.syncState).not.toBe('已同步');
  });
});
