import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../apps/control-plane/src/config.js";
import {
  registrationsFromConfig,
  shutdownControlPlane,
  startControlPlane,
  type ControlPlaneService,
  type ServiceDependencies,
} from "../../apps/control-plane/src/main.js";
import { APP_ROLES, FeishuAppRegistry } from "../../packages/feishu/src/registry.js";
import { WorkerLeaseStore } from "../../apps/worker/src/main.js";

const validEnvironment = {
  MITISMINE_APPROVAL_KEY: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  FEISHU_HUB_APP_ID: "hub-app",
  FEISHU_HUB_APP_SECRET: "hub-secret",
  FEISHU_CLAUDE_APP_ID: "claude-app",
  FEISHU_CLAUDE_APP_SECRET: "claude-secret",
  FEISHU_CODEX_APP_ID: "codex-app",
  FEISHU_CODEX_APP_SECRET: "codex-secret",
  FEISHU_COPILOT_APP_ID: "copilot-app",
  FEISHU_COPILOT_APP_SECRET: "copilot-secret",
  MITISMINE_IDENTITY_PROBES_JSON: JSON.stringify({
    observations: APP_ROLES.map((appRole) => ({
      appRole,
      tenantKey: "tenant-1",
      userId: "operator-1",
    })),
  }),
} as const;

