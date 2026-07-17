import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ApprovalEngine,
  InMemoryApprovalStore,
  type ApprovalAction,
  TrustedActionExecutor,
} from "../../packages/approval/src/index.js";
import { SqliteApprovalStore } from "../../packages/storage/src/approval.js";
import { createTopic } from "../../packages/domain/src/topic.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

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

  it("persists one trusted file write across restart and blocks path escape", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-approval-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "approved");
    const database = join(directory, "approval.db");
    const signingSecret = "c".repeat(64);
    const eventStore = EventStore.open(database);
    const topic = createTopic("Approval", "tenant:user:owner", { id: "topic-1" });
    eventStore.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    eventStore.close();
    const firstStore = SqliteApprovalStore.open(database);
    const executor = new TrustedActionExecutor(root);
    const firstEngine = new ApprovalEngine({
      signingSecret,
      store: firstStore,
      executor: (approvedAction, idempotencyKey) =>
        executor.execute(approvedAction, idempotencyKey),
    });
    const approvedPath = join(root, "smoke", "approved.txt");
    const request = firstEngine.request(action, "tenant:user:owner");
    expect(existsSync(approvedPath)).toBe(false);
    await firstEngine.approve(request.token, "tenant:user:owner");
    expect(readFileSync(approvedPath, "utf8")).toBe("approved");
    firstStore.close();

    const secondStore = SqliteApprovalStore.open(database);
    const secondEngine = new ApprovalEngine({
      signingSecret,
      store: secondStore,
      executor: (approvedAction, idempotencyKey) =>
        executor.execute(approvedAction, idempotencyKey),
    });
    await expect(secondEngine.approve(request.token, "tenant:user:owner")).resolves.toEqual({
      idempotencyKey: expect.any(String),
      path: approvedPath,
      written: true,
    });
    const escaping = secondEngine.request(
      { ...action, target: "../escape.txt" },
      "tenant:user:owner",
    );
    await expect(secondEngine.approve(escaping.token, "tenant:user:owner")).rejects.toThrow(/outside/i);
    expect(existsSync(join(directory, "escape.txt"))).toBe(false);
    secondStore.close();
  });

  it("recovers interrupted trusted file execution across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-approval-recovery-"));
    temporaryDirectories.push(directory);
    const root = join(directory, "approved");
    const database = join(directory, "approval.db");
    const signingSecret = "d".repeat(64);
    const eventStore = EventStore.open(database);
    const topic = createTopic("Approval", "tenant:user:owner", { id: "topic-1" });
    eventStore.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: topic.ownerPrincipalId,
      payload: { topic },
    });
    eventStore.close();

    const firstStore = SqliteApprovalStore.open(database);
    const executor = new TrustedActionExecutor(root);
    const firstEngine = new ApprovalEngine({
      signingSecret,
      store: firstStore,
      executor: (approvedAction, idempotencyKey) =>
        executor.execute(approvedAction, idempotencyKey),
    });
    const request = firstEngine.request(action, "tenant:user:owner");
    expect(firstStore.beginExecution(request.request.id)).toBe(true);
    await executor.execute(request.request.action, request.request.idempotencyKey);
    const approvedPath = join(root, "smoke", "approved.txt");
    expect(readFileSync(approvedPath, "utf8")).toBe("approved");
    firstStore.close();

    const secondStore = SqliteApprovalStore.open(database);
    try {
      expect(secondStore.get(request.request.id)?.status).toBe("pending");
      const secondEngine = new ApprovalEngine({
        signingSecret,
        store: secondStore,
        executor: (approvedAction, idempotencyKey) =>
          executor.execute(approvedAction, idempotencyKey),
      });
      await expect(secondEngine.approve(request.token, "tenant:user:owner")).resolves.toEqual({
        idempotencyKey: request.request.idempotencyKey,
        path: approvedPath,
        written: true,
      });
      expect(readFileSync(approvedPath, "utf8")).toBe("approved");
    } finally {
      secondStore.close();
    }
  });
});
