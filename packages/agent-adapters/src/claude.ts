import type { AgentEvent, RunJsonlOptions } from "../../agent-protocol/src/types.js";
import {
  collectNormalized,
  passthroughError,
  ProviderOutputUnicodeError,
  type AgentAdapter,
  type AgentRunner,
  type AgentTask,
  type ResumeAgentTask,
} from "./types.js";

const UNICODE_REWRITE_PROMPT = [
  "Your previous answer was corrupted in transport and contains U+FFFD.",
  "Rewrite the complete answer now, preserving every result and conclusion.",
  "Return only the rewritten answer. Do not mention this repair request.",
].join(" ");

const CLAUDE_TOOL_PROGRESS: Readonly<Record<string, string>> = {
  Skill: "正在加载 Skill",
  WebSearch: "正在搜索公开资料",
  WebFetch: "正在读取来源",
  "mcp__kusto-tools__execute_kusto_query": "正在查询 Kusto",
};

function argumentsFor(task: AgentTask, sessionId?: string): string[] {
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--tools=default",
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
  if (event.type === "assistant" && typeof event.message === "object" && event.message !== null) {
    const content = (event.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      return content.flatMap((block): AgentEvent[] => {
        if (typeof block !== "object" || block === null) return [];
        const value = block as Record<string, unknown>;
        if (value.type !== "tool_use" || typeof value.name !== "string") return [];
        const message = CLAUDE_TOOL_PROGRESS[value.name];
        return message === undefined ? [] : [{ type: "progress", stage: "tool", message }];
      });
    }
  }
  if (event.type === "user" && typeof event.message === "object" && event.message !== null) {
    const content = (event.message as Record<string, unknown>).content;
    if (
      Array.isArray(content)
      && content.some((block) => typeof block === "object" && block !== null
        && (block as Record<string, unknown>).type === "tool_result")
    ) {
      return [{ type: "progress", stage: "analysis", message: "已获得工具结果，正在分析" }];
    }
  }
  if (event.type === "result" && typeof event.result === "string") {
    return [{ type: "final", text: event.result }];
  }
  if (event.type === "stream_event" && typeof event.event === "object" && event.event !== null) {
    const streamEvent = event.event as Record<string, unknown>;
    const delta = streamEvent.delta;
    if (typeof delta === "object" && delta !== null) {
      const deltaValue = delta as Record<string, unknown>;
      const text = deltaValue.text;
      if (deltaValue.type === "text_delta" && typeof text === "string") {
        return [{ type: "delta", text }];
      }
    }
  }
  return [];
}

function optionsFor(task: AgentTask, sessionId?: string): RunJsonlOptions {
  return {
    command: "claude",
    args: argumentsFor(task, sessionId),
    cwd: task.cwd,
    environmentPolicy: "native",
    providerAuthEnv: [],
    ...(task.timeoutMs === undefined ? {} : { timeoutMs: task.timeoutMs }),
    ...(task.signal === undefined ? {} : { signal: task.signal }),
  };
}

export function createClaudeAdapter(runner: AgentRunner): AgentAdapter {
  const invoke = async (
    task: AgentTask,
    sessionId?: string,
    allowUnicodeRewrite = true,
  ) => {
    try {
      return await collectNormalized(
        "claude",
        runner,
        optionsFor(task, sessionId),
        normalizeClaude,
        sessionId,
        task.onEvent,
      );
    } catch (error) {
      if (
        !allowUnicodeRewrite
        || !(error instanceof ProviderOutputUnicodeError)
        || error.provider !== "claude"
        || error.externalSessionId === undefined
      ) {
        throw error;
      }
      await task.onEvent?.({
        type: "progress",
        stage: "unicode_repair",
        message: "检测到传输编码损坏，正在重新生成完整答案",
      });
      return invoke(
        { ...task, prompt: UNICODE_REWRITE_PROMPT },
        error.externalSessionId,
        false,
      );
    }
  };
  return {
    provider: "claude",
    start: (task) => invoke(task),
    resume: (task: ResumeAgentTask) => invoke(task, task.externalSessionId),
  };
}
