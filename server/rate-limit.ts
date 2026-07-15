import { AppError } from './errors.ts';

interface RateEntry {
  count: number;
  resetAt: number;
}

export class MemoryRateLimiter {
  private readonly entries = new Map<string, RateEntry>();

  constructor(private readonly maximumKeys = 10_000) {}

  check(key: string, maximum: number, windowMs: number): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      if (!existing && this.entries.size >= this.maximumKeys) {
        for (const [entryKey, entry] of this.entries) {
          if (entry.resetAt <= now) this.entries.delete(entryKey);
        }
        if (this.entries.size >= this.maximumKeys) {
          throw new AppError(503, 'RATE_LIMIT_CAPACITY', '服务繁忙，请稍后再试');
        }
      }
      this.entries.set(key, { count: 1, resetAt: now + windowMs });
      return;
    }
    existing.count += 1;
    if (existing.count > maximum) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', '操作过于频繁，请稍后再试');
    }
  }
}

export const publicRateLimiter = new MemoryRateLimiter();
export const authRateLimiter = new MemoryRateLimiter(5_000);
