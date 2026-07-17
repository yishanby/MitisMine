import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";

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
  if (externalSessionId === undefined) {
    throw new Error(`${provider} did not emit a session identifier`);
  }
  return { provider, externalSessionId, events };
}

export function passthroughError(event: AgentEvent): readonly AgentEvent[] | undefined {
  return event.type === "error" ? [event] : undefined;
}
