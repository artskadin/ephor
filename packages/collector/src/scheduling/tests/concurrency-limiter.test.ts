import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "../concurrency-limiter.js";
import { deferred } from "./deferred.js";

describe("ConcurrencyLimiter", () => {
  it("runs up to the limit immediately", async () => {
    const limiter = new ConcurrencyLimiter(2);
    const first = deferred();
    const second = deferred();

    void limiter.run(() => first.promise);
    void limiter.run(() => second.promise);

    await Promise.resolve();

    expect(limiter.active).toBe(2);
    expect(limiter.pending).toBe(0);
  });

  it("queues anything beyond the limit", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const first = deferred();

    void limiter.run(() => first.promise);
    void limiter.run(async () => {});

    await Promise.resolve();

    expect(limiter.active).toBe(1);
    expect(limiter.pending).toBe(1);
  });

  it("releases the slot even when the operation throws", async () => {
    const limiter = new ConcurrencyLimiter(1);

    await expect(
      limiter.run(async () => {
        throw new Error("whoops");
      }),
    ).rejects.toThrow("whoops");

    expect(limiter.active).toBe(0);
  });

  it("preserves submission order", async () => {
    const limiter = new ConcurrencyLimiter(1);
    const blocked = deferred();
    const order: number[] = [];

    void limiter.run(() => blocked.promise);
    void limiter.run(async () => void order.push(1));
    void limiter.run(async () => void order.push(2));

    blocked.resolve();
    await new Promise((r) => setTimeout(r, 10));

    expect(order).toEqual([1, 2]);
  });

  it("rejects an invalid limit", async () => {
    expect(() => new ConcurrencyLimiter(0)).toThrow();
  });
});
