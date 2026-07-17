import { describe, expect, it } from "vitest";

import {
  createQueuedRun,
  InvalidTransitionError,
  transition,
} from "../../packages/domain/src/run-machine.js";

function queuedRun() {
  return createQueuedRun({
    id: "run-1",
    topicId: "topic-1",
    question: "Question",
    coordinatorProvider: "claude",
    now: "2026-07-17T12:00:00.000Z",
  });
}

describe("ResearchRun state machine", () => {
  it("completes a consensus workflow", () => {
    let run = transition(queuedRun(), { type: "START" });
    run = transition(run, { type: "INDEPENDENT_COMPLETED" });
    run = transition(run, { type: "NORMALIZED" });
    run = transition(run, { type: "REVIEWED", openMediumHigh: 0 });
    run = transition(run, { type: "SYNTHESIZED" });
    run = transition(run, { type: "SIGNED_OFF", openMediumHigh: 0 });

    expect(run.state).toBe("completed");
    expect(run.round).toBe(1);
    expect(run.unresolved).toBe(false);
  });

  it("allows three rounds and then completes with unresolved disputes", () => {
    let run = transition(queuedRun(), { type: "START" });
    run = transition(run, { type: "INDEPENDENT_COMPLETED" });
    run = transition(run, { type: "NORMALIZED" });

    run = transition(run, { type: "REVIEWED", openMediumHigh: 2 });
    run = transition(run, { type: "RESOLUTION_COMPLETED" });
    run = transition(run, { type: "REVIEWED", openMediumHigh: 1 });
    run = transition(run, { type: "RESOLUTION_COMPLETED" });
    run = transition(run, { type: "REVIEWED", openMediumHigh: 1 });
    run = transition(run, { type: "SYNTHESIZED" });
    run = transition(run, { type: "SIGNED_OFF", openMediumHigh: 1 });

    expect(run.state).toBe("completed");
    expect(run.round).toBe(3);
    expect(run.unresolved).toBe(true);
  });

  it("rejects invalid transitions", () => {
    expect(() => transition(queuedRun(), { type: "NORMALIZED" })).toThrow(
      InvalidTransitionError,
    );
  });

  it("pauses and resumes the previous state", () => {
    const active = transition(queuedRun(), { type: "START" });
    const paused = transition(active, { type: "PAUSE" });
    expect(paused.state).toBe("paused");
    expect(transition(paused, { type: "RESUME" }).state).toBe(
      "independent_research",
    );
  });
});
