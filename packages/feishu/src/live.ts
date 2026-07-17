import * as Lark from "@larksuiteoapi/node-sdk";

import type { OutboxMessage } from "../../storage/src/outbox.js";
import type { AppConnectionRegistry } from "../../../apps/control-plane/src/health.js";
import type { FeishuGateway } from "./gateway.js";
import type { OutboxSender } from "./outbox-dispatcher.js";
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
  readonly #startTasks: Promise<void>[] = [];

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
      this.#startTasks.push(socket.start({ eventDispatcher: dispatcher }));
    }
  }

  async ready(): Promise<void> {
    await Promise.all(this.#startTasks);
  }

  close(): void {
    for (const [role, socket] of this.#sockets) {
      socket.close({ force: true });
      this.#sockets.delete(role);
    }
  }

  async send(message: OutboxMessage): Promise<void> {
    if (!APP_ROLES.includes(message.appRole as AppRole)) {
      throw new Error(`Unknown Feishu App role: ${message.appRole}`);
    }
    const client = this.#clients.get(message.appRole as AppRole);
    if (client === undefined) throw new Error(`Feishu client not ready: ${message.appRole}`);
    await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: message.receiveId,
        msg_type: "interactive",
        content: JSON.stringify(message.payload),
      },
    });
  }
}
