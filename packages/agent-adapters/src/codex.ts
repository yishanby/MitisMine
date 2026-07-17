import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";
import {
  collectNormalized,
  passthroughError,
  type AgentAdapter,
  type AgentRunner,
  type AgentTask,
  type ResumeAgentTask,
} from "./types.js";

const CODEX_AUTH_ENV = ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] as const;

function argumentsFor(task: AgentTask, sessionId?: string): string[] {
  if (sessionId !== undefined) {
    return [
      "exec",
      "--sandbox",
      "read-only",
      "resume",
      "--json",
      sessionId,
      task.prompt,
    ];
  }
  return [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    task.prompt,
  ];
}

function normalizeCodex(event: AgentEvent): readonly AgentEvent[] {
  const error = passthroughError(event);
  if (error) return error;
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return [{ type: "session", externalSessionId: event.thread_id }];
  }
  if (event.type === "item.completed" && typeof event.item === "object" && event.item !== null) {
    const item = event.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      return [{ type: "final", text: item.text }];
    }
  }
  if (event.type === "turn.failed") {
    return [{ type: "error", code: "provider_error", message: "Codex turn failed" }];
  }
  return [];
}

function optionsFor(task: AgentTask, sessionId?: string): RunJsonlOptions {
  return {
    command: "codex",
    args: argumentsFor(task, sessionId),
    cwd: task.cwd,
    providerAuthEnv: CODEX_AUTH_ENV,
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
  };
}

export function createCodexAdapter(runner: AgentRunner): AgentAdapter {
  return {
    provider: "codex",
    start: (task) => collectNormalized("codex", runner, optionsFor(task), normalizeCodex),
    resume: (task: ResumeAgentTask) =>
      collectNormalized(
        "codex",
        runner,
        optionsFor(task, task.externalSessionId),
        normalizeCodex,
        task.externalSessionId,
      ),
  };
}
