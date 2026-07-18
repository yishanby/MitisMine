import { describe, expect, it } from "vitest";

import { AgentConcurrencyLimiter } from "../../packages/orchestrator/src/concurrency.js";

describe("AgentConcurrencyLimiter", () => {
  it("enforces one shared FIFO budget across independent callers", async () => {
    const limiter = new AgentConcurrencyLimiter(1);
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = limiter.run(async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
    });
    const second = limiter.run(async () => { order.push("second"); });
    const third = limiter.run(async () => { order.push("third"); });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first:start", "first:end", "second", "third"]);
  });
});
