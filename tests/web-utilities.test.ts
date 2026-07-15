import { describe, expect, it } from 'vitest';

import { todayPlus } from '../web/src/format.ts';
import { GenerationQueue } from '../web/src/generation-queue.ts';
import { paginateRows } from '../web/src/long-image.ts';

describe('Web editor generation queue', () => {
  it('runs saves serially and marks an older generation stale', async () => {
    const queue = new GenerationQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstGeneration = queue.advance();
    const first = queue.enqueue(firstGeneration, async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
      return 'first';
    });
    await Promise.resolve();

    const secondGeneration = queue.advance();
    const second = queue.enqueue(secondGeneration, async () => {
      events.push('second:start');
      return 'second';
    });
    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ value: 'first', current: false });
    await expect(second).resolves.toMatchObject({ value: 'second', current: true });
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('continues with the latest save after an earlier request rejects', async () => {
    const queue = new GenerationQueue();
    const oldGeneration = queue.advance();
    const failed = queue.enqueue(oldGeneration, async () => {
      throw new Error('network');
    });
    const currentGeneration = queue.advance();
    const recovered = queue.enqueue(currentGeneration, async () => 'saved');
    await expect(failed).rejects.toThrow('network');
    await expect(recovered).resolves.toMatchObject({ value: 'saved', current: true });
  });

  it('does not let a response from the previous editor generation commit into the new route', async () => {
    const queue = new GenerationQueue();
    let releaseOldRoute: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseOldRoute = resolve;
    });
    const oldRouteGeneration = queue.advance();
    const oldRoute = queue.enqueue(oldRouteGeneration, async () => {
      await gate;
      return { quoteId: 'quote-a', revision: 4 };
    });
    await Promise.resolve();

    queue.advance();
    let editorRefs = { quoteId: 'quote-b', revision: 1 };
    releaseOldRoute?.();
    const completed = await oldRoute;
    if (completed.current) editorRefs = completed.value;
    expect(completed.current).toBe(false);
    expect(editorRefs).toEqual({ quoteId: 'quote-b', revision: 1 });
  });
});

describe('Web quote image pagination', () => {
  it('preserves row order and keeps every normal page within its height budget', () => {
    const rows = [120, 250, 180, 300, 90].map((height, index) => ({ index, height }));
    const pages = paginateRows(rows, 500);
    expect(pages.flat().map((row) => row.index)).toEqual([0, 1, 2, 3, 4]);
    expect(pages).toHaveLength(3);
    for (const page of pages) {
      expect(page.reduce((total, row) => total + row.height, 0)).toBeLessThanOrEqual(500);
    }
  });

  it('rejects an invalid page height instead of creating an unbounded canvas', () => {
    expect(() => paginateRows([{ height: 10 }], 0)).toThrow('分页高度必须大于 0');
  });
});

describe('Web local calendar dates', () => {
  it('keeps the local calendar day instead of converting through UTC', () => {
    expect(todayPlus(1, new Date(2026, 0, 31, 1, 30))).toBe('2026-02-01');
  });
});
