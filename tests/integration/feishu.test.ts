import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseCommand } from "../../packages/feishu/src/commands.js";
import {
  FeishuGateway,
  type DispatchInput,
  type FeishuMessageEvent,
} from "../../packages/feishu/src/gateway.js";
import { verifyCrossAppIdentity } from "../../packages/feishu/src/registry.js";
import { DurableOutbox } from "../../packages/storage/src/outbox.js";
import { EventStore } from "../../packages/storage/src/store.js";

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "mitismine-feishu-"));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, "test.db") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function message(
  appRole: FeishuMessageEvent["appRole"],
  text: string,
  eventId = `${appRole}-${text}`,
): FeishuMessageEvent {
  return {
    appRole,
    eventId,
    tenantKey: "tenant-1",
    userId: "user-1",
    unionId: "union-1",
    openId: `${appRole}-open-id`,
    messageId: `${eventId}-message`,
    chatId: `${appRole}-chat`,
    text,
  };
}

function gatewayHarness(path: string) {
  const store = EventStore.open(path);
  const outbox = DurableOutbox.open(path);
  const dispatches: DispatchInput[] = [];
  let nextId = 0;
  const gateway = new FeishuGateway({
    store,
    outbox,
    idFactory: () => `topic-${++nextId}`,
    dispatcher: {
      dispatch: async (input) => {
        dispatches.push(input);
      },
    },
  });
  return { store, outbox, gateway, dispatches };
}

describe("Feishu commands", () => {
  it.each([
    ["/topic new Research", "topic.new"],
    ["/topic list", "topic.list"],
    ["/topic use 01ABC", "topic.use"],
    ["/topic show", "topic.show"],
    ["/topic share tenant:user:two editor", "topic.share"],
    ["/topic archive", "topic.archive"],
    ["/note remember this", "note"],
    ["/research investigate", "research"],
    ["/status", "status"],
    ["/stop", "stop"],
    ["/report", "report"],
    ["/action write smoke/approved.txt hello", "action.write"],
    ["ordinary question", "message"],
  ])("parses %s", (text, kind) => {
    expect(parseCommand(text).kind).toBe(kind);
  });
});

describe("FeishuGateway", () => {
  it("shares a global Topic cursor across four app-specific open_ids", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);

    await harness.gateway.receive(message("hub", "/topic new Research"));
    await harness.gateway.receive(message("claude", "continue", "event-continue"));

    expect(harness.dispatches.at(-1)).toMatchObject({
      mode: "direct",
      provider: "claude",
      topicTitle: "Research",
      question: "continue",
    });
    expect(harness.store.currentTopic("tenant-1", "tenant-1:user:user-1")).toBe("topic-1");
    harness.store.close();
    harness.outbox.close();
  });

  it("routes ordinary hub messages to full research and persists before dispatch", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "Compare the evidence", "event-research"));

    const dispatch = harness.dispatches.at(-1);
    expect(dispatch).toMatchObject({ mode: "research", question: "Compare the evidence" });
    expect(harness.store.events(dispatch?.topicId ?? "").map((event) => event.type)).toEqual([
      "topic.created",
      "message.added",
    ]);
    harness.store.close();
    harness.outbox.close();
  });

  it("routes a privileged write as an approval action without executing it", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "/topic new Approval"));
    await harness.gateway.receive(
      message("hub", "/action write smoke/approved.txt approved", "event-action"),
    );

    expect(harness.dispatches.at(-1)).toMatchObject({
      mode: "action",
      action: {
        kind: "write_file",
        target: "smoke/approved.txt",
        parameters: { content: "approved" },
      },
    });
    harness.store.close();
    harness.outbox.close();
  });

  it("deduplicates events across restart and replays the durable Outbox", async () => {
    const { path } = temporaryDatabase();
    const first = gatewayHarness(path);
    const event = message("hub", "/topic new Durable", "same-event");
    expect((await first.gateway.receive(event)).duplicate).toBe(false);
    expect((await first.gateway.receive(event)).duplicate).toBe(true);
    expect(first.outbox.pending()).toHaveLength(1);
    first.store.close();
    first.outbox.close();

    const second = gatewayHarness(path);
    expect((await second.gateway.receive(event)).duplicate).toBe(true);
    expect(second.outbox.pending()).toHaveLength(1);
    second.store.close();
    second.outbox.close();
  });

  it("accepts the documented Feishu v2 fixture", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "tests/fixtures/feishu-message.json"), "utf8"),
    ) as unknown;

    await harness.gateway.receiveSdkEvent("hub", fixture);
    expect(harness.store.topic("topic-1")?.title).toBe("Fixture Research");
    harness.store.close();
    harness.outbox.close();
  });
});

describe("cross-App identity verification", () => {
  it("requires all four Apps to resolve to the same stable principal", () => {
    expect(
      verifyCrossAppIdentity([
        { appRole: "hub", tenantKey: "t", userId: "u" },
        { appRole: "claude", tenantKey: "t", userId: "u" },
        { appRole: "codex", tenantKey: "t", userId: "u" },
        { appRole: "copilot", tenantKey: "t", userId: "u" },
      ]),
    ).toBe("t:user:u");
    expect(() =>
      verifyCrossAppIdentity([
        { appRole: "hub", tenantKey: "t", userId: "u" },
        { appRole: "claude", tenantKey: "t", userId: "other" },
        { appRole: "codex", tenantKey: "t", userId: "u" },
        { appRole: "copilot", tenantKey: "t", userId: "u" },
      ]),
    ).toThrow(/identity mismatch/i);
  });
});
