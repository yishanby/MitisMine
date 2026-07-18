import { createHash } from "node:crypto";

import * as Lark from "@larksuiteoapi/node-sdk";

import type { OutboxMessage } from "../../storage/src/outbox.js";
import type { AppConnectionRegistry } from "../../../apps/control-plane/src/health.js";
import type { FeishuGateway } from "./gateway.js";
import type { OutboxSender, OutboxSendResult } from "./outbox-dispatcher.js";
import {
  APP_ROLES,
  type AppRegistration,
  type AppRole,
} from "./registry.js";

interface LongConnectionOptions {
  readonly registrations: readonly AppRegistration[];
  readonly gateway: FeishuGateway;
  readonly connections: AppConnectionRegistry;
  readonly onCardAction?: (role: AppRole, data: unknown) => Promise<unknown>;
}

export class FeishuLongConnections implements OutboxSender {
  readonly #clients = new Map<AppRole, Lark.Client>();
  readonly #sockets = new Map<AppRole, Lark.WSClient>();
  readonly #starters: Array<() => Promise<void>> = [];
  #startTasks: Promise<void>[] | undefined;

  constructor(options: LongConnectionOptions) {
    for (const registration of options.registrations) {
      const base = { appId: registration.appId, appSecret: registration.appSecret };
      this.#clients.set(registration.role, new Lark.Client(base));
      const socket = new Lark.WSClient({
        ...base,
        loggerLevel: Lark.LoggerLevel.error,
        autoReconnect: true,
        handshakeTimeoutMs: 20_000,
        onReady: () => options.connections.connect(registration.role),
        onReconnecting: () => options.connections.disconnect(registration.role),
        onReconnected: () => options.connections.connect(registration.role),
        onError: () => options.connections.disconnect(registration.role),
      });
      const dispatcher = new Lark.EventDispatcher({ loggerLevel: Lark.LoggerLevel.error }).register({
        "im.message.receive_v1": async (data) => {
          await options.gateway.receiveSdkEvent(registration.role, {
            header: {
              event_id: data.event_id ?? data.message.message_id,
              tenant_key: data.tenant_key ?? data.sender.tenant_key,
            },
            event: { sender: data.sender, message: data.message },
          });
        },
        "card.action.trigger": async (data: unknown) =>
          options.onCardAction?.(registration.role, data),
      });
      this.#sockets.set(registration.role, socket);
      this.#starters.push(async () => socket.start({ eventDispatcher: dispatcher }));
    }
  }

  async ready(): Promise<void> {
    this.#startTasks ??= this.#starters.map(async (start) => start());
    await Promise.all(this.#startTasks);
  }

  close(): void {
    for (const [role, socket] of this.#sockets) {
      socket.close({ force: true });
      this.#sockets.delete(role);
    }
  }

  async send(message: OutboxMessage): Promise<OutboxSendResult> {
    if (!APP_ROLES.includes(message.appRole as AppRole)) {
      throw new Error(`Unknown Feishu App role: ${message.appRole}`);
    }
    const client = this.#clients.get(message.appRole as AppRole);
    if (client === undefined) throw new Error(`Feishu client not ready: ${message.appRole}`);
    if (message.operation === "update") {
      const response = await client.im.v1.message.patch(feishuPatchData(message));
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`Feishu message API failed with code ${response.code}: ${response.msg ?? "unknown"}`);
      }
      return {};
    }
    const response = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: feishuMessageData(message),
    });
    if (response.code !== undefined && response.code !== 0) {
      throw new Error(`Feishu message API failed with code ${response.code}: ${response.msg ?? "unknown"}`);
    }
    const messageId = response.data?.message_id;
    return messageId === undefined ? {} : { messageId };
  }
}

export function feishuMessageData(message: OutboxMessage): {
  receive_id: string;
  msg_type: "interactive";
  content: string;
  uuid: string;
} {
  return {
    receive_id: message.receiveId,
    msg_type: "interactive",
    content: JSON.stringify(message.payload),
    uuid: stableFeishuUuid(message.idempotencyKey),
  };
}

export function feishuPatchData(message: OutboxMessage): {
  path: { message_id: string };
  data: { content: string };
} {
  if (message.operation !== "update" || message.targetMessageId === undefined) {
    throw new Error("Feishu card patch requires an update target");
  }
  return {
    path: { message_id: message.targetMessageId },
    data: { content: JSON.stringify(message.payload) },
  };
}

function stableFeishuUuid(idempotencyKey: string): string {
  const bytes = createHash("sha256").update(idempotencyKey, "utf8").digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
