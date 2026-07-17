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

function messageFrom(
  userId: string,
  appRole: FeishuMessageEvent["appRole"],
  text: string,
  eventId: string,
): FeishuMessageEvent {
  return {
    ...message(appRole, text, eventId),
    userId,
    unionId: `union-${userId}`,
    openId: `${appRole}-${userId}-open-id`,
  };
}

function gatewayHarness(
  path: string,
  onDispatch: (input: DispatchInput) => Promise<void> = async () => {},
) {
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
        await onDispatch(input);
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
    ["/session new architecture", "session.new"],
    ["/session list", "session.list"],
    ["/session use 01ABC", "session.use"],
    ["/session resume 01ABC", "session.use"],
    ["/session show", "session.show"],
    ["/session rename evidence review", "session.rename"],
    ["/session archive", "session.archive"],
    ["/action write smoke/approved.txt hello", "action.write"],
    ["ordinary question", "message"],
  ])("parses %s", (text, kind) => {
    expect(parseCommand(text).kind).toBe(kind);
  });

  it.each([
    "/session new",
    "/session use",
    "/session resume",
    "/session rename",
  ])("rejects missing arguments in %s", (text) => {
    expect(() => parseCommand(text)).toThrow(/required/i);
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
      directSessionId: expect.any(String),
    });
    expect(harness.store.currentTopic("tenant-1", "tenant-1:user:user-1")).toBe("topic-1");
    harness.store.close();
    harness.outbox.close();
  });

  it("manages and routes multiple independent Sessions in a provider App", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    try {
      await harness.gateway.receive(message("hub", "/topic new Multi-session", "sessions-topic"));
      await harness.gateway.receive(message("claude", "/session new Architecture", "session-new-a"));
      const architecture = harness.store.currentDirectSession(
        "tenant-1", "tenant-1:user:user-1", "topic-1", "claude",
      );
      await harness.gateway.receive(message("claude", "/session new Evidence", "session-new-b"));
      const evidence = harness.store.currentDirectSession(
        "tenant-1", "tenant-1:user:user-1", "topic-1", "claude",
      );
      expect([architecture?.title, evidence?.title]).toEqual(["Architecture", "Evidence"]);

      await harness.gateway.receive(message("claude", "check sources", "session-message-b"));
      expect(harness.dispatches.at(-1)).toMatchObject({
        mode: "direct",
        provider: "claude",
        directSessionId: evidence?.id,
      });
      await harness.gateway.receive(message(
        "claude", `/session use ${architecture?.id.slice(0, 8)}`, "session-use-a",
      ));
      await harness.gateway.receive(message("claude", "/session rename System design", "session-rename"));
      await harness.gateway.receive(message("claude", "/session show", "session-show"));
      await harness.gateway.receive(message("claude", "/session list", "session-list"));
      expect(harness.store.currentDirectSession(
        "tenant-1", "tenant-1:user:user-1", "topic-1", "claude",
      )?.title).toBe("System design");

      await harness.gateway.receive(message("claude", "/session archive", "session-archive"));
      expect(harness.store.directSession(architecture?.id ?? "")?.status).toBe("archived");
      expect(harness.store.currentDirectSession(
        "tenant-1", "tenant-1:user:user-1", "topic-1", "claude",
      )?.id).toBe(evidence?.id);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("keeps current Session cursors independent by provider and lazily creates main", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    try {
      await harness.gateway.receive(message("hub", "/topic new Cursor scopes", "cursor-topic"));
      await harness.gateway.receive(message("claude", "claude turn", "cursor-claude"));
      await harness.gateway.receive(message("codex", "codex turn", "cursor-codex"));
      const principal = "tenant-1:user:user-1";
      const claude = harness.store.currentDirectSession("tenant-1", principal, "topic-1", "claude");
      const codex = harness.store.currentDirectSession("tenant-1", principal, "topic-1", "codex");
      expect(claude).toMatchObject({ title: "main", provider: "claude" });
      expect(codex).toMatchObject({ title: "main", provider: "codex" });
      expect(claude?.id).not.toBe(codex?.id);
      expect(harness.dispatches.map((dispatch) => dispatch.mode === "direct"
        ? dispatch.directSessionId
        : undefined)).toEqual([claude?.id, codex?.id]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("guides Hub users to a provider App for Session commands", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    try {
      await harness.gateway.receive(message("hub", "/topic new Hub boundary", "hub-session-topic"));
      await harness.gateway.receive(message("hub", "/session new Wrong place", "hub-session-command"));
      expect(harness.store.listDirectSessions("topic-1", "claude")).toEqual([]);
      expect(harness.dispatches).toEqual([]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("lets viewers list and select Sessions but blocks Session mutations and messages", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    try {
      await harness.gateway.receive(message("hub", "/topic new Shared Sessions", "session-view-topic"));
      await harness.gateway.receive(message("claude", "/session new Readable", "session-view-create"));
      await harness.gateway.receive({
        ...message("hub", "/topic share @_viewer viewer", "session-view-share"),
        mentions: [{ key: "@_viewer", userId: "viewer", unionId: "union-viewer" }],
      });
      await harness.gateway.receive(messageFrom(
        "viewer", "claude", "/topic use topic-1", "session-view-use-topic",
      ));
      await expect(harness.gateway.receive(messageFrom(
        "viewer", "claude", "/session list", "session-view-list",
      ))).resolves.toEqual({ duplicate: false });
      await expect(harness.gateway.receive(messageFrom(
        "viewer", "claude", "/session use Readable", "session-view-use",
      ))).resolves.toEqual({ duplicate: false });

      for (const [index, text] of [
        "/session new Blocked",
        "/session rename Blocked",
        "/session archive",
        "viewer cannot invoke the agent",
      ].entries()) {
        await expect(harness.gateway.receive(messageFrom(
          "viewer", "claude", text, `session-view-blocked-${index}`,
        ))).rejects.toThrow(/not allowed/i);
      }
      expect(harness.store.listDirectSessions("topic-1", "claude")).toHaveLength(1);
      expect(harness.dispatches).toEqual([]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("replays Session creation idempotently after a response crash", async () => {
    const { path } = temporaryDatabase();
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    let failSessionResponse = false;
    let nextId = 0;
    const gateway = new FeishuGateway({
      store,
      outbox: {
        enqueue: (input) => {
          const inserted = outbox.enqueue(input);
          if (failSessionResponse) {
            failSessionResponse = false;
            throw new Error("crash after Session response");
          }
          return inserted;
        },
      },
      dispatcher: { dispatch: async () => {} },
      idFactory: () => `id-${++nextId}`,
    });
    try {
      await gateway.receive(message("hub", "/topic new Durable Session", "durable-session-topic"));
      failSessionResponse = true;
      const event = message("claude", "/session new Durable", "durable-session-new");
      await expect(gateway.receive(event)).rejects.toThrow("crash after Session response");
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: false });
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: true });
      expect(store.listDirectSessions("id-1", "claude")).toHaveLength(1);

      failSessionResponse = true;
      const archive = message("claude", "/session archive", "durable-session-archive");
      await expect(gateway.receive(archive)).rejects.toThrow("crash after Session response");
      await expect(gateway.receive(archive)).resolves.toEqual({ duplicate: false });
      await expect(gateway.receive(archive)).resolves.toEqual({ duplicate: true });
      expect(store.listDirectSessions("id-1", "claude")).toEqual([
        expect.objectContaining({ title: "Durable", status: "archived" }),
      ]);
    } finally {
      store.close();
      outbox.close();
    }
  });

  it.each(["claude", "codex", "copilot"] as const)(
    "allows only read/navigation commands and ordinary direct messages in the %s App",
    async (appRole) => {
      const { path } = temporaryDatabase();
      const harness = gatewayHarness(path);
      try {
        await harness.gateway.receive(message("hub", "/topic new Routing", `${appRole}-setup`));
        await harness.gateway.receive(message(appRole, "/topic use topic-1", `${appRole}-use`));
        await harness.gateway.receive(message(appRole, "/topic show", `${appRole}-show`));
        await harness.gateway.receive(message(appRole, "/status", `${appRole}-status`));
        await harness.gateway.receive(message(appRole, "/report", `${appRole}-report`));
        await harness.gateway.receive(message(appRole, "continue directly", `${appRole}-direct`));

        expect(harness.dispatches).toEqual([
          expect.objectContaining({ mode: "control", action: "status", replyAppRole: appRole }),
          expect.objectContaining({ mode: "control", action: "report", replyAppRole: appRole }),
          expect.objectContaining({ mode: "direct", provider: appRole, replyAppRole: appRole }),
        ]);
      } finally {
        harness.store.close();
        harness.outbox.close();
      }
    },
  );

  it.each(["claude", "codex", "copilot"] as const)(
    "blocks every Hub-only command in the %s App without mutating the Topic",
    async (appRole) => {
      const { path } = temporaryDatabase();
      const harness = gatewayHarness(path);
      try {
        await harness.gateway.receive(message("hub", "/topic new Routing", `${appRole}-setup`));
        const watermark = harness.store.topic("topic-1")?.lastEventSeq;
        const forbidden = [
          "/topic new Forbidden",
          "/topic list",
          "/topic share tenant-1:user:other editor",
          "/topic archive",
          "/note forbidden",
          "/research forbidden",
          "/stop",
          "/action write forbidden.txt no",
        ];
        for (const [index, text] of forbidden.entries()) {
          await expect(harness.gateway.receive(
            message(appRole, text, `${appRole}-forbidden-${index}`),
          )).resolves.toEqual({ duplicate: false });
        }

        expect(harness.store.listTopics("tenant-1", "tenant-1:user:user-1")).toHaveLength(1);
        expect(harness.store.topic("topic-1")?.status).toBe("active");
        expect(harness.store.topic("topic-1")?.lastEventSeq).toBe(watermark);
        expect(harness.dispatches).toEqual([]);
      } finally {
        harness.store.close();
        harness.outbox.close();
      }
    },
  );

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

  it("resolves a Feishu @mention when sharing a Topic", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "/topic new Shared"));
    await harness.gateway.receive({
      ...message("hub", "/topic share @_user_1 editor", "event-share"),
      mentions: [{ key: "@_user_1", userId: "user-2", unionId: "union-2" }],
    });

    expect(harness.store.members("topic-1")).toContainEqual({
      principalId: "tenant-1:user:user-2",
      role: "editor",
    });
    harness.store.close();
    harness.outbox.close();
  });

  it("lets a viewer inspect a shared Topic but never append or dispatch mutations", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    await harness.gateway.receive(message("hub", "/topic new Shared read-only", "viewer-create"));
    await harness.gateway.receive({
      ...message("hub", "/topic share @_viewer viewer", "viewer-share"),
      mentions: [{ key: "@_viewer", userId: "viewer", unionId: "union-viewer" }],
    });
    await harness.gateway.receive(messageFrom("viewer", "hub", "/topic use topic-1", "viewer-use"));

    await harness.gateway.receive(messageFrom("viewer", "hub", "/topic show", "viewer-show"));
    await harness.gateway.receive(messageFrom("viewer", "hub", "/status", "viewer-status"));
    await harness.gateway.receive(messageFrom("viewer", "hub", "/report", "viewer-report"));
    expect(harness.dispatches.map((input) => input.mode === "control" ? input.action : input.mode)).toEqual([
      "status",
      "report",
    ]);

    const watermark = harness.store.topic("topic-1")?.lastEventSeq;
    const dispatchCount = harness.dispatches.length;
    const forbidden = [
      "/note cannot write",
      "cannot send ordinary messages",
      "/research cannot research",
      "/stop",
      "/action write blocked.txt nope",
      "/topic share tenant-1:user:other editor",
      "/topic archive",
    ];
    for (const [index, text] of forbidden.entries()) {
      await expect(
        harness.gateway.receive(messageFrom("viewer", "hub", text, `viewer-forbidden-${index}`)),
      ).rejects.toThrow(/not allowed/i);
    }

    expect(harness.store.topic("topic-1")?.lastEventSeq).toBe(watermark);
    expect(harness.dispatches).toHaveLength(dispatchCount);
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

  it("retries a failed dispatch and only deduplicates after success", async () => {
    const { path } = temporaryDatabase();
    let attempts = 0;
    const harness = gatewayHarness(path, async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("transient dispatch failure");
    });
    try {
      const event = message("hub", "Retry this research", "retry-event");

      await expect(harness.gateway.receive(event)).rejects.toThrow("transient dispatch failure");
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: false });
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: true });
      expect(attempts).toBe(2);
      expect(harness.store.listTopics("tenant-1", "tenant-1:user:user-1")).toHaveLength(1);
      expect(harness.store.events("topic-1").map((stored) => stored.type)).toEqual([
        "topic.created",
        "message.added",
      ]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("replays a route after the accepted response is durably enqueued", async () => {
    const { path } = temporaryDatabase();
    const store = EventStore.open(path);
    const outbox = DurableOutbox.open(path);
    let failAfterEnqueue = true;
    let nextId = 0;
    const gateway = new FeishuGateway({
      store,
      outbox: {
        enqueue: (input) => {
          const inserted = outbox.enqueue(input);
          if (failAfterEnqueue) {
            failAfterEnqueue = false;
            throw new Error("crash after accepted outbox");
          }
          return inserted;
        },
      },
      dispatcher: { dispatch: async () => {} },
      idFactory: () => `topic-${++nextId}`,
    });
    const event = message("hub", "/topic new Durable route", "outbox-crash-event");

    try {
      await expect(gateway.receive(event)).rejects.toThrow("crash after accepted outbox");
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: false });
      await expect(gateway.receive(event)).resolves.toEqual({ duplicate: true });
      expect(store.listTopics("tenant-1", "tenant-1:user:user-1")).toHaveLength(1);
      expect(outbox.pending()).toHaveLength(1);
    } finally {
      store.close();
      outbox.close();
    }
  });

  it("reuses the deterministic dispatch key after a checkpointed failure", async () => {
    const { path } = temporaryDatabase();
    let checkpointKey: string | undefined;
    let starts = 0;
    let resumes = 0;
    const harness = gatewayHarness(path, async (input) => {
      if (checkpointKey === undefined) {
        checkpointKey = input.idempotencyKey;
        starts += 1;
        throw new Error("crash after checkpoint");
      }
      expect(input.idempotencyKey).toBe(checkpointKey);
      resumes += 1;
    });
    const event = message("hub", "Checkpointed research", "checkpoint-event");

    try {
      await expect(harness.gateway.receive(event)).rejects.toThrow("crash after checkpoint");
      await expect(harness.gateway.receive(event)).resolves.toEqual({ duplicate: false });
      expect({ starts, resumes }).toEqual({ starts: 1, resumes: 1 });
      expect(harness.store.events("topic-1").map((stored) => stored.type)).toEqual([
        "topic.created",
        "message.added",
      ]);
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
  });

  it("does not claim an event when stable identity resolution fails", async () => {
    const { path } = temporaryDatabase();
    const harness = gatewayHarness(path);
    const corrected = message("hub", "/topic new Identity", "identity-event");
    const { userId: _userId, unionId: _unionId, ...missingIdentity } = corrected;

    try {
      await expect(harness.gateway.receive(missingIdentity)).rejects.toThrow(
        "stable Feishu identity missing",
      );
      await expect(harness.gateway.receive(corrected)).resolves.toEqual({ duplicate: false });
      expect(harness.store.topic("topic-1")?.title).toBe("Identity");
    } finally {
      harness.store.close();
      harness.outbox.close();
    }
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

  it("collects exactly one union identity observation from each App", async () => {
    const module = await import("../../packages/feishu/src/registry.js") as Record<string, unknown>;
    expect(typeof module.IdentityProbeCollector).toBe("function");
    const IdentityProbeCollector = module.IdentityProbeCollector as new () => {
      observe(input: {
        appRole: "hub" | "claude" | "codex" | "copilot";
        tenantKey: string;
        userId?: string;
        unionId?: string;
      }): void;
      readonly complete: boolean;
      document(): {
        observations: Array<{
          appRole: string;
          tenantKey: string;
          userId?: string;
          unionId?: string;
        }>;
      };
    };
    const collector = new IdentityProbeCollector();
    for (const appRole of ["hub", "claude", "codex", "copilot"] as const) {
      collector.observe({
        appRole,
        tenantKey: "tenant-1",
        userId: "app-visible-user",
        unionId: "on_same-user-across-apps",
      });
    }

    expect(collector.complete).toBe(true);
    expect(collector.document()).toEqual({
      observations: ["hub", "claude", "codex", "copilot"].map((appRole) => ({
        appRole,
        tenantKey: "tenant-1",
        unionId: "on_same-user-across-apps",
      })),
    });
  });

  it("builds bootstrap registrations without requiring existing identity observations", async () => {
    const module = await import("../../packages/feishu/src/registry.js") as Record<string, unknown>;
    expect(typeof module.identityProbeRegistrationsFromEnv).toBe("function");
    const fromEnv = module.identityProbeRegistrationsFromEnv as (
      env: Record<string, string | undefined>,
    ) => Array<{ role: string; appId: string; appSecret: string }>;

    expect(fromEnv({
      FEISHU_HUB_APP_ID: "hub-id",
      FEISHU_HUB_APP_SECRET: "hub-secret",
      FEISHU_CLAUDE_APP_ID: "claude-id",
      FEISHU_CLAUDE_APP_SECRET: "claude-secret",
      FEISHU_CODEX_APP_ID: "codex-id",
      FEISHU_CODEX_APP_SECRET: "codex-secret",
      FEISHU_COPILOT_APP_ID: "copilot-id",
      FEISHU_COPILOT_APP_SECRET: "copilot-secret",
    }).map(({ role, appId }) => ({ role, appId }))).toEqual([
      { role: "hub", appId: "hub-id" },
      { role: "claude", appId: "claude-id" },
      { role: "codex", appId: "codex-id" },
      { role: "copilot", appId: "copilot-id" },
    ]);
  });
});
