import { describe, expect, it } from "vitest";

import {
  completeDiscussionTurn,
  createDiscussion,
  nextDiscussionProvider,
  shouldSummarize,
  transitionDiscussion,
} from "../../packages/domain/src/discussion.js";

describe("group discussion state", () => {
  it("rotates the first speaker across three automatic rounds", () => {
    let discussion = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Which design is safer?",
      starterPrincipalId: "tenant-1:user:owner",
      now: "2026-07-18T00:00:00.000Z",
    });

    const speakers: string[] = [];
    for (let turn = 0; turn < 9; turn += 1) {
      const provider = nextDiscussionProvider(discussion);
      speakers.push(provider);
      discussion = completeDiscussionTurn(discussion, {
        provider,
        continueDiscussion: true,
        now: `2026-07-18T00:00:0${turn + 1}.000Z`,
      });
    }

    expect(speakers).toEqual([
      "claude", "codex", "copilot",
      "codex", "copilot", "claude",
      "copilot", "claude", "codex",
    ]);
    expect(discussion.turnIndex).toBe(9);
    expect(discussion.round).toBe(3);
  });

  it("uses a steer preference for the next turn and then returns to rotation", () => {
    const discussion = {
      ...createDiscussion({
        id: "discussion-1",
        topicId: "topic-1",
        tenantKey: "tenant-1",
        chatId: "chat-1",
        question: "Question",
        starterPrincipalId: "tenant-1:user:owner",
      }),
      preferredProvider: "copilot" as const,
    };

    expect(nextDiscussionProvider(discussion)).toBe("copilot");
    const completed = completeDiscussionTurn(discussion, {
      provider: "copilot",
      continueDiscussion: true,
    });
    expect(completed.preferredProvider).toBeUndefined();
    expect(nextDiscussionProvider(completed)).toBe("codex");
  });

  it("summarizes on unanimous convergence or the round limit", () => {
    expect(shouldSummarize([false, false, false], 1, 3)).toBe(true);
    expect(shouldSummarize([false, true, false], 1, 3)).toBe(false);
    expect(shouldSummarize([true, true, true], 3, 3)).toBe(true);
    expect(shouldSummarize([false, false], 3, 3)).toBe(false);
  });

  it("allows only legal pause, resume, summarize, and stop transitions", () => {
    const active = createDiscussion({
      id: "discussion-1",
      topicId: "topic-1",
      tenantKey: "tenant-1",
      chatId: "chat-1",
      question: "Question",
      starterPrincipalId: "tenant-1:user:owner",
    });
    const paused = transitionDiscussion(active, "pause");
    expect(paused.state).toBe("paused");
    expect(transitionDiscussion(paused, "resume").state).toBe("active");
    expect(transitionDiscussion(paused, "summarize").state).toBe("summarizing");
    expect(transitionDiscussion(active, "stop").state).toBe("stopped");
    expect(() => transitionDiscussion(active, "resume")).toThrow(/cannot resume.*active/i);
    expect(() => transitionDiscussion({ ...active, state: "completed" }, "pause"))
      .toThrow(/terminal/i);
  });
});
