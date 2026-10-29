import { describe, expect, it } from "vitest";
import { createLimiter, mapWithConcurrency } from "../../src/app/concurrency.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mapWithConcurrency", () => {
  it("keeps index order regardless of completion order and respects the limit", async () => {
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const result = await mapWithConcurrency([30, 5, 20, 1, 10], 2, async (ms, i) => {
      order.push(i);
      active++;
      peak = Math.max(peak, active);
      await tick(ms);
      active--;
      return ms * 2;
    });
    expect(result).toEqual([60, 10, 40, 2, 20]);
    expect(order).toEqual([0, 1, 2, 3, 4]); // started in index order
    expect(peak).toBe(2);
  });

  it("handles empty input and limits above the item count", async () => {
    expect(await mapWithConcurrency([], 4, () => Promise.resolve(1))).toEqual([]);
    expect(await mapWithConcurrency([1], 8, (x) => Promise.resolve(x + 1))).toEqual([2]);
  });
});

describe("createLimiter", () => {
  it("never runs more than `limit` tasks and hands slots over in FIFO order", async () => {
    const limiter = createLimiter(2);
    let peak = 0;
    const started: number[] = [];
    const tasks = [15, 15, 1, 1, 1].map((ms, i) =>
      limiter.run(async () => {
        started.push(i);
        peak = Math.max(peak, limiter.active);
        await tick(ms);
        return i;
      }),
    );
    expect(await Promise.all(tasks)).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(limiter.active).toBe(0);
  });

  it("releases the slot when a task rejects", async () => {
    const limiter = createLimiter(1);
    await expect(limiter.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(await limiter.run(() => Promise.resolve("ok"))).toBe("ok");
    expect(limiter.active).toBe(0);
  });
});
