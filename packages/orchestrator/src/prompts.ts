import type { ProviderName } from "../../agent-adapters/src/index.js";
import type { NormalizedReport } from "../../domain/src/evidence.js";
import type { ResearchReview } from "./index.js";

const REPORT_CONTRACT = `Return only JSON with: summary, claims, evidence, openQuestions, subtaskProposals.
Each claim requires id, text, importance (important|supporting), confidence (0..1), and evidenceIds.
Each evidence item requires id, url, title, publisher, quote, and retrievedAt (ISO-8601).
Important claims without evidence must use an empty evidenceIds list.
Each subtaskProposals item requires id, title, and prompt. Propose at most two subtasks.`;

export function independentResearchPrompt(question: string, provider: ProviderName): string {
  return `PHASE: independent_research
ROLE: ${provider}
Investigate independently. Do not assume or imitate any other agent's answer.
Question: ${question}
${REPORT_CONTRACT}`;
}

export function repairReportPrompt(raw: string): string {
  return `PHASE: normalize_evidence
Repair the previous response into the required JSON contract. Do not add unsupported facts.
${REPORT_CONTRACT}
Invalid response digest: ${raw.slice(0, 2_000)}`;
}

export function crossReviewPrompt(
  reviewer: ProviderName,
  target: ProviderName,
  report: NormalizedReport,
  round: number,
): string {
  return `PHASE: cross_review
REVIEWER: ${reviewer}
TARGET: ${target}
ROUND: ${round}
Review every important claim and its cited quotation. Return only JSON:
{"critiques":[{"targetClaimId":"...","severity":"low|medium|high","text":"...","status":"open|resolved"}]}
TARGET_REPORT: ${JSON.stringify(report)}`;
}

export function disputeResolutionPrompt(
  provider: ProviderName,
  reviews: readonly ResearchReview[],
  round: number,
): string {
  return `PHASE: resolve_disputes
PROVIDER: ${provider}
ROUND: ${round}
Investigate only the open medium/high critiques below. Return JSON describing what was resolved and cite new evidence where needed.
OPEN_CRITIQUES: ${JSON.stringify(reviews)}`;
}

export function synthesisPrompt(
  question: string,
  reports: Readonly<Partial<Record<ProviderName, NormalizedReport>>>,
  reviews: readonly ResearchReview[],
  unresolved: boolean,
): string {
  return `PHASE: synthesize
Question: ${question}
Combine the reports without hiding disagreements. Unresolved=${String(unresolved)}.
${REPORT_CONTRACT}
PEER_REPORTS: ${JSON.stringify(reports)}
REVIEWS: ${JSON.stringify(reviews)}`;
}

export function signoffPrompt(report: NormalizedReport): string {
  return `PHASE: signoff
Audit evidence coverage and unresolved disagreements. Return only JSON:
{"approved":true,"critiques":[{"targetClaimId":"...","severity":"low|medium|high","text":"...","status":"open|resolved"}]}
FINAL_REPORT: ${JSON.stringify(report)}`;
}
