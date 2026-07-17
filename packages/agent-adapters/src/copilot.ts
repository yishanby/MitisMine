import { randomUUID } from "node:crypto";

import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";
import {
  collectNormalized,
  passthroughError,
  type AgentAdapter,
  type AgentRunner,
  type AgentTask,
  type ResumeAgentTask,
} from "./types.js";

const REDACTED_SECRET_NAMES = [
  "FEISHU_HUB_APP_SECRET",
  "FEISHU_CLAUDE_APP_SECRET",
  "FEISHU_CODEX_APP_SECRET",
  "FEISHU_COPILOT_APP_SECRET",
].join(",");

function argumentsFor(task: AgentTask, sessionId: string, resume: boolean): string[] {
  const args = [
    "--prompt",
    task.prompt,
    "--output-format",
    "json",
    "--stream",
    "on",
    "--no-ask-user",
    "--no-color",
    "--available-tools=web_search,web_fetch",
    `--secret-env-vars=${REDACTED_SECRET_NAMES}`,
  ];
  if (resume) args.push(`--resume=${sessionId}`);
  else args.push("--session-id", sessionId);
  return args;
}

function normalizeCopilot(event: AgentEvent): readonly AgentEvent[] {
  const error = passthroughError(event);
  if (error) return error;
  if (
    (event.type === "session.start" || event.type === "session_started") &&
    typeof event.sessionId === "string"
  ) {
    return [{ type: "session", externalSessionId: event.sessionId }];
  }
  if (event.type === "assistant.message" && typeof event.data === "object" && event.data !== null) {
    const content = (event.data as Record<string, unknown>).content;
    if (typeof content === "string") return [{ type: "final", text: content }];
  }
  if (event.type === "assistant_message" && typeof event.content === "string") {
    return [{ type: "final", text: event.content }];
  }
  return [];
}

function optionsFor(task: AgentTask, sessionId: string, resume: boolean): RunJsonlOptions {
  return {
    command: "copilot",
    args: argumentsFor(task, sessionId, resume),
    cwd: task.cwd,
    providerAuthEnv: [],
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
  };
}

export function createCopilotAdapter(runner: AgentRunner): AgentAdapter {
  return {
    provider: "copilot",
    start: (task) => {
      const sessionId = randomUUID();
      return collectNormalized(
        "copilot",
        runner,
        optionsFor(task, sessionId, false),
        normalizeCopilot,
        sessionId,
      );
    },
    resume: (task: ResumeAgentTask) =>
      collectNormalized(
        "copilot",
        runner,
        optionsFor(task, task.externalSessionId, true),
        normalizeCopilot,
        task.externalSessionId,
      ),
  };
}
