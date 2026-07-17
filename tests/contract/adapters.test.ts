import { describe, expect, it } from "vitest";

import type { AgentEvent, RunJsonlOptions } from "../../packages/agent-protocol/src/types.js";
import {
  createAdapters,
  type AgentRunner,
  type ProviderName,
} from "../../packages/agent-adapters/src/index.js";

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
    if (options.command === "codex") {
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
      cwd: process.cwd(),
    };

    for (const provider of ["claude", "codex", "copilot"] satisfies ProviderName[]) {
      await adapters[provider].start(task);
    }

    expect(calls[0]).toMatchObject({
      command: "claude",
      args: expect.arrayContaining(["--print", "--output-format", "stream-json"]),
      providerAuthEnv: expect.arrayContaining(["ANTHROPIC_API_KEY"]),
    });
    expect(calls[1]).toMatchObject({
      command: "codex",
      args: expect.arrayContaining(["exec", "--json", "--sandbox", "read-only"]),
      providerAuthEnv: expect.arrayContaining(["CODEX_API_KEY"]),
    });
    expect(calls[2]).toMatchObject({
      command: "copilot",
      args: expect.arrayContaining([
        "--prompt",
        "Question",
        "--output-format",
        "json",
        "--no-ask-user",
        "--session-id",
      ]),
      providerAuthEnv: expect.arrayContaining(["GITHUB_TOKEN"]),
    });
    expect(calls[2]?.args).toContain(
      "--secret-env-vars=FEISHU_HUB_APP_SECRET,FEISHU_CLAUDE_APP_SECRET,FEISHU_CODEX_APP_SECRET,FEISHU_COPILOT_APP_SECRET",
    );
  });
});
