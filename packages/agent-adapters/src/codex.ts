import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";
import {
  collectNormalized,
  passthroughError,
  type AgentAdapter,
  type AgentRunner,
  type AgentTask,
  type ResumeAgentTask,
} from "./types.js";

const PERMISSION_ARGS = [
  "--ignore-user-config",
  "--strict-config",
  "--skip-git-repo-check",
  "-c",
  'default_permissions="workspace"',
  "-c",
  'permissions.workspace.filesystem={":workspace_roots"={"."="read","**/*.env"="deny"}}',
] as const;

function argumentsFor(sessionId?: string): string[] {
  if (sessionId !== undefined) {
    return [
      "exec",
      ...PERMISSION_ARGS,
      "resume",
      "--json",
      sessionId,
      "-",
    ];
  }
  return [
    "exec",
    ...PERMISSION_ARGS,
    "--json",
    "--color",
    "never",
    "-",
  ];
}

function executable(): { command: string; prefixArgs: string[] } {
  if (process.platform !== "win32") return { command: "codex", prefixArgs: [] };
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const entry = join(directory, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(entry)) return { command: process.execPath, prefixArgs: [entry] };
  }
  return { command: "codex", prefixArgs: [] };
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
  const invocation = executable();
  return {
    command: invocation.command,
    args: [...invocation.prefixArgs, ...argumentsFor(sessionId)],
    stdin: task.prompt,
    cwd: task.cwd,
    providerAuthEnv: [],
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
