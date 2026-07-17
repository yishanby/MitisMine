import { describe, expect, it } from "vitest";

import { loadConfig } from "../../apps/control-plane/src/config.js";

describe("loadConfig", () => {
  it("requires all four Feishu credentials", () => {
    expect(() => loadConfig({})).toThrow(/FEISHU_HUB_APP_ID/);
  });
});
