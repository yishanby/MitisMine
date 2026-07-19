import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AgentEvent, RunJsonlOptions } from "../../packages/agent-protocol/src/types.js";
import {
  createAdapters,
  type AgentRunner,
  type ProviderName,
} from "../../packages/agent-adapters/src/index.js";
import { collectNormalized } from "../../packages/agent-adapters/src/types.js";

function optionValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function fakeRunner(calls: RunJsonlOptions[]): AgentRunner {
  return async function* (options): AsyncGenerator<AgentEvent> {
    calls.push(options);
    const args = options.args ?? [];
    if (options.command === "claude") {
      const resumed = optionValue(args, "--resume");
      yield { type: "system", subtype: "init", session_id: resumed ?? "claude-session" };
      yield { type: "result", result: "claude answer", session_id: resumed ?? "claude-session" };
      return;
    }
    if (args.includes("exec")) {
      const resumeIndex = args.indexOf("resume");
      const sessionId = resumeIndex < 0 ? "codex-session" : args[resumeIndex + 2];
      yield { type: "thread.started", thread_id: sessionId };
      yield {
        type: "item.completed",
        item: { type: "agent_message", text: "codex answer" },
      };
      return;
    }
    const resumeArgument = args.find((argument) => argument.startsWith("--resume="));
    const resumed = optionValue(args, "--resume") ?? resumeArgument?.slice("--resume=".length);
    const sessionId = resumed ?? optionValue(args, "--session-id");
    yield { type: "session.start", sessionId };
    yield { type: "assistant.message", data: { content: "copilot answer" } };
  };
}

