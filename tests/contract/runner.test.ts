import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { runJsonl } from "../../packages/agent-protocol/src/runner.js";
import type { AgentEvent } from "../../packages/agent-protocol/src/types.js";

const fake = resolve("tests/fixtures/fake-agent.mjs");

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
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
});
