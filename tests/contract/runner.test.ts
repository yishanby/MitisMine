import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  curateChildEnvironment,
  runJsonl,
} from "../../packages/agent-protocol/src/runner.js";
import type { AgentEvent } from "../../packages/agent-protocol/src/types.js";

const fake = resolve("tests/fixtures/fake-agent.mjs");

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runJsonl", () => {
  it("streams JSONL in order", async () => {
    const events = await collect(
      runJsonl({ command: process.execPath, args: [fake, "stream"] }),
    );

    expect(events).toEqual([
      { type: "delta", text: "one" },
      { type: "final", text: "done" },
    ]);
  });

  it("removes secrets while keeping explicit safe and provider-auth values", async () => {
    const events = await collect(
      runJsonl({
        command: process.execPath,
        args: [fake, "env"],
        env: {
          FEISHU_HUB_APP_SECRET: "never-child",
          SAFE: "yes",
          ANTHROPIC_API_KEY: "provider-only",
        },
        allowEnv: ["SAFE"],
        providerAuthEnv: ["ANTHROPIC_API_KEY"],
      }),
    );

    expect(events.at(-1)).toMatchObject({
      type: "final",
      safe: "yes",
      providerAuth: "provider-only",
      leaked: false,
    });
  });

  it("preserves platform configuration directories needed for persisted CLI login", () => {
    const environment = curateChildEnvironment({
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      XDG_CONFIG_HOME: "/home/test/.config",
    });

    expect(environment).toMatchObject({
      APPDATA: "C:\\Users\\test\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
      XDG_CONFIG_HOME: "/home/test/.config",
    });
  });

  it("inherits native proxy, provider authentication, and tool configuration", () => {
    const original = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      AZURE_CONFIG_DIR: process.env.AZURE_CONFIG_DIR,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      KUSTO_DEFAULT_CLUSTER: process.env.KUSTO_DEFAULT_CLUSTER,
    };
    Object.assign(process.env, {
      HTTPS_PROXY: "http://127.0.0.1:8080",
      AZURE_CONFIG_DIR: "C:\\Users\\test\\.azure",
      ANTHROPIC_API_KEY: "provider-auth-value",
      KUSTO_DEFAULT_CLUSTER: "https://cluster.example.kusto.windows.net",
    });

    try {
      const environment = curateChildEnvironment({}, [], [], "native");

      expect(environment).toMatchObject({
        HTTPS_PROXY: "http://127.0.0.1:8080",
        AZURE_CONFIG_DIR: "C:\\Users\\test\\.azure",
        ANTHROPIC_API_KEY: "provider-auth-value",
        KUSTO_DEFAULT_CLUSTER: "https://cluster.example.kusto.windows.net",
      });
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("turns malformed JSONL into a structured error event", async () => {
    const events = await collect(
      runJsonl({ command: process.execPath, args: [fake, "malformed"] }),
    );

    expect(events).toEqual([
      expect.objectContaining({ type: "error", code: "malformed_jsonl" }),
    ]);
  });

  it("bounds captured stderr and overlong stdout lines", async () => {
    const stderrEvents = await collect(
      runJsonl({
        command: process.execPath,
        args: [fake, "stderr", "128"],
        maxStderrBytes: 16,
      }),
    );
    const lineEvents = await collect(
      runJsonl({
        command: process.execPath,
        args: [fake, "large-line"],
        maxLineBytes: 32,
      }),
    );

    expect(stderrEvents.at(-1)).toMatchObject({
      type: "error",
      code: "process_stderr",
      truncated: true,
    });
    expect((stderrEvents.at(-1) as { message: string }).message.length).toBeLessThanOrEqual(16);
    expect(lineEvents).toEqual([
      expect.objectContaining({ type: "error", code: "line_too_large" }),
    ]);
  });

  it("redacts sensitive key-value patterns from stderr and error events", async () => {
    const stderrEvents = await collect(
      runJsonl({ command: process.execPath, args: [fake, "stderr-sensitive"] }),
    );
    const errorEvents = await collect(
      runJsonl({ command: process.execPath, args: [fake, "error-sensitive"] }),
    );

    expect(stderrEvents.at(-1)).toMatchObject({
      type: "error",
      code: "process_stderr",
      message: expect.stringMatching(/\[REDACTED\].*\[REDACTED\]/),
    });
    expect(errorEvents.at(-1)).toMatchObject({
      type: "error",
      code: "provider_error",
      message: "API_TOKEN=[REDACTED]",
    });
  });

  it("terminates children on timeout and cancellation", async () => {
    const timedOut = await collect(
      runJsonl({
        command: process.execPath,
        args: [fake, "hang"],
        timeoutMs: 30,
      }),
    );
    const controller = new AbortController();
    const cancelledPromise = collect(
      runJsonl({
        command: process.execPath,
        args: [fake, "hang"],
        timeoutMs: 2_000,
        signal: controller.signal,
      }),
    );
    setTimeout(() => controller.abort(), 30);
    const cancelled = await cancelledPromise;

    expect(timedOut).toContainEqual(
      expect.objectContaining({ type: "error", code: "timeout" }),
    );
    expect(cancelled).toContainEqual(
      expect.objectContaining({ type: "error", code: "cancelled" }),
    );
  });

  it("cancels a spawned process tree and returns within a fixed bound", async () => {
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    let descendantPid: number | undefined;
    const startedAt = Date.now();

    try {
      for await (const event of runJsonl({
        command: process.execPath,
        args: [fake, "spawn-tree"],
        timeoutMs: 10_000,
        terminationGraceMs: 100,
        signal: controller.signal,
      })) {
        events.push(event);
        if (event.type === "descendant" && typeof event.pid === "number") {
          descendantPid = event.pid;
          controller.abort();
        }
      }

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(events).toContainEqual(expect.objectContaining({ type: "error", code: "cancelled" }));
      expect(descendantPid).toBeTypeOf("number");
      for (let attempt = 0; attempt < 20 && processIsAlive(descendantPid ?? -1); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(processIsAlive(descendantPid ?? -1)).toBe(false);
    } finally {
      if (descendantPid !== undefined && processIsAlive(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    }
  }, 10_000);
});