describe("CLI adapters", () => {
  it("streams normalized Claude events before the invocation completes", async () => {
    let releaseProvider: (() => void) | undefined;
    const providerBlocked = new Promise<void>((resolve) => { releaseProvider = resolve; });
    let observeSession: (() => void) | undefined;
    const sessionObserved = new Promise<void>((resolve) => { observeSession = resolve; });
    let completed = false;
    const runner: AgentRunner = async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-live-events" };
      await providerBlocked;
      yield { type: "result", result: "done", session_id: "claude-live-events" };
    };

    const invocation = createAdapters(runner).claude.start({
      topicId: "topic-live-events",
      runId: "run-live-events",
      prompt: "stream progress",
      cwd: process.cwd(),
      onEvent: (event) => {
        if (event.type === "session") observeSession?.();
      },
    }).finally(() => { completed = true; });

    const observedBeforeCompletion = await Promise.race([
      sessionObserved.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    const completedWhenObserved = completed;
    releaseProvider?.();
    expect(observedBeforeCompletion).toBe(true);
    expect(completedWhenObserved).toBe(false);
    await expect(invocation).resolves.toMatchObject({ externalSessionId: "claude-live-events" });
  });

  it("emits safe Claude tool milestones without exposing tool input", async () => {
    const sensitiveQuery = "SECRET KUSTO QUERY MUST NOT LEAK";
    const runner: AgentRunner = async function* () {
      yield { type: "system", subtype: "init", session_id: "claude-tools" };
      yield {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Skill", input: { skill: "lumina-kusto", args: sensitiveQuery } },
            {
              type: "tool_use",
              name: "mcp__kusto-tools__execute_kusto_query",
              input: { query: sensitiveQuery },
            },
          ],
        },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "阶段结果" } },
      };
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: sensitiveQuery } },
      };
      yield { type: "result", result: "最终结果", session_id: "claude-tools" };
    };
    const observed: AgentEvent[] = [];

    await createAdapters(runner).claude.start({
      topicId: "topic-tools",
      runId: "run-tools",
      prompt: "use tools",
      cwd: process.cwd(),
      onEvent: (event) => { observed.push(event); },
    });

    expect(observed).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "progress", stage: "tool", message: "正在加载 Skill" }),
      expect.objectContaining({ type: "progress", stage: "tool", message: "正在查询 Kusto" }),
      { type: "delta", text: "阶段结果" },
    ]));
    expect(JSON.stringify(observed)).not.toContain(sensitiveQuery);
  });

  it("rewrites one corrupt Claude response inside the same Session", async () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const calls: RunJsonlOptions[] = [];
    const observed: AgentEvent[] = [];
    const runner: AgentRunner = async function* (options) {
      calls.push(options);
      yield { type: "system", subtype: "init", session_id: "claude-unicode-repair" };
      if (calls.length === 1) {
        yield {
          type: "result",
          result: `损坏${replacementCharacter}${replacementCharacter}${replacementCharacter}答案`,
          session_id: "claude-unicode-repair",
        };
        return;
      }
      yield { type: "result", result: "完整重写后的答案", session_id: "claude-unicode-repair" };
    };

    const result = await createAdapters(runner).claude.start({
      topicId: "topic-unicode-repair",
      runId: "run-unicode-repair",
      prompt: "answer in Chinese",
      cwd: process.cwd(),
      onEvent: (event) => { observed.push(event); },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual(expect.arrayContaining([
      "--resume",
      "claude-unicode-repair",
    ]));
    expect(calls[1]?.args?.at(-1)).toMatch(/完整.*重写|rewrite.*complete/i);
    expect(result.events).toContainEqual({ type: "final", text: "完整重写后的答案" });
    expect(observed).toContainEqual(expect.objectContaining({
      type: "progress",
      stage: "unicode_repair",
    }));
  });

  it("stops after one Claude Unicode rewrite attempt", async () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    let calls = 0;
    const runner: AgentRunner = async function* () {
      calls += 1;
      yield { type: "system", subtype: "init", session_id: "claude-still-corrupt" };
      yield {
        type: "result",
        result: `still ${replacementCharacter} corrupt`,
        session_id: "claude-still-corrupt",
      };
    };

    await expect(createAdapters(runner).claude.start({
      topicId: "topic-still-corrupt",
      runId: "run-still-corrupt",
      prompt: "answer",
      cwd: process.cwd(),
    })).rejects.toThrow(/invalid Unicode.*provider output/i);
    expect(calls).toBe(2);
  });

  it("rejects fatal or warning-only results that never emit a final event", async () => {
    const fatalRunner: AgentRunner = async function* () {
      yield { type: "session", externalSessionId: "session-fatal" };
      yield { type: "error", code: "process_exit", message: "failed" };
    };
    const warningOnlyRunner: AgentRunner = async function* () {
      yield { type: "session", externalSessionId: "session-warning" };
      yield { type: "error", code: "process_stderr", message: "diagnostic" };
    };
    const normalize = (event: AgentEvent): readonly AgentEvent[] => [event];

    await expect(collectNormalized("claude", fatalRunner, {
      command: "synthetic",
    }, normalize)).rejects.toThrow(/process_exit/);
    await expect(collectNormalized("claude", warningOnlyRunner, {
      command: "synthetic",
    }, normalize)).rejects.toThrow(/final/);
  });

  it("classifies a missing Claude resume Session without exposing its ID", async () => {
    const missingSessionId = "missing-claude-session-do-not-echo";
    const runner: AgentRunner = async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: missingSessionId,
        errors: [`No conversation found with session ID: ${missingSessionId}`],
      };
      yield {
        type: "error",
        code: "process_exit",
        message: "Agent process exited with code 1",
      };
    };
    const adapter = createAdapters(runner).claude;

    let rejection: unknown;
    try {
      await adapter.resume({
        topicId: "topic-missing-session",
        runId: "run-missing-session",
        prompt: "Continue safely",
        cwd: process.cwd(),
        externalSessionId: missingSessionId,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(expect.objectContaining({
      name: "ProviderInvocationError",
      provider: "claude",
      code: "session_not_found",
      message: "claude failed with session_not_found",
    }));
    expect((rejection as Error).message).not.toContain(missingSessionId);
  });

  it("maps an unknown runtime error code to a safe provider error", async () => {
    const arbitraryCode = "unknown_code:do-not-echo";
    const runner: AgentRunner = async function* () {
      yield { type: "session", externalSessionId: "session-unknown-error" };
      yield {
        type: "error",
        code: arbitraryCode,
        message: "failed",
      } as unknown as AgentEvent;
    };

    let rejection: unknown;
    try {
      await collectNormalized("claude", runner, { command: "synthetic" }, (event) => [event]);
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toEqual(expect.objectContaining({
      message: "claude failed with provider_error",
    }));
    expect((rejection as Error).message).not.toContain(arbitraryCode);
  });

  it("keeps process stderr as a warning when a final event exists", async () => {
    const runner: AgentRunner = async function* () {
      yield { type: "session", externalSessionId: "session-warning" };
      yield { type: "error", code: "process_stderr", message: "diagnostic" };
      yield { type: "final", text: "answer" };
    };

    const result = await collectNormalized(
      "claude",
      runner,
      { command: "synthetic" },
      (event) => [event],
    );

    expect(result.externalSessionId).toBe("session-warning");
    expect(result.events).toContainEqual(expect.objectContaining({ code: "process_stderr" }));
    expect(result.events).toContainEqual({ type: "final", text: "answer" });
  });

  it("rejects a final event containing invalid Unicode", async () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const runner: AgentRunner = async function* () {
      yield { type: "session", externalSessionId: "session-corrupt" };
      yield { type: "final", text: `corrupt ${replacementCharacter} answer` };
    };

    await expect(collectNormalized(
      "claude",
      runner,
      { command: "synthetic" },
      (event) => [event],
    )).rejects.toThrow(/invalid Unicode.*provider output/i);
  });

  it.each(["claude", "codex", "copilot"] as const)(
    "%s starts and resumes the same Topic session",
    async (provider) => {
      const calls: RunJsonlOptions[] = [];
      const adapters = createAdapters(fakeRunner(calls));
      const task = {
        topicId: "topic-1",
        runId: "run-1",
        prompt: "Investigate safely",
        cwd: process.cwd(),
      };

      const first = await adapters[provider].start(task);
      const second = await adapters[provider].resume({
        ...task,
        prompt: "Review the evidence",
        externalSessionId: first.externalSessionId,
      });

      if (provider === "copilot") {
        expect(first.externalSessionId).toMatch(/^[0-9a-f-]{36}$/);
      } else {
        expect(first.externalSessionId).toBe(`${provider}-session`);
      }
      expect(second.externalSessionId).toBe(first.externalSessionId);
      expect(first.events).toContainEqual({
        type: "final",
        text: `${provider} answer`,
      });
      expect(calls).toHaveLength(2);
    },
  );

  it("builds non-interactive, read-only and secret-aware commands", async () => {
    const calls: RunJsonlOptions[] = [];
    const adapters = createAdapters(fakeRunner(calls));
    const task = {
      topicId: "topic-1",
      runId: "run-1",
      prompt: "Question",
      cwd: resolve(tmpdir(), "mitismine-adapter-contract-workspace"),
    };

    for (const provider of ["claude", "codex", "copilot"] satisfies ProviderName[]) {
      await adapters[provider].start(task);
    }

    expect(calls[0]).toMatchObject({
      command: "claude",
      args: expect.arrayContaining([
        "--print",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "default",
        "--tools=Skill,WebSearch,WebFetch",
        "--allowedTools=Skill,WebSearch,WebFetch,mcp__kusto-tools__execute_kusto_query",
        "--disallowedTools=Read,Glob,Grep,Bash,Edit,Write",
      ]),
      providerAuthEnv: [],
    });
    expect(calls[0]?.args).not.toContain("--strict-mcp-config");
    expect(calls[0]?.args).not.toContain("--tools");
    expect(calls[0]?.args).not.toContain("--allowedTools");
    expect(calls[0]?.args).not.toContain("--disallowedTools");
    expect(calls[1]).toMatchObject({
      args: expect.arrayContaining([
        "exec",
        "--json",
        "--ignore-user-config",
        "--strict-config",
        "--skip-git-repo-check",
        "-c",
        'default_permissions="workspace"',
        'permissions.workspace.filesystem={":workspace_roots"={"."="read","**/*.env"="deny"}}',
      ]),
      stdin: "Question",
      providerAuthEnv: [],
    });
    expect(calls[1]?.args).not.toContain("--sandbox");
    expect(calls[1]?.args?.at(-1)).toBe("-");
    if (process.platform === "win32") {
      expect(calls[1]?.command).toBe(process.execPath);
      expect(calls[1]?.args?.[0]).toMatch(/@openai[\\/]codex[\\/]bin[\\/]codex\.js$/);
    } else {
      expect(calls[1]?.command).toBe("codex");
    }
    expect(calls[2]).toMatchObject({
      command: "copilot",
      args: expect.arrayContaining([
        "--prompt",
        "Question",
        "--output-format",
        "json",
        "--no-ask-user",
        "--session-id",
        "--available-tools=web_search,web_fetch",
      ]),
      providerAuthEnv: [],
    });
    expect(calls[2]?.args).not.toContain("--allow-all-paths");
    expect(calls[2]?.args).toContain(
      "--secret-env-vars=FEISHU_HUB_APP_SECRET,FEISHU_CLAUDE_APP_SECRET,FEISHU_CODEX_APP_SECRET,FEISHU_COPILOT_APP_SECRET",
    );
    for (const call of calls) {
      const pathFromRepository = relative(process.cwd(), call.cwd ?? "");
      expect(isAbsolute(call.cwd ?? "")).toBe(true);
      expect(pathFromRepository.startsWith("..") || isAbsolute(pathFromRepository)).toBe(true);
    }
  });
});
