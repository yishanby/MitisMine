import { describe, expect, it } from "vitest";

import { discussionCard } from "../../packages/feishu/src/cards.js";

function actions(card: ReturnType<typeof discussionCard>): string[] {
  return card.body.elements.flatMap((element) => {
    if (typeof element !== "object" || element === null || !("value" in element)) return [];
    const value = (element as { value?: { action?: unknown } }).value;
    return typeof value?.action === "string" ? [value.action] : [];
  });
}

describe("discussionCard", () => {
  it("renders active progress with pause, summarize, and stop controls", () => {
    const card = discussionCard({
      discussionId: "discussion-1",
      topicTitle: "Architecture",
      question: "Which design should we use?",
      state: "active",
      round: 2,
      maxRounds: 3,
      currentProvider: "codex",
      pendingSteers: 2,
      openQuestion: "Cost is unresolved",
      version: 7,
    });

    expect(JSON.stringify(card)).toContain("Architecture");
    expect(JSON.stringify(card)).toContain("Codex");
    expect(JSON.stringify(card)).toContain("2 / 3");
    expect(actions(card)).toEqual([
      "discussion.pause",
      "discussion.summarize",
      "discussion.stop",
    ]);
  });

  it("replaces pause with resume and removes controls in terminal states", () => {
    const base = {
      discussionId: "discussion-1",
      topicTitle: "Topic",
      question: "Question",
      round: 1,
      maxRounds: 3,
      pendingSteers: 0,
      version: 2,
    } as const;

    expect(actions(discussionCard({ ...base, state: "paused" }))).toEqual([
      "discussion.resume",
      "discussion.summarize",
      "discussion.stop",
    ]);
    expect(actions(discussionCard({ ...base, state: "summarizing" }))).toEqual([
      "discussion.stop",
    ]);
    expect(actions(discussionCard({ ...base, state: "completed" }))).toEqual([]);
    expect(actions(discussionCard({ ...base, state: "stopped" }))).toEqual([]);
  });

  it("puts only routing metadata in button values", () => {
    const card = discussionCard({
      discussionId: "discussion-1",
      topicTitle: "Topic",
      question: "Question",
      state: "active",
      round: 1,
      maxRounds: 3,
      pendingSteers: 0,
      version: 4,
    });
    const values = card.body.elements.flatMap((element) => {
      if (typeof element !== "object" || element === null || !("value" in element)) return [];
      return [(element as { value: unknown }).value];
    });

    expect(values).toEqual([
      { action: "discussion.pause", discussionId: "discussion-1", version: 4 },
      { action: "discussion.summarize", discussionId: "discussion-1", version: 4 },
      { action: "discussion.stop", discussionId: "discussion-1", version: 4 },
    ]);
    expect(JSON.stringify(values)).not.toMatch(/prompt|session|secret/i);
  });
});
