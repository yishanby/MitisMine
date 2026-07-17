import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("operational tooling", () => {
  it("derives live audit database and approval paths from independent environment settings", async () => {
    const module = await import("../../scripts/live-smoke.js").catch(() => ({})) as Record<string, unknown>;
    expect(typeof module.resolveLiveSmokePaths).toBe("function");
    const resolvePaths = module.resolveLiveSmokePaths as (
      env: Record<string, string | undefined>,
      cwd: string,
    ) => { databasePath: string; approvedPath: string };
    const cwd = join(process.cwd(), "synthetic-root");

    expect(resolvePaths({
      MITISMINE_DB_PATH: "state/custom.db",
      MITISMINE_DATA_DIR: "runtime-data",
    }, cwd)).toEqual({
      databasePath: join(cwd, "state/custom.db"),
      approvedPath: join(cwd, "runtime-data/approved-actions/smoke/approved.txt"),
    });
  });

  it("counts cross-reviews without treating two signoff reviews as an invalid round", async () => {
    const module = await import("../../scripts/live-smoke.js") as Record<string, unknown>;
    expect(typeof module.countCrossReviews).toBe("function");
    const count = module.countCrossReviews as (
      reviews: Array<{ approved?: boolean }>,
    ) => number;

    expect(count([
      {}, {}, {}, {}, {}, {},
      { approved: true }, { approved: false },
    ])).toBe(6);
  });

  it("decodes quoted dotenv values and reports only secret key/file metadata", async () => {
    const module = await import("../../scripts/scan-tracked-secrets.js").catch(() => ({})) as Record<string, unknown>;
    expect(typeof module.findTrackedSecretMatches).toBe("function");
    const findMatches = module.findTrackedSecretMatches as (
      dotenv: string,
      trackedFiles: ReadonlyMap<string, string>,
    ) => Array<{ key: string; file: string }>;
    const matches = findMatches(
      [
        "FEISHU_HUB_APP_SECRET=plain-value # trailing comment",
        "FEISHU_CODEX_APP_SECRET=\"quoted#value\" # trailing comment",
        "OPENAI_API_KEY=api-key-value",
        "SSH_PRIVATE_KEY=private-key-value",
        "AUTHORIZATION=authorization-value",
        "SERVICE_PASSWD=passwd-value",
        "PUBLIC_SETTING=not-a-secret",
      ].join("\n"),
      new Map([
        ["src/plain.ts", "const value = 'plain-value';"],
        ["docs/quoted.md", "quoted#value"],
        ["config/api.txt", "api-key-value"],
        ["config/private.txt", "private-key-value"],
        ["config/auth.txt", "authorization-value"],
        ["config/passwd.txt", "passwd-value"],
        ["README.md", "not-a-secret"],
      ]),
    );

    expect(matches).toHaveLength(6);
    expect(matches).toEqual(expect.arrayContaining([
      { key: "FEISHU_HUB_APP_SECRET", file: "src/plain.ts" },
      { key: "FEISHU_CODEX_APP_SECRET", file: "docs/quoted.md" },
      { key: "OPENAI_API_KEY", file: "config/api.txt" },
      { key: "SSH_PRIVATE_KEY", file: "config/private.txt" },
      { key: "AUTHORIZATION", file: "config/auth.txt" },
      { key: "SERVICE_PASSWD", file: "config/passwd.txt" },
    ]));
    expect(JSON.stringify(matches)).not.toContain("plain-value");
    expect(JSON.stringify(matches)).not.toContain("quoted#value");
  });
});
