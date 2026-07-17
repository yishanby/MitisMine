import { describe, expect, it } from "vitest";

import {
  ApprovalEngine,
  InMemoryApprovalStore,
  type ApprovalAction,
} from "../../packages/approval/src/index.js";

const action: ApprovalAction = {
  topicId: "topic-1",
  kind: "write_file",
  target: "smoke/approved.txt",
  risk: "medium",
  parameters: { content: "approved" },
};

function harness(now = "2026-07-17T12:00:00.000Z") {
  const store = new InMemoryApprovalStore();
  const calls: Array<{ action: ApprovalAction; idempotencyKey: string }> = [];
  const engine = new ApprovalEngine({
    signingSecret: "a".repeat(64),
    store,
    now: () => new Date(now),
    executor: async (approvedAction, idempotencyKey) => {
      calls.push({ action: approvedAction, idempotencyKey });
      return { written: approvedAction.target };
    },
  });
  return { store, calls, engine };
}

describe("ApprovalEngine", () => {
  it("executes an approved action exactly once and returns the stored result on retry", async () => {
    const { engine, calls } = harness();
    const request = engine.request(action, "tenant:user:owner");

    const first = await engine.approve(request.token, "tenant:user:owner");
    const second = await engine.approve(request.token, "tenant:user:owner");

    expect(first).toEqual({ written: "smoke/approved.txt" });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects token tampering and approval by another principal", async () => {
    const { engine, calls } = harness();
    const request = engine.request(action, "tenant:user:owner");
    const tampered = `${request.token.slice(0, -1)}${request.token.endsWith("a") ? "b" : "a"}`;

    await expect(engine.approve(tampered, "tenant:user:owner")).rejects.toThrow(/token/i);
    await expect(engine.approve(request.token, "tenant:user:other")).rejects.toThrow(/principal/i);
    expect(calls).toHaveLength(0);
  });

  it("rejects expired approvals before execution", async () => {
    let current = new Date("2026-07-17T12:00:00.000Z");
    const store = new InMemoryApprovalStore();
    let calls = 0;
    const engine = new ApprovalEngine({
      signingSecret: "b".repeat(64),
      store,
      now: () => current,
      defaultTtlMs: 1_000,
      executor: async () => {
        calls += 1;
        return "done";
      },
    });
    const request = engine.request(action, "tenant:user:owner");
    current = new Date("2026-07-17T12:00:02.000Z");

    await expect(engine.approve(request.token, "tenant:user:owner")).rejects.toThrow(/expired/i);
    expect(calls).toBe(0);
  });

  it("allows an explicitly authorized owner while retaining requester binding", async () => {
    const { engine, calls } = harness();
    const request = engine.request(action, "tenant:user:requester", {
      approverPrincipalId: "tenant:user:owner",
    });

    await expect(engine.approve(request.token, "tenant:user:requester")).rejects.toThrow(/principal/i);
    await engine.approve(request.token, "tenant:user:owner");
    expect(calls).toHaveLength(1);
  });
});
