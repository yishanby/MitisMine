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
        "--tools",
        "WebSearch,WebFetch",
        "--allowedTools",
        "WebSearch,WebFetch",
        "--disallowedTools",
        "Read,Glob,Grep,Bash,Edit,Write",
      ]),
      providerAuthEnv: [],
    });
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
