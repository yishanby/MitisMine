import { createHash } from "node:crypto";

import { z } from "zod";

const evidenceInputSchema = z.object({
  id: z.string().trim().min(1),
  url: z.string().url(),
  title: z.string().trim().min(1),
  publisher: z.string().trim().min(1),
  quote: z.string().trim().min(1),
  retrievedAt: z.string().datetime({ offset: true }),
  toolTraceId: z.string().trim().min(1).optional(),
});

const claimInputSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().trim().min(1),
  importance: z.enum(["important", "supporting"]),
  confidence: z.number().min(0).max(1),
  evidenceIds: z.array(z.string().trim().min(1)),
});

const subtaskProposalSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
});

export const agentReportInputSchema = z.object({
  summary: z.string().trim().min(1),
  claims: z.array(claimInputSchema),
  evidence: z.array(evidenceInputSchema),
  openQuestions: z.array(z.string().trim().min(1)),
  subtaskProposals: z.array(subtaskProposalSchema).max(2),
});

export type AgentReportInput = z.input<typeof agentReportInputSchema>;
export type ClaimStatus = "supported" | "unsupported" | "unverified";

export interface NormalizedEvidence {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly publisher: string;
  readonly quote: string;
  readonly retrievedAt: string;
  readonly sha256: string;
  readonly toolTraceId?: string;
}

export interface NormalizedClaim {
  readonly id: string;
  readonly text: string;
  readonly importance: "important" | "supporting";
  readonly confidence: number;
  readonly evidenceIds: readonly string[];
  readonly status: ClaimStatus;
}

export interface NormalizedReport {
  readonly summary: string;
  readonly claims: readonly NormalizedClaim[];
  readonly evidence: readonly NormalizedEvidence[];
  readonly openQuestions: readonly string[];
  readonly subtaskProposals: readonly z.output<typeof subtaskProposalSchema>[];
}

export function normalizeReport(input: AgentReportInput): NormalizedReport {
  const parsed = agentReportInputSchema.parse(input);
  const evidenceIds = new Set(parsed.evidence.map((item) => item.id));
  for (const claim of parsed.claims) {
    for (const evidenceId of claim.evidenceIds) {
      if (!evidenceIds.has(evidenceId)) {
        throw new Error(`claim ${claim.id} references unknown evidence ${evidenceId}`);
      }
    }
  }

  const evidence = parsed.evidence.map((item): NormalizedEvidence => {
    const sha256 = createHash("sha256")
      .update(`${normalizeUrl(item.url)}\n${item.quote}\n${item.retrievedAt}`)
      .digest("hex");
    return {
      id: item.id,
      url: item.url,
      title: item.title,
      publisher: item.publisher,
      quote: item.quote,
      retrievedAt: item.retrievedAt,
      sha256,
      ...(item.toolTraceId === undefined ? {} : { toolTraceId: item.toolTraceId }),
    };
  });

  const claims = parsed.claims.map((claim): NormalizedClaim => ({
    ...claim,
    status:
      claim.evidenceIds.length > 0
        ? "supported"
        : claim.importance === "important"
          ? "unsupported"
          : "unverified",
  }));

  return {
    summary: parsed.summary,
    claims,
    evidence,
    openQuestions: parsed.openQuestions,
    subtaskProposals: parsed.subtaskProposals,
  };
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  return url.toString();
}
