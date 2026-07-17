import type { ProviderName } from "../../agent-adapters/src/index.js";
import type { NormalizedReport } from "../../domain/src/evidence.js";
import type { ResearchReview } from "./index.js";

const REPORT_CONTRACT = `Return only JSON with: summary, claims, evidence, openQuestions, subtaskProposals.
Each claim requires id, text, importance (important|supporting), confidence (0..1), and evidenceIds.
Each evidence item requires id, url, title, publisher, quote, and retrievedAt (ISO-8601).
Important claims without evidence must use an empty evidenceIds list.
Each subtaskProposals item requires id, title, and prompt. Propose at most two subtasks.`;

export function independentResearchPrompt(
  question: string,
  provider: ProviderName,
  contextPack: string,
): string {
  return `PHASE: independent_research
ROLE: ${provider}
Investigate independently. Do not assume or imitate any other agent's answer.
Question: ${question}
CONTEXT_PACK: ${contextPack}
${REPORT_CONTRACT}`;
}

export function directResearchPrompt(question: string, contextPack: string): string {
  return `PHASE: direct
Question: ${question}
CONTEXT_PACK: ${contextPack}`;
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
  report: NormalizedReport,
  reviews: readonly ResearchReview[],
  round: number,
): string {
  return `PHASE: resolve_disputes
PROVIDER: ${provider}
ROUND: ${round}
Investigate only the open medium/high critiques below. Return a complete updated report, preserving supported material and adding corrected claims or evidence where needed.
${REPORT_CONTRACT}
CURRENT_REPORT: ${JSON.stringify(report)}
OPEN_CRITIQUES: ${JSON.stringify(reviews)}`;
}

export function subtaskResearchPrompt(input: {
  readonly provider: ProviderName;
  readonly id: string;
  readonly title: string;
  readonly prompt: string;
}): string {
  return `PHASE: subtask_research
PROVIDER: ${input.provider}
SUBTASK_ID: ${input.id}
TITLE: ${input.title}
Investigate this bounded subtask and return a concise evidence-backed result:
${input.prompt}`;
}

export function synthesisPrompt(
  question: string,
  reports: Readonly<Partial<Record<ProviderName, NormalizedReport>>>,
  subtaskResults: Readonly<Partial<Record<ProviderName, readonly unknown[]>>>,
  reviews: readonly ResearchReview[],
  unresolved: boolean,
): string {
  return `PHASE: synthesize
Question: ${question}
Combine the reports without hiding disagreements. Unresolved=${String(unresolved)}.
${REPORT_CONTRACT}
PEER_REPORTS: ${JSON.stringify(reports)}
SUBTASK_RESULTS: ${JSON.stringify(subtaskResults)}
REVIEWS: ${JSON.stringify(reviews)}`;
}

export function signoffPrompt(report: NormalizedReport): string {
  return `PHASE: signoff
Audit evidence coverage and unresolved disagreements. Return only JSON:
{"approved":true,"critiques":[{"targetClaimId":"...","severity":"low|medium|high","text":"...","status":"open|resolved"}]}
FINAL_REPORT: ${JSON.stringify(report)}`;
}
