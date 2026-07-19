import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectProgressReporter } from "../../apps/control-plane/src/direct-progress.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DirectProgressReporter", () => {
  it("patches one accepted card with throttled progress, heartbeat, and completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T01:00:00.000Z"));
    const directory = mkdtempSync(join(tmpdir(), "mitismine-direct-progress-"));
    temporaryDirectories.push(directory);
    const outbox = DurableOutbox.open(join(directory, "progress.db"));
    const dispatchKey = "feishu:claude:event-1:dispatch";
    const acceptedId = `outbox:${dispatchKey}:accepted`;
    outbox.enqueue({
      id: acceptedId,
      appRole: "claude",
      receiveId: "chat-1",
      payload: { accepted: true },
      idempotencyKey: `dispatch:${dispatchKey}:accepted`,
    });
    outbox.markDelivered(acceptedId, { messageId: "om-progress-card" });
    outbox.markSent(acceptedId);
    const reporter = new DirectProgressReporter({
      outbox,
      dispatchIdempotencyKey: dispatchKey,
      appRole: "claude",
      receiveId: "chat-1",
      provider: "claude",
    });

    try {
      reporter.start();
      const first = outbox.message(`outbox:${dispatchKey}:progress:1`);
      expect(first).toMatchObject({
        operation: "update",
        targetMessageId: "om-progress-card",
      });

      const replacementCharacter = String.fromCodePoint(0xfffd);
      reporter.onEvent({ type: "delta", text: "阶段结果：请求总量正在汇总" });
      reporter.onEvent({ type: "delta", text: `损坏${replacementCharacter}片段` });
      vi.advanceTimersByTime(2_000);
      reporter.onEvent({
        type: "progress",
        stage: "tool",
        message: "正在查询 Kusto",
        query: "SECRET QUERY MUST NOT LEAK",
      });

      const second = outbox.message(`outbox:${dispatchKey}:progress:2`);
      const secondPayload = JSON.stringify(second?.payload);
      expect(second).toMatchObject({ targetMessageId: "om-progress-card" });
      expect(secondPayload).toContain("正在查询 Kusto");
      expect(secondPayload).toContain("阶段结果：请求总量正在汇总");
      expect(secondPayload).not.toContain("SECRET QUERY MUST NOT LEAK");
      expect(secondPayload).not.toContain(`损坏${replacementCharacter}片段`);

      vi.advanceTimersByTime(15_000);
      const heartbeat = outbox.message(`outbox:${dispatchKey}:progress:3`);
      expect(JSON.stringify(heartbeat?.payload)).toMatch(/已运行.*15 秒/);

      reporter.complete();
      const completed = outbox.message(`outbox:${dispatchKey}:progress:4`);
      expect(JSON.stringify(completed?.payload)).toContain("处理完成");
      expect(completed).toMatchObject({ targetMessageId: "om-progress-card" });
    } finally {
      reporter.stop();
      outbox.close();
    }
  });
});
