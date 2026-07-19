import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";
import {
  collectNormalized,
  passthroughError,
  type AgentAdapter,
  type AgentRunner,
  type AgentTask,
  type ResumeAgentTask,
} from "./types.js";

function argumentsFor(task: AgentTask, sessionId?: string): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "default",
    "--tools=Skill,WebSearch,WebFetch",
    "--allowedTools=Skill,WebSearch,WebFetch,mcp__kusto-tools__execute_kusto_query",
    "--disallowedTools=Read,Glob,Grep,Bash,Edit,Write",
  ];
  if (sessionId !== undefined) args.push("--resume", sessionId);
  args.push(task.prompt);
  return args;
}

function normalizeClaude(event: AgentEvent): readonly AgentEvent[] {
  const error = passthroughError(event);
  if (error) return error;
  if (
    event.type === "result"
    && event.is_error === true
    && Array.isArray(event.errors)
    && event.errors.some(
      (message) => typeof message === "string"
        && /No conversation found with session ID:/i.test(message),
    )
  ) {
    return [{
      type: "error",
      code: "session_not_found",
      message: "Claude resume Session was not found",
    }];
  }
  if (
    event.type === "system" &&
    event.subtype === "init" &&
    typeof event.session_id === "string"
  ) {
    return [{ type: "session", externalSessionId: event.session_id }];
  }
  if (event.type === "result" && typeof event.result === "string") {
    return [{ type: "final", text: event.result }];
  }
  if (event.type === "stream_event" && typeof event.event === "object" && event.event !== null) {
    const streamEvent = event.event as Record<string, unknown>;
    const delta = streamEvent.delta;
    if (typeof delta === "object" && delta !== null) {
      const text = (delta as Record<string, unknown>).text;
      if (typeof text === "string") return [{ type: "delta", text }];
    }
  }
  return [];
}

function optionsFor(task: AgentTask, sessionId?: string): RunJsonlOptions {
  return {
    command: "claude",
    args: argumentsFor(task, sessionId),
    cwd: task.cwd,
    providerAuthEnv: [],
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
  };
}

export function createClaudeAdapter(runner: AgentRunner): AgentAdapter {
  return {
    provider: "claude",
    start: (task) => collectNormalized("claude", runner, optionsFor(task), normalizeClaude),
    resume: (task: ResumeAgentTask) =>
      collectNormalized(
        "claude",
        runner,
        optionsFor(task, task.externalSessionId),
        normalizeClaude,
        task.externalSessionId,
      ),
  };
}
