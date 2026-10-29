/**
 * Run `fn` over `items` with at most `limit` running at once. Items start in index order;
 * results keep index order regardless of completion order.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

export interface Limiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
  readonly active: number;
}

/** Counting semaphore: at most `limit` calls of `fn` are in flight; the rest wait in FIFO order. */
export function createLimiter(limit: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return {
    get active() {
      return active;
    },
    async run(fn) {
      if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
      else active++;
      try {
        return await fn();
      } finally {
        const wake = waiting.shift();
        if (wake) wake();
        else active--;
      }
    },
  };
}
