import type {
  AgentErrorEvent,
  AgentEvent,
  RunJsonlOptions,
} from "../../agent-protocol/src/types.js";

const safeProviderErrorCodes: ReadonlySet<string> = new Set([
  "cancelled",
  "line_too_large",
  "malformed_jsonl",
  "output_too_large",
  "process_error",
  "process_exit",
  "process_stderr",
  "provider_error",
  "session_not_found",
  "timeout",
] satisfies readonly (AgentErrorEvent["code"] | "provider_error")[]);

export type ProviderErrorCode = AgentErrorEvent["code"] | "provider_error";

function isProviderErrorCode(value: unknown): value is ProviderErrorCode {
  return typeof value === "string" && safeProviderErrorCodes.has(value);
}

export class ProviderInvocationError extends Error {
  readonly provider: ProviderName;
  readonly code: ProviderErrorCode;

  constructor(provider: ProviderName, code: ProviderErrorCode) {
    super(`${provider} failed with ${code}`);
    this.name = "ProviderInvocationError";
    this.provider = provider;
    this.code = code;
  }
}

export type ProviderName = "claude" | "codex" | "copilot";

export interface AgentTask {
  readonly topicId: string;
  readonly runId: string;
  readonly prompt: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface ResumeAgentTask extends AgentTask {
  readonly externalSessionId: string;
}

export interface AdapterResult {
  readonly provider: ProviderName;
  readonly externalSessionId: string;
  readonly events: readonly AgentEvent[];
}

export type AgentRunner = (options: RunJsonlOptions) => AsyncIterable<AgentEvent>;

export interface AgentAdapter {
  readonly provider: ProviderName;
  start(task: AgentTask): Promise<AdapterResult>;
  resume(task: ResumeAgentTask): Promise<AdapterResult>;
}

export function assertValidProviderText(text: string): void {
  if (text.includes("\ufffd")) {
    throw new Error("Invalid Unicode in provider output");
  }
}

export async function collectNormalized(
  provider: ProviderName,
  runner: AgentRunner,
  options: RunJsonlOptions,
  normalize: (event: AgentEvent) => readonly AgentEvent[],
  fallbackSessionId?: string,
): Promise<AdapterResult> {
  const events: AgentEvent[] = [];
  let externalSessionId = fallbackSessionId;
  for await (const rawEvent of runner(options)) {
    for (const event of normalize(rawEvent)) {
      events.push(event);
      if (event.type === "session" && typeof event.externalSessionId === "string") {
        externalSessionId = event.externalSessionId;
      }
    }
  }
  const fatal = events.find(
    (event) => event.type === "error" && event.code !== "process_stderr",
  );
  if (fatal !== undefined) {
    const code = isProviderErrorCode(fatal.code)
      ? fatal.code
      : "provider_error";
    throw new ProviderInvocationError(provider, code);
  }
  let hasFinal = false;
  for (const event of events) {
    if (event.type !== "final" || typeof event.text !== "string") continue;
    hasFinal = true;
    assertValidProviderText(event.text);
  }
  if (!hasFinal) {
    throw new Error(`${provider} did not emit a final event`);
  }
  if (externalSessionId === undefined) {
    throw new Error(`${provider} did not emit a session identifier`);
  }
  return { provider, externalSessionId, events };
}

export function passthroughError(event: AgentEvent): readonly AgentEvent[] | undefined {
  return event.type === "error" ? [event] : undefined;
}
