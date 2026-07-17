import { describe, expect, it } from "vitest";

import { compileContext } from "../../packages/domain/src/context.js";

describe("compileContext", () => {
  it("keeps summary, evidence identifiers, recent events, and source watermark within the limit", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      seq: index + 1,
      type: "message.added",
      text: `event-${index + 1}:${"x".repeat(300)}`,
      relevance: index,
      pinned: false,
    }));

    const pack = compileContext({
      maxChars: 3_000,
      summary: "Persistent summary",
      events,
      evidence: [
        {
          id: "evidence-1",
          url: "https://example.com/source",
          quote: "Primary source quotation",
        },
      ],
      watermark: 42,
    });

    expect(pack.watermark).toBe(42);
    expect(pack.summary).toBe("Persistent summary");
    expect(pack.serialized.length).toBeLessThanOrEqual(3_000);
    expect(pack.serialized).toContain("evidence-1");
    expect(pack.serialized).toContain("event-40");
    expect(pack.serialized).not.toContain("event-1:");
  });
});
