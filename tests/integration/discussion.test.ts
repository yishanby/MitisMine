import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  AdapterRegistry,
  AgentAdapter,
  AgentTask,
  ProviderName,
  ResumeAgentTask,
} from "../../packages/agent-adapters/src/index.js";
import { createDiscussion } from "../../packages/domain/src/discussion.js";
import { createTopic } from "../../packages/domain/src/topic.js";
import { DiscussionCoordinator } from "../../packages/orchestrator/src/discussion.js";
import { parseDiscussionAgentOutput } from "../../packages/orchestrator/src/discussion.js";
import { SqliteDiscussionStore } from "../../packages/storage/src/discussion.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function harness(adapters: AdapterRegistry) {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-discussion-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "discussion.db");
  const events = EventStore.open(path);
  const discussions = SqliteDiscussionStore.open(path);
  const outbox = DurableOutbox.open(path);
  const topic = createTopic("Visible group", "tenant-1:user:owner", { id: "topic-1" });
  events.append({ topicId: topic.id, type: "topic.created", payload: { topic } });
  const discussion = {
    ...createDiscussion({
      id: "discussion-1",
      topicId: topic.id,
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Choose the safer architecture",
      starterPrincipalId: topic.ownerPrincipalId,
      now: "2026-07-18T01:00:00.000Z",
    }),
    controlMessageId: "control-message-1",
  };
  discussions.createDiscussion(discussion);
  let nextId = 0;
  const coordinator = new DiscussionCoordinator({
    store: discussions,
    events,
    outbox,
    adapters,
    workspaceRoot: directory,
    idFactory: () => `generated-${++nextId}`,
  });
  return { directory, events, discussions, outbox, topic, discussion, coordinator };
}

function deterministicAdapter(
  provider: ProviderName,
  prompts: string[] = [],
  invoke?: (task: AgentTask | ResumeAgentTask) => Promise<string>,
): AgentAdapter {
  const call = async (task: AgentTask | ResumeAgentTask) => {
    prompts.push(task.prompt);
    const text = invoke === undefined
      ? task.prompt.includes("PHASE: discussion_summary")
        ? JSON.stringify({ summary: "The group reached a bounded conclusion." })
        : JSON.stringify({
            message: `${provider} visible opinion`,
            continueDiscussion: false,
            openQuestions: [],
          })
      : await invoke(task);
    return {
      provider,
      externalSessionId: `${provider}-external-session`,
      events: [{ type: "final" as const, text }],
    };
  };
  return { provider, start: call, resume: call };
}