function exampleEnvironment(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(".env.example"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0 && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

describe("loadConfig", () => {
  it("requires identity observations for all four Feishu Apps", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_IDENTITY_PROBES_JSON: undefined,
    })).toThrow(/MITISMINE_IDENTITY_PROBES_JSON/);
  });

  it("strictly parses identity observations JSON", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_IDENTITY_PROBES_JSON: "not-json",
    })).toThrow(/valid JSON/i);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_IDENTITY_PROBES_JSON: JSON.stringify({
        observations: APP_ROLES.map((appRole) => ({
          appRole,
          tenantKey: "tenant-1",
          userId: "operator-1",
          expectedPrincipal: "tenant-1:user:operator-1",
        })),
      }),
    })).toThrow(/unrecognized key/i);
  });

  it("rejects duplicate identity observation roles", () => {
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_IDENTITY_PROBES_JSON: JSON.stringify({
        observations: [
          { appRole: "hub", tenantKey: "tenant-1", userId: "operator-1" },
          { appRole: "claude", tenantKey: "tenant-1", userId: "operator-1" },
          { appRole: "codex", tenantKey: "tenant-1", userId: "operator-1" },
          { appRole: "codex", tenantKey: "tenant-1", userId: "operator-1" },
        ],
      }),
    })).toThrow(/all four App roles/i);
  });

  it("parses four real observations without accepting an expected principal shortcut", () => {
    const config = loadConfig(validEnvironment);

    expect(config.MITISMINE_IDENTITY_PROBES_JSON.observations.map(({ appRole }) => appRole))
      .toEqual(APP_ROLES);
  });

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
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "change-me-change-me-change-me-change-me",
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "z".repeat(64),
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "00".repeat(32),
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
  });

  it("rejects approval key templates from the example environment", () => {
    const environment = exampleEnvironment();

    expect(environment.MITISMINE_APPROVAL_KEY).toBe("<generate-a-random-32-byte-secret>");
    expect(() => loadConfig(environment)).toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "<custom-generated-secret-that-is-long-enough>",
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_APPROVAL_KEY: "template-approval-signing-key-with-32-characters",
    })).toThrow(/MITISMINE_APPROVAL_KEY/);
  });

  it("rejects identity observation placeholders from the example environment", () => {
    const environment = exampleEnvironment();

    expect(environment.MITISMINE_IDENTITY_PROBES_JSON).toContain("<observed-");
    expect(() => loadConfig({
      ...environment,
      MITISMINE_APPROVAL_KEY: validEnvironment.MITISMINE_APPROVAL_KEY,
    })).toThrow(/identity observation/i);
    expect(() => loadConfig({
      ...validEnvironment,
      MITISMINE_IDENTITY_PROBES_JSON: JSON.stringify({
        observations: APP_ROLES.map((appRole) => ({
          appRole,
          tenantKey: "tenant-key-here",
          userId: "user-id-here",
        })),
      }),
    })).toThrow(/identity observation/i);
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

  it("verifies observed identity before startup creates resources or listens", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-identity-startup-"));
    const blockingFile = join(directory, "not-a-directory");
    writeFileSync(blockingFile, "block startup side effects");
    const identityVerifier = vi.fn(() => {
      throw new Error("Cross-App identity mismatch from startup verifier");
    });
    const config = loadConfig({
      ...validEnvironment,
      MITISMINE_DATA_DIR: join(blockingFile, "data"),
      MITISMINE_DB_PATH: join(blockingFile, "database", "mitismine.db"),
    });

    try {
      await expect(startControlPlane(config, { identityVerifier }))
        .rejects.toThrow(/identity mismatch from startup verifier/i);
      expect(identityVerifier).toHaveBeenCalledOnce();
      expect(identityVerifier).toHaveBeenCalledWith(
        config.MITISMINE_IDENTITY_PROBES_JSON.observations,
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["listen", "live.ready"] as const)(
    "unwinds every opened resource when %s fails during startup",
    async (failingPhase) => {
      const directory = mkdtempSync(join(tmpdir(), "mitismine-startup-cleanup-"));
      let shutdown: readonly (() => Promise<void> | void)[] = [];
      let serviceCloseCalls = 0;
      let liveCloseCalls = 0;
      const startupError = new Error(`${failingPhase} failed`);
      const fakeService = {
        listen: async () => {
          if (failingPhase === "listen") throw startupError;
        },
        close: async () => {
          serviceCloseCalls += 1;
          for (const stop of [...shutdown].reverse()) await stop();
        },
      } as unknown as ControlPlaneService;
      const serviceFactory = async (deps: ServiceDependencies): Promise<ControlPlaneService> => {
        shutdown = deps.shutdown ?? [];
        return fakeService;
      };
      const liveFactory = () => ({
        ready: async () => {
          if (failingPhase === "live.ready") throw startupError;
        },
        close: () => { liveCloseCalls += 1; },
        send: async () => {},
      });
      const config = loadConfig({
        ...validEnvironment,
        MITISMINE_DB_PATH: join(directory, "mitismine.db"),
        MITISMINE_DATA_DIR: join(directory, "data"),
        MITISMINE_AGENT_WORKSPACE_ROOT: join(directory, "workspaces"),
      });

      try {
        await expect(startControlPlane(config, { serviceFactory, liveFactory }))
          .rejects.toThrow(startupError.message);
        expect(serviceCloseCalls).toBe(1);
        expect(liveCloseCalls).toBe(1);
      } finally {
        if (serviceCloseCalls === 0) await fakeService.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("requeues expired leases before the Feishu channel becomes ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mitismine-startup-order-"));
    const databasePath = join(directory, "mitismine.db");
    const seed = WorkerLeaseStore.open(databasePath);
    seed.lease("expired-before-channel", "old-worker", new Date("2020-01-01T00:00:00.000Z"), 1_000);
    seed.close();
    let shutdown: readonly (() => Promise<void> | void)[] = [];
    const fakeService = {
      listen: async () => {},
      close: async () => {
        for (const stop of [...shutdown].reverse()) await stop();
      },
    } as unknown as ControlPlaneService;
    const config = loadConfig({
      ...validEnvironment,
      MITISMINE_DB_PATH: databasePath,
      MITISMINE_DATA_DIR: join(directory, "data"),
      MITISMINE_AGENT_WORKSPACE_ROOT: join(directory, "workspaces"),
    });

    try {
      const runtime = await startControlPlane(config, {
        serviceFactory: async (deps) => { shutdown = deps.shutdown ?? []; return fakeService; },
        liveFactory: () => ({
          ready: async () => {
            const observer = WorkerLeaseStore.open(databasePath);
            try {
              expect(observer.status("expired-before-channel")).toBe("queued");
            } finally {
              observer.close();
            }
          },
          close: () => {},
          send: async () => {},
        }),
      });
      await runtime.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a failing process code when runtime cleanup fails", async () => {
    const exitCodes: number[] = [];
    await shutdownControlPlane(
      { service: {} as ControlPlaneService, close: async () => { throw new Error("close failed"); } },
      (code) => { exitCodes.push(code); },
      () => {},
    );

    expect(exitCodes).toEqual([1]);
  });
});
