import { describe, expect, it } from "vitest";

import { curateChildEnvironment } from "../../packages/agent-protocol/src/runner.js";

const secretKeys = [
  "FEISHU_HUB_APP_SECRET",
  "FEISHU_CLAUDE_APP_SECRET",
  "FEISHU_CODEX_APP_SECRET",
  "FEISHU_COPILOT_APP_SECRET",
] as const;

describe("Feishu secret isolation", () => {
  it("never passes Feishu secrets through the regular allow list", () => {
    const environment = Object.fromEntries(
      secretKeys.map((key, index) => [key, `synthetic-feishu-secret-${index}`]),
    );
    const childEnvironment = curateChildEnvironment(environment, secretKeys, []);

    expect(secretKeys.some((key) => key in childEnvironment)).toBe(false);
  });
});
