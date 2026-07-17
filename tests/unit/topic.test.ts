import { describe, expect, it } from "vitest";

import {
  archiveTopic,
  canEditTopic,
  canReadTopic,
  createTopic,
  resolvePrincipal,
} from "../../packages/domain/src/topic.js";

describe("resolvePrincipal", () => {
  it("uses tenant user_id across apps", () => {
    expect(
      resolvePrincipal({ tenantKey: "tenant", userId: "user", unionId: "union" }),
    ).toBe("tenant:user:user");
  });

  it("falls back to union_id when user_id is missing", () => {
    expect(resolvePrincipal({ tenantKey: "tenant", unionId: "union" })).toBe(
      "tenant:union:union",
    );
  });

  it("rejects app-local open_id as the only identity", () => {
    expect(() => resolvePrincipal({ tenantKey: "tenant" })).toThrow(
      /stable Feishu identity missing/,
    );
  });
});

describe("Topic lifecycle", () => {
  const owner = "tenant:user:owner";
  const editor = "tenant:user:editor";
  const viewer = "tenant:user:viewer";

  it("creates an active Topic owned by the principal", () => {
    const topic = createTopic("Research", owner, {
      id: "01JTESTTOPIC0000000000000",
      now: "2026-07-17T12:00:00.000Z",
    });

    expect(topic).toMatchObject({
      id: "01JTESTTOPIC0000000000000",
      title: "Research",
      ownerPrincipalId: owner,
      status: "active",
      createdAt: "2026-07-17T12:00:00.000Z",
      lastEventSeq: 0,
    });
  });

  it("allows owners and editors to edit but not viewers", () => {
    const topic = createTopic("Research", owner);
    const members = [
      { principalId: editor, role: "editor" as const },
      { principalId: viewer, role: "viewer" as const },
    ];

    expect(canEditTopic(topic, owner, members)).toBe(true);
    expect(canEditTopic(topic, editor, members)).toBe(true);
    expect(canEditTopic(topic, viewer, members)).toBe(false);
  });

  it("allows owners, editors, and viewers to read but not non-members", () => {
    const topic = createTopic("Research", owner);
    const members = [
      { principalId: editor, role: "editor" as const },
      { principalId: viewer, role: "viewer" as const },
    ];

    expect(canReadTopic(topic, owner, members)).toBe(true);
    expect(canReadTopic(topic, editor, members)).toBe(true);
    expect(canReadTopic(topic, viewer, members)).toBe(true);
    expect(canReadTopic(topic, "tenant:user:outsider", members)).toBe(false);
  });

  it("only lets an editor or owner archive an active Topic", () => {
    const topic = createTopic("Research", owner);
    const members = [{ principalId: viewer, role: "viewer" as const }];

    expect(() => archiveTopic(topic, viewer, members)).toThrow(/not allowed/);
    expect(archiveTopic(topic, owner, members).status).toBe("archived");
  });
});