describe("DiscussionCoordinator", () => {
  it("posts one visible round through three App identities and then summarizes", async () => {
    const adapters: AdapterRegistry = {
      claude: deterministicAdapter("claude"),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    };
    const test = harness(adapters);
    try {
      await test.coordinator.run(test.discussion.id);

      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("completed");
      expect(test.discussions.turns(test.discussion.id).map((turn) => turn.provider)).toEqual([
        "claude", "codex", "copilot",
      ]);
      const visible = test.outbox.pending("2099-01-01T00:00:00.000Z")
        .filter((message) => message.id.includes(":visible:") || message.id.includes(":summary:"));
      expect(visible.map((message) => message.appRole)).toEqual([
        "claude", "codex", "copilot", "hub",
      ]);
      expect(visible.map((message) => JSON.stringify(message.payload))).toEqual([
        expect.stringContaining("claude visible opinion"),
        expect.stringContaining("codex visible opinion"),
        expect.stringContaining("copilot visible opinion"),
        expect.stringContaining("bounded conclusion"),
      ]);
      for (const provider of ["claude", "codex", "copilot"] as const) {
        expect(test.events.agentSession(
          test.topic.id,
          provider,
          `discussion:${test.discussion.id}`,
        )?.externalSessionId).toBe(`${provider}-external-session`);
      }
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("delivers steer arriving during one turn to the next Agent", async () => {
    let releaseClaude: (() => void) | undefined;
    const claudeBlocked = new Promise<void>((resolve) => { releaseClaude = resolve; });
    let claudeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { claudeStarted = resolve; });
    const codexPrompts: string[] = [];
    const adapters: AdapterRegistry = {
      claude: deterministicAdapter("claude", [], async () => {
        claudeStarted?.();
        await claudeBlocked;
        return JSON.stringify({
          message: "Claude first",
          continueDiscussion: false,
          openQuestions: [],
        });
      }),
      codex: deterministicAdapter("codex", codexPrompts),
      copilot: deterministicAdapter("copilot"),
    };
    const test = harness(adapters);
    const running = test.coordinator.run(test.discussion.id);
    try {
      await started;
      const event = test.events.append({
        topicId: test.topic.id,
        type: "discussion.steer.added",
        actorPrincipalId: "tenant-1:user:member",
        payload: { text: "Prioritize migration cost" },
      });
      test.discussions.recordSteer({
        id: "steer-1",
        discussionId: test.discussion.id,
        messageId: "message-steer-1",
        topicEventSeq: event.seq,
        principalId: "tenant-1:user:member",
        text: "Prioritize migration cost",
      });
      releaseClaude?.();
      await running;

      expect(codexPrompts[0]).toContain("Prioritize migration cost");
      expect(test.discussions.pendingSteers(test.discussion.id)).toEqual([]);
    } finally {
      releaseClaude?.();
      await running.catch(() => {});
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("stops at three rounds when Agents keep requesting more discussion", async () => {
    const continuing = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) =>
      task.prompt.includes("PHASE: discussion_summary")
        ? JSON.stringify({ summary: "Round limit summary" })
        : JSON.stringify({
            message: `${provider} wants another round`,
            continueDiscussion: true,
            openQuestions: ["Still open"],
          }),
    );
    const test = harness({
      claude: continuing("claude"),
      codex: continuing("codex"),
      copilot: continuing("copilot"),
    });
    try {
      await test.coordinator.run(test.discussion.id);
      expect(test.discussions.turns(test.discussion.id)).toHaveLength(9);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        round: 3,
        turnIndex: 9,
      });
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("coalesces duplicate runs but allows different Discussions to overlap", async () => {
    let active = 0;
    let maximumActive = 0;
    const releases: Array<() => void> = [];
    const starts: string[] = [];
    const blockedTopics = new Set<string>();
    const blocking = (provider: ProviderName): AgentAdapter => ({
      provider,
      start: async (task) => {
        starts.push(task.topicId);
        if (!blockedTopics.has(task.topicId)) {
          blockedTopics.add(task.topicId);
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active -= 1;
        }
        return {
          provider,
          externalSessionId: `${provider}-${task.topicId}`,
          events: [{
            type: "final",
            text: JSON.stringify({
              message: `${provider} done`,
              continueDiscussion: false,
              openQuestions: [],
            }),
          }],
        };
      },
      resume: async (task) => ({
        provider,
        externalSessionId: task.externalSessionId,
        events: [{ type: "final", text: JSON.stringify({ summary: "done" }) }],
      }),
    });
    const test = harness({
      claude: blocking("claude"),
      codex: blocking("codex"),
      copilot: blocking("copilot"),
    });
    const secondTopic = createTopic("Second", "tenant-1:user:owner", { id: "topic-2" });
    test.events.append({ topicId: secondTopic.id, type: "topic.created", payload: { topic: secondTopic } });
    const second = {
      ...createDiscussion({
        id: "discussion-2",
        topicId: secondTopic.id,
        tenantKey: "tenant-1",
        chatId: "chat-2",
        question: "Second question",
        starterPrincipalId: secondTopic.ownerPrincipalId,
      }),
      controlMessageId: "control-2",
    };
    test.discussions.createDiscussion(second);
    const firstRun = test.coordinator.run(test.discussion.id);
    const duplicateRun = test.coordinator.run(test.discussion.id);
    const secondRun = test.coordinator.run(second.id);
    try {
      for (let attempt = 0; attempt < 100 && starts.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      expect(firstRun).toBe(duplicateRun);
      expect(starts.sort()).toEqual(["topic-1", "topic-2"]);
      expect(maximumActive).toBe(2);
    } finally {
      while (releases.length > 0) releases.shift()?.();
      await test.coordinator.shutdown();
      await Promise.allSettled([firstRun, secondRun]);
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("pauses after a full round with fewer than two successful Agents", async () => {
    const failing = (provider: ProviderName): AgentAdapter => ({
      provider,
      start: async () => { throw new Error(`${provider} unavailable`); },
      resume: async () => { throw new Error(`${provider} unavailable`); },
    });
    const test = harness({
      claude: failing("claude"),
      codex: failing("codex"),
      copilot: failing("copilot"),
    });
    try {
      await test.coordinator.run(test.discussion.id);
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("paused");
      expect(test.discussions.turns(test.discussion.id).map((turn) => turn.state)).toEqual([
        "failed", "failed", "failed",
      ]);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("reconciles a completed provider call after a crash without calling that Agent again", async () => {
    let claudeCalls = 0;
    const test = harness({
      claude: deterministicAdapter("claude", [], async () => {
        claudeCalls += 1;
        return JSON.stringify({ message: "duplicate", continueDiscussion: false, openQuestions: [] });
      }),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    });
    try {
      test.discussions.claimTurn({
        id: "turn-before-crash",
        discussionId: test.discussion.id,
        provider: "claude",
        round: 1,
        turnIndex: 0,
        startedAt: "2026-07-18T01:01:00.000Z",
      });
      test.discussions.saveDiscussion({
        ...test.discussion,
        activeTurnId: "turn-before-crash",
        version: 1,
      });
      test.discussions.recordSteer({
        id: "steer-before-crash",
        discussionId: test.discussion.id,
        messageId: "message-before-crash",
        topicEventSeq: 1,
        principalId: "tenant-1:user:member",
        text: "consider migration cost",
        createdAt: "2026-07-18T01:01:30.000Z",
      });
      test.discussions.completeTurn({
        id: "turn-before-crash",
        externalSessionId: "claude-before-crash",
        text: "Claude durable answer",
        continueDiscussion: false,
        openQuestions: [],
        completedAt: "2026-07-18T01:02:00.000Z",
      });

      await test.coordinator.run(test.discussion.id);

      expect(claudeCalls).toBe(0);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        turnIndex: 3,
      });
      expect(test.discussions.pendingSteers(test.discussion.id)).toEqual([]);
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .toContain("Claude durable answer");
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("falls back to visible text when an Agent does not return JSON", () => {
    expect(parseDiscussionAgentOutput("A plain but useful response")).toEqual({
      message: "A plain but useful response",
      continueDiscussion: true,
      openQuestions: [],
    });
  });

  it("cancels an active turn on pause and resumes the same speaker slot", async () => {
    let first = true;
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const claude: AgentAdapter = {
      provider: "claude",
      start: async (task) => {
        if (first) {
          first = false;
          started?.();
          return new Promise((resolve, reject) => {
            task.signal?.addEventListener("abort", () => reject(new Error("paused")), { once: true });
            void resolve;
          });
        }
        return {
          provider: "claude",
          externalSessionId: "claude-resumed-slot",
          events: [{
            type: "final",
            text: JSON.stringify({ message: "Claude resumed", continueDiscussion: false, openQuestions: [] }),
          }],
        };
      },
      resume: async () => { throw new Error("unexpected external resume"); },
    };
    const test = harness({
      claude,
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    });
    const running = test.coordinator.run(test.discussion.id);
    try {
      await firstStarted;
      await test.coordinator.control(
        test.discussion.id,
        "pause",
        "tenant-1:user:member",
      );
      await running.catch(() => {});
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("paused");
      expect(test.discussions.turns(test.discussion.id)).toEqual([
        expect.objectContaining({ provider: "claude", turnIndex: 0, state: "cancelled" }),
      ]);

      await test.coordinator.control(
        test.discussion.id,
        "resume",
        "tenant-1:user:member",
      );
      await test.coordinator.waitForIdle(test.discussion.id);
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("completed");
      expect(test.discussions.turns(test.discussion.id).map((turn) => [turn.provider, turn.state]))
        .toEqual([
          ["claude", "completed"],
          ["codex", "completed"],
          ["copilot", "completed"],
        ]);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("allows any participant to summarize but only the starter or Topic owner to stop", async () => {
    const test = harness({
      claude: deterministicAdapter("claude"),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    });
    try {
      await expect(test.coordinator.control(
        test.discussion.id,
        "stop",
        "tenant-1:user:member",
      )).rejects.toThrow(/starter|owner/i);

      await test.coordinator.control(
        test.discussion.id,
        "summarize",
        "tenant-1:user:member",
      );
      await test.coordinator.waitForIdle(test.discussion.id);
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("completed");
      expect(test.discussions.turns(test.discussion.id)).toEqual([]);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });
});
