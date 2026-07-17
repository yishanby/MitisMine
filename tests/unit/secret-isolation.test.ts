import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { curateChildEnvironment } from "../../packages/agent-protocol/src/runner.js";

const secretKeys = [
  "FEISHU_HUB_APP_SECRET",
  "FEISHU_CLAUDE_APP_SECRET",
  "FEISHU_CODEX_APP_SECRET",
  "FEISHU_COPILOT_APP_SECRET",
] as const;

function localEnvironment(): Record<string, string> {
  const content = readFileSync(resolve(".env.local"), "utf8");
  return Object.fromEntries(
    content
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("Feishu secret isolation", () => {
  it("has four populated local secrets without exposing their values", () => {
    const environment = localEnvironment();
    expect(
      secretKeys.every((key) => {
        const value = environment[key];
        return typeof value === "string" && value.length >= 16 && !value.includes("<secret>");
      }),
    ).toBe(true);
  });

  it("never passes Feishu secrets through the regular allow list", () => {
    const environment = localEnvironment();
    const childEnvironment = curateChildEnvironment(environment, secretKeys, []);

    expect(secretKeys.some((key) => key in childEnvironment)).toBe(false);
  });
});
