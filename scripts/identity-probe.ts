import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import * as Lark from "@larksuiteoapi/node-sdk";

import {
  APP_ROLES,
  IdentityProbeCollector,
  identityProbeRegistrationsFromEnv,
  type AppRole,
  type IdentityProbeDocument,
} from "../packages/feishu/src/registry.js";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;

export async function collectIdentityProbes(
  env: Record<string, string | undefined>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<IdentityProbeDocument> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Identity probe timeout must be positive");
  }
  const registrations = identityProbeRegistrationsFromEnv(env);
  const collector = new IdentityProbeCollector();
  const sockets: Lark.WSClient[] = [];
  let resolveCollection: (document: IdentityProbeDocument) => void = () => undefined;
  let rejectCollection: (error: unknown) => void = () => undefined;
  let settled = false;
  const collection = new Promise<IdentityProbeDocument>((resolvePromise, rejectPromise) => {
    resolveCollection = resolvePromise;
    rejectCollection = rejectPromise;
  });
  const finish = (role: AppRole, data: {
    tenant_key?: string | undefined;
    sender: {
      tenant_key?: string | undefined;
      sender_id?: {
        user_id?: string | undefined;
        union_id?: string | undefined;
      } | undefined;
    };
  }): void => {
    if (settled) return;
    try {
      const tenantKey = data.tenant_key ?? data.sender.tenant_key;
      if (!tenantKey) throw new Error(`Feishu event for ${role} has no tenant key`);
      const senderId = data.sender.sender_id;
      if (senderId === undefined) throw new Error(`Feishu event for ${role} has no sender ID`);
      collector.observe({
        appRole: role,
        tenantKey,
        ...(senderId.user_id === undefined
          ? {}
          : { userId: senderId.user_id }),
        ...(senderId.union_id === undefined
          ? {}
          : { unionId: senderId.union_id }),
      });
      process.stderr.write(`Captured identity from ${role} (${collector.count}/4).\n`);
      if (collector.complete) {
        settled = true;
        resolveCollection(collector.document());
      }
    } catch (error) {
      settled = true;
      rejectCollection(error);
    }
  };

  try {
    for (const registration of registrations) {
      const base = { appId: registration.appId, appSecret: registration.appSecret };
      const socket = new Lark.WSClient({
        ...base,
        loggerLevel: Lark.LoggerLevel.error,
        autoReconnect: true,
        handshakeTimeoutMs: 20_000,
        onError: (error) => {
          if (!settled) {
            settled = true;
            rejectCollection(error);
          }
        },
      });
      const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
        "im.message.receive_v1": async (data) => { finish(registration.role, data); },
      });
      sockets.push(socket);
      void socket.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
        if (!settled) {
          settled = true;
          rejectCollection(error);
        }
      });
    }
    process.stderr.write(
      `Send one message from the same Feishu user to each App: ${APP_ROLES.join(", ")}.\n`,
    );
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        rejectCollection(new Error("Timed out waiting for all four Feishu identity messages"));
      }
    }, timeoutMs);
    timeout.unref();
    try {
      return await collection;
    } finally {
      clearTimeout(timeout);
    }
  } finally {
    for (const socket of sockets) socket.close({ force: true });
  }
}

async function main(): Promise<void> {
  const envFile = resolve(".env.local");
  if (existsSync(envFile)) loadEnvFile(envFile);
  const timeoutArgument = process.argv.find((argument) => argument.startsWith("--timeout-ms="));
  const timeoutMs = timeoutArgument === undefined
    ? DEFAULT_TIMEOUT_MS
    : Number(timeoutArgument.slice("--timeout-ms=".length));
  const document = await collectIdentityProbes(process.env, timeoutMs);
  process.stdout.write(`MITISMINE_IDENTITY_PROBES_JSON=${JSON.stringify(document)}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Identity bootstrap failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
