import { describe, expect, it } from "vitest";

import { normalizeReport } from "../../packages/domain/src/evidence.js";

describe("normalizeReport", () => {
  it("hashes evidence and marks important unsupported claims", () => {
    const report = normalizeReport({
      summary: "Summary",
      claims: [
        {
          id: "claim-supported",
          text: "A supported claim",
          importance: "important",
          confidence: 0.9,
          evidenceIds: ["source-1"],
        },
        {
          id: "claim-unsupported",
          text: "An unsupported claim",
          importance: "important",
          confidence: 0.4,
          evidenceIds: [],
        },
      ],
      evidence: [
        {
          id: "source-1",
          url: "https://example.com/primary",
          title: "Primary source",
          publisher: "Example",
          quote: "Quoted evidence",
          retrievedAt: "2026-07-17T12:00:00.000Z",
        },
      ],
      openQuestions: ["What remains uncertain?"],
      subtaskProposals: [],
    });

    expect(report.evidence[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.claims[0]?.status).toBe("supported");
    expect(report.claims[1]?.status).toBe("unsupported");
  });

  it("rejects references to unknown evidence", () => {
    expect(() =>
      normalizeReport({
        summary: "Summary",
        claims: [
          {
            id: "claim",
            text: "Claim",
            importance: "supporting",
            confidence: 0.5,
            evidenceIds: ["missing"],
          },
        ],
        evidence: [],
        openQuestions: [],
        subtaskProposals: [],
      }),
    ).toThrow(/unknown evidence/);
  });
});
