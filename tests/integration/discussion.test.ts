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
import {
  completeDiscussionTurn,
  createDiscussion,
  nextDiscussionProvider,
  type GroupDiscussion,
} from "../../packages/domain/src/discussion.js";
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

function harness(
  adapters: AdapterRegistry,
  onError?: (discussionId: string, error: unknown) => void,
) {
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
    ...(onError === undefined ? {} : { onError }),
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

  it("preserves a delivered control-card ID and a new speaker preference while a turn completes", async () => {
    let releaseClaude: (() => void) | undefined;
    const claudeBlocked = new Promise<void>((resolve) => { releaseClaude = resolve; });
    let claudeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { claudeStarted = resolve; });
    const adapters: AdapterRegistry = {
      claude: deterministicAdapter("claude", [], async () => {
        claudeStarted?.();
        await claudeBlocked;
        return JSON.stringify({ message: "Claude first", continueDiscussion: false, openQuestions: [] });
      }),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    };
    const test = harness(adapters);
    const { controlMessageId: _initialControlMessageId, ...withoutControlMessage } = test.discussion;
    test.discussions.saveDiscussion(withoutControlMessage);
    const running = test.coordinator.run(test.discussion.id);
    try {
      await started;
      test.discussions.recordControlMessage(test.discussion.id, "new-control-message");
      const event = test.events.append({
        topicId: test.topic.id,
        type: "discussion.steer.added",
        actorPrincipalId: "tenant-1:user:member",
        payload: { text: "Copilot should answer next" },
      });
      test.discussions.recordSteer({
        id: "steer-prefer-copilot",
        discussionId: test.discussion.id,
        messageId: "message-prefer-copilot",
        topicEventSeq: event.seq,
        principalId: "tenant-1:user:member",
        text: "Copilot should answer next",
        preferredProvider: "copilot",
      });
      releaseClaude?.();
      await running;

      expect(test.discussions.discussion(test.discussion.id)?.controlMessageId)
        .toBe("new-control-message");
      expect(test.discussions.turns(test.discussion.id).map(({ provider }) => provider))
        .toEqual(["claude", "copilot", "codex"]);
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
    const codexPrompts: string[] = [];
    const test = harness({
      claude: deterministicAdapter("claude", [], async () => {
        claudeCalls += 1;
        return JSON.stringify({ message: "duplicate", continueDiscussion: false, openQuestions: [] });
      }),
      codex: deterministicAdapter("codex", codexPrompts),
      copilot: deterministicAdapter("copilot"),
    });
    try {
      test.discussions.recordSteer({
        id: "steer-captured-before-crash",
        discussionId: test.discussion.id,
        messageId: "message-captured-before-crash",
        topicEventSeq: 1,
        principalId: "tenant-1:user:member",
        text: "captured in the turn prompt",
        createdAt: "2026-07-18T01:00:30.000Z",
      });
      test.discussions.claimTurn({
        id: "turn-before-crash",
        discussionId: test.discussion.id,
        provider: "claude",
        round: 1,
        turnIndex: 0,
        steerIds: ["steer-captured-before-crash"],
        startedAt: "2026-07-18T01:01:00.000Z",
      });
      test.discussions.saveDiscussion({
        ...test.discussion,
        activeTurnId: "turn-before-crash",
        version: 1,
      });
      test.discussions.recordSteer({
        id: "steer-unseen-before-crash",
        discussionId: test.discussion.id,
        messageId: "message-unseen-before-crash",
        topicEventSeq: 1,
        principalId: "tenant-1:user:member",
        text: "arrived during provider generation",
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
      expect(codexPrompts[0]).toContain("arrived during provider generation");
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .toContain("Claude durable answer");
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("re-evaluates an unevaluated failed round boundary after a crash", async () => {
    let calls = 0;
    const counting = (provider: ProviderName) => deterministicAdapter(provider, [], async () => {
      calls += 1;
      return JSON.stringify({ message: "must not run", continueDiscussion: true, openQuestions: [] });
    });
    const test = harness({
      claude: counting("claude"),
      codex: counting("codex"),
      copilot: counting("copilot"),
    });
    try {
      let discussion: GroupDiscussion = test.discussion;
      for (let index = 0; index < 3; index += 1) {
        const provider = nextDiscussionProvider(discussion);
        const turnId = `crashed-round-turn-${index}`;
        test.discussions.claimTurn({
          id: turnId,
          discussionId: discussion.id,
          provider,
          round: discussion.round,
          turnIndex: discussion.turnIndex,
        });
        if (index === 0) {
          test.discussions.completeTurn({
            id: turnId,
            externalSessionId: `${provider}-external`,
            text: `${provider} completed`,
            continueDiscussion: true,
            openQuestions: [],
          });
        } else {
          test.discussions.failTurn(turnId, "failed");
        }
        discussion = completeDiscussionTurn(discussion, {
          provider,
          continueDiscussion: true,
        });
      }
      test.discussions.saveDiscussion(discussion);

      await test.coordinator.run(test.discussion.id);

      expect(calls).toBe(0);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "paused",
        turnIndex: 3,
      });
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("re-evaluates the round limit at turn nine after a crash", async () => {
    let turnCalls = 0;
    const adapter = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) => {
      if (!task.prompt.includes("PHASE: discussion_summary")) turnCalls += 1;
      return task.prompt.includes("PHASE: discussion_summary")
        ? JSON.stringify({ summary: "Recovered round-limit summary" })
        : JSON.stringify({ message: "must not run", continueDiscussion: true, openQuestions: [] });
    });
    const test = harness({
      claude: adapter("claude"),
      codex: adapter("codex"),
      copilot: adapter("copilot"),
    });
    try {
      let discussion: GroupDiscussion = test.discussion;
      for (let index = 0; index < 9; index += 1) {
        const provider = nextDiscussionProvider(discussion);
        const turnId = `crashed-limit-turn-${index}`;
        test.discussions.claimTurn({
          id: turnId,
          discussionId: discussion.id,
          provider,
          round: discussion.round,
          turnIndex: discussion.turnIndex,
        });
        test.discussions.completeTurn({
          id: turnId,
          externalSessionId: `${provider}-external`,
          text: `${provider} completed`,
          continueDiscussion: true,
          openQuestions: [],
        });
        discussion = completeDiscussionTurn(discussion, {
          provider,
          continueDiscussion: true,
        });
      }
      test.discussions.saveDiscussion(discussion);

      await test.coordinator.run(test.discussion.id);

      expect(turnCalls).toBe(0);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        turnIndex: 9,
        summaryText: "Recovered round-limit summary",
      });
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

  it.each([
    ["raw text", (replacementCharacter: string) => `Corrupt ${replacementCharacter} response`],
    ["message", (replacementCharacter: string) => JSON.stringify({
      message: `Corrupt ${replacementCharacter} response`,
      continueDiscussion: true,
      openQuestions: [],
    }).replace(replacementCharacter, "\\ufffd")],
    ["open question", (replacementCharacter: string) => JSON.stringify({
      message: "Clean response",
      continueDiscussion: true,
      openQuestions: [`Corrupt ${replacementCharacter} question`],
    }).replace(replacementCharacter, "\\ufffd")],
  ])("rejects invalid Unicode in Discussion Agent %s", (_case, response) => {
    expect(() => parseDiscussionAgentOutput(response(String.fromCodePoint(0xfffd))))
      .toThrow(/invalid Unicode.*provider output/i);
  });

  it("rejects decoded invalid Unicode before falling back from an invalid Agent contract", () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const response = JSON.stringify({
      message: `Corrupt ${replacementCharacter} response`,
      continueDiscussion: "yes",
      openQuestions: [],
    }).replace(replacementCharacter, "\\ufffd");

    expect(() => parseDiscussionAgentOutput(response))
      .toThrow(/invalid Unicode.*provider output/i);
  });

  it.each([
    ["JSON string", (replacementCharacter: string) =>
      JSON.stringify(`Corrupt ${replacementCharacter} response`)
        .replace(replacementCharacter, "\\ufffd")],
    ["JSON array", (replacementCharacter: string) =>
      JSON.stringify([`Corrupt ${replacementCharacter} response`])
        .replace(replacementCharacter, "\\ufffd")],
  ])("rejects invalid Unicode decoded from an Agent %s", (_case, response) => {
    expect(() => parseDiscussionAgentOutput(response(String.fromCodePoint(0xfffd))))
      .toThrow(/invalid Unicode.*provider output/i);
  });

  it("parses an Agent contract wrapped in a JSON markdown fence", () => {
    expect(parseDiscussionAgentOutput(`\`\`\`json
{"message":"Structured response","continueDiscussion":false,"openQuestions":["One risk"]}
\`\`\``)).toEqual({
      message: "Structured response",
      continueDiscussion: false,
      openQuestions: ["One risk"],
    });
  });

  it("cancels an active turn and resumes immediately in the same speaker slot", async () => {
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
    const firstLoopSettled = running.catch(() => {});
    try {
      await firstStarted;
      await test.coordinator.control(
        test.discussion.id,
        "pause",
        "tenant-1:user:member",
      );
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("paused");

      await test.coordinator.control(
        test.discussion.id,
        "resume",
        "tenant-1:user:member",
      );
      await firstLoopSettled;
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

  it("keeps summarize state when a kicked active turn is cancelled", async () => {
    let started: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const claude: AgentAdapter = {
      provider: "claude",
      start: async (task) => {
        if (first) {
          first = false;
          started?.();
          return new Promise((resolve, reject) => {
            task.signal?.addEventListener("abort", () => reject(new Error("summarize now")), { once: true });
            void resolve;
          });
        }
        expect(task.prompt).toContain("PHASE: discussion_summary");
        return {
          provider: "claude",
          externalSessionId: "claude-summary",
          events: [{ type: "final", text: JSON.stringify({ summary: "Immediate summary" }) }],
        };
      },
      resume: async () => { throw new Error("unexpected resume"); },
    };
    const errors: unknown[] = [];
    const test = harness({
      claude,
      codex: deterministicAdapter("codex", [], async () => { throw new Error("Codex must not run"); }),
      copilot: deterministicAdapter("copilot", [], async () => { throw new Error("Copilot must not run"); }),
    }, (_discussionId, error) => { errors.push(error); });
    test.coordinator.kick(test.discussion.id);
    try {
      await firstStarted;
      await test.coordinator.control(
        test.discussion.id,
        "summarize",
        "tenant-1:user:member",
      );
      await test.coordinator.waitForIdle(test.discussion.id);

      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        turnIndex: 0,
      });
      expect(test.discussions.discussion(test.discussion.id)?.activeTurnId).toBeUndefined();
      expect(test.discussions.turns(test.discussion.id)).toEqual([
        expect.objectContaining({ provider: "claude", state: "cancelled", turnIndex: 0 }),
      ]);
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .toContain("Immediate summary");
      expect(errors).toEqual([]);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("pauses a kicked Discussion after an unexpected summarizing failure", async () => {
    const errors: unknown[] = [];
    const test = harness({
      claude: deterministicAdapter("claude"),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    }, (_discussionId, error) => { errors.push(error); });
    const originalTurns = test.discussions.turns.bind(test.discussions);
    let summarizingReads = 0;
    test.discussions.turns = (discussionId: string) => {
      if (test.discussions.discussion(discussionId)?.state === "summarizing") {
        summarizingReads += 1;
        if (summarizingReads === 2) throw new Error("unexpected summary storage failure");
      }
      return originalTurns(discussionId);
    };
    try {
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);

      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("paused");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toEqual(expect.objectContaining({
        message: "unexpected summary storage failure",
      }));
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("extracts a final summary wrapped in a JSON markdown fence", async () => {
    const fencedSummary = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) => {
      expect(task.prompt).toContain("PHASE: discussion_summary");
      return `\`\`\`json\n{"summary":"Fenced final summary"}\n\`\`\``;
    });
    const test = harness({
      claude: fencedSummary("claude"),
      codex: fencedSummary("codex"),
      copilot: fencedSummary("copilot"),
    });
    try {
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);

      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        summaryText: "Fenced final summary",
      });
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .not.toContain("```json");
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("falls through from an invalid-Unicode summary to the next clean provider", async () => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const attempts: ProviderName[] = [];
    const summaryAdapter = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) => {
      expect(task.prompt).toContain("PHASE: discussion_summary");
      attempts.push(provider);
      if (provider === "claude") {
        return JSON.stringify({ summary: `Corrupt ${replacementCharacter} summary` })
          .replace(replacementCharacter, "\\ufffd");
      }
      if (provider === "codex") return JSON.stringify({ summary: "Clean fallback summary" });
      throw new Error("Copilot must not run after a clean fallback");
    });
    const test = harness({
      claude: summaryAdapter("claude"),
      codex: summaryAdapter("codex"),
      copilot: summaryAdapter("copilot"),
    });
    try {
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);

      expect(attempts).toEqual(["claude", "codex"]);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        summaryText: "Clean fallback summary",
      });
      const published = JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z"));
      expect(published).toContain("Clean fallback summary");
      expect(published).not.toContain(replacementCharacter);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it.each([
    ["JSON string", (replacementCharacter: string) =>
      JSON.stringify(`Corrupt ${replacementCharacter} summary`)
        .replace(replacementCharacter, "\\ufffd")],
    ["JSON array", (replacementCharacter: string) =>
      JSON.stringify([`Corrupt ${replacementCharacter} summary`])
        .replace(replacementCharacter, "\\ufffd")],
  ])("falls through from an invalid-Unicode %s summary", async (_case, corruptSummary) => {
    const replacementCharacter = String.fromCodePoint(0xfffd);
    const attempts: ProviderName[] = [];
    const summaryAdapter = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) => {
      expect(task.prompt).toContain("PHASE: discussion_summary");
      attempts.push(provider);
      if (provider === "claude") return corruptSummary(replacementCharacter);
      if (provider === "codex") return JSON.stringify({ summary: "Clean decoded fallback" });
      throw new Error("Copilot must not run after a clean fallback");
    });
    const test = harness({
      claude: summaryAdapter("claude"),
      codex: summaryAdapter("codex"),
      copilot: summaryAdapter("copilot"),
    });
    try {
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);

      expect(attempts).toEqual(["claude", "codex"]);
      expect(test.discussions.discussion(test.discussion.id)).toMatchObject({
        state: "completed",
        summaryText: "Clean decoded fallback",
      });
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .not.toContain(replacementCharacter);
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("pauses after all summary providers fail and lets a participant retry", async () => {
    let allowSummary = false;
    const attempts: ProviderName[] = [];
    const summaryAdapter = (provider: ProviderName) => deterministicAdapter(provider, [], async (task) => {
      expect(task.prompt).toContain("PHASE: discussion_summary");
      attempts.push(provider);
      if (!allowSummary) throw new Error(`${provider} summary unavailable`);
      return JSON.stringify({ summary: "Summary retry succeeded" });
    });
    const test = harness({
      claude: summaryAdapter("claude"),
      codex: summaryAdapter("codex"),
      copilot: summaryAdapter("copilot"),
    });
    try {
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);
      expect(attempts).toEqual(["claude", "codex", "copilot"]);
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("paused");

      allowSummary = true;
      await test.coordinator.control(test.discussion.id, "summarize", "tenant-1:user:member");
      await test.coordinator.waitForIdle(test.discussion.id);
      expect(test.discussions.discussion(test.discussion.id)?.state).toBe("completed");
      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .toContain("Summary retry succeeded");
    } finally {
      await test.coordinator.shutdown();
      test.discussions.close();
      test.events.close();
      test.outbox.close();
    }
  });

  it("recreates a missing final-summary effect from durable completed state", async () => {
    const test = harness({
      claude: deterministicAdapter("claude"),
      codex: deterministicAdapter("codex"),
      copilot: deterministicAdapter("copilot"),
    });
    try {
      test.discussions.saveDiscussion({
        ...test.discussion,
        state: "completed",
        summaryText: "Durable summary after crash",
        version: 1,
      });

      await test.coordinator.run(test.discussion.id);

      expect(JSON.stringify(test.outbox.pending("2099-01-01T00:00:00.000Z")))
        .toContain("Durable summary after crash");
      expect(test.events.events(test.topic.id).map(({ type }) => type))
        .toContain("discussion.completed");
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
