import { describe, expect, it, vi } from "vitest";
import { isAbsolute, relative } from "node:path";

import { loadConfig } from "../../apps/control-plane/src/config.js";
import { registrationsFromConfig } from "../../apps/control-plane/src/main.js";
import { APP_ROLES, FeishuAppRegistry } from "../../packages/feishu/src/registry.js";

const validEnvironment = {
  MITISMINE_APPROVAL_KEY: "synthetic-approval-signing-key-32-bytes",
  FEISHU_HUB_APP_ID: "hub-app",
  FEISHU_HUB_APP_SECRET: "hub-secret",
  FEISHU_CLAUDE_APP_ID: "claude-app",
  FEISHU_CLAUDE_APP_SECRET: "claude-secret",
  FEISHU_CODEX_APP_ID: "codex-app",
  FEISHU_CODEX_APP_SECRET: "codex-secret",
  FEISHU_COPILOT_APP_ID: "copilot-app",
  FEISHU_COPILOT_APP_SECRET: "copilot-secret",
} as const;

describe("loadConfig", () => {
  it("requires all four Feishu credentials", () => {
    expect(() => loadConfig({})).toThrow(/FEISHU_HUB_APP_ID/);
  });

  it("requires a non-placeholder approval key with at least 32 characters", () => {
    expect(() => loadConfig({ ...validEnvironment, MITISMINE_APPROVAL_KEY: undefined }))
      .toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({ ...validEnvironment, MITISMINE_APPROVAL_KEY: "too-short" }))
      .toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "example-placeholder-approval-key-32-bytes",
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "development-only-approval-key-change-me",
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
  });

  it("rejects duplicate Feishu App IDs", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      FEISHU_CODEX_APP_ID: validEnvironment.FEISHU_CLAUDE_APP_ID,
    })).toThrow(/App IDs must be unique/);
  });

  it("defaults agent workspaces outside the repository", () => {
    const config = loadConfig(validEnvironment);
    const pathFromRepository = relative(process.cwd(), config.MITISMINE_AGENT_WORKSPACE_ROOT);

    expect(isAbsolute(config.MITISMINE_AGENT_WORKSPACE_ROOT)).toBe(true);
    expect(pathFromRepository.startsWith("..") || isAbsolute(pathFromRepository)).toBe(true);
  });

  it("rejects an agent workspace root inside the repository", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_AGENT_WORKSPACE_ROOT: process.cwd(),
    })).toThrow(/outside the repository/);
  });

  it("builds startup registrations through the Feishu App registry by role", () => {
    const get = vi.spyOn(FeishuAppRegistry.prototype, "get");

    expect(registrationsFromConfig(loadConfig(validEnvironment)).map(({ role }) => role))
      .toEqual(APP_ROLES);
    expect(get.mock.calls.map(([role]) => role)).toEqual(APP_ROLES);
  });
});
