import type { ProviderName } from "../../agent-adapters/src/index.js";
import type { ApprovalAction } from "../../approval/src/index.js";
import type { Topic, TopicMember } from "../../domain/src/model.js";
import {
  archiveTopic,
  canEditTopic,
  createTopic,
  resolvePrincipal,
} from "../../domain/src/topic.js";
import type { OutboxPort } from "../../storage/src/outbox.js";
import type { EventStore } from "../../storage/src/store.js";
import { textCard } from "./cards.js";
import { parseCommand, type FeishuCommand } from "./commands.js";
import type { AppRole, ProviderAppRole } from "./registry.js";

export interface FeishuMessageEvent {
  readonly appRole: AppRole;
  readonly eventId: string;
  readonly tenantKey: string;
  readonly userId?: string;
  readonly unionId?: string;
  readonly openId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly text: string;
}

export type DispatchInput =
  | {
      readonly mode: "research";
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly question: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "action";
      readonly action: ApprovalAction;
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "direct";
      readonly provider: ProviderName;
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly question: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "control";
      readonly action: "status" | "stop" | "report";
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    };

export interface FeishuDispatcher {
  dispatch(input: DispatchInput): Promise<void>;
}

interface GatewayOptions {
  readonly store: EventStore;
  readonly outbox: OutboxPort;
  readonly dispatcher: FeishuDispatcher;
  readonly idFactory: () => string;
}

export class FeishuGateway {
  readonly #store: EventStore;
  readonly #outbox: OutboxPort;
  readonly #dispatcher: FeishuDispatcher;
  readonly #idFactory: () => string;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#outbox = options.outbox;
    this.#dispatcher = options.dispatcher;
    this.#idFactory = options.idFactory;
  }

  async receive(event: FeishuMessageEvent): Promise<{ duplicate: boolean }> {
    if (!this.#store.recordFeishuEvent(event.appRole, event.eventId)) {
      return { duplicate: true };
    }
    const principalId = resolvePrincipal({
      tenantKey: event.tenantKey,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      ...(event.unionId === undefined ? {} : { unionId: event.unionId }),
    });
    const command = parseCommand(event.text);
    await this.#route(event, principalId, command);
    return { duplicate: false };
  }

  async receiveSdkEvent(appRole: AppRole, raw: unknown): Promise<{ duplicate: boolean }> {
    return this.receive(parseSdkEvent(appRole, raw));
  }

  async #route(
    event: FeishuMessageEvent,
    principalId: string,
    command: FeishuCommand,
  ): Promise<void> {
    switch (command.kind) {
      case "topic.new": {
        const topic = this.#createTopic(event.tenantKey, principalId, command.title);
        this.#respond(event, textCard("Topic 已创建", `${topic.title}\n${topic.id}`));
        return;
      }
      case "topic.list": {
        const topics = this.#store.listTopics(event.tenantKey, principalId);
        const body = topics.length === 0
          ? "暂无 Topic"
          : topics.map((topic) => `- ${topic.id} · ${topic.title} · ${topic.status}`).join("\n");
        this.#respond(event, textCard("Topics", body));
        return;
      }
      case "topic.use": {
        const matches = this.#store
          .listTopics(event.tenantKey, principalId)
          .filter((topic) => topic.id.toLowerCase().startsWith(command.topicPrefix.toLowerCase()));
        if (matches.length !== 1) throw new Error("Topic prefix must match exactly one accessible Topic");
        const topic = matches[0] as Topic;
        this.#store.setCurrentTopic(event.tenantKey, principalId, topic.id);
        this.#respond(event, textCard("已切换 Topic", `${topic.title}\n${topic.id}`));
        return;
      }
      case "topic.show": {
        const topic = this.#requireCurrent(event.tenantKey, principalId);
        const members = this.#store.members(topic.id);
        this.#respond(
          event,
          textCard(
            topic.title,
            `ID: ${topic.id}\n状态: ${topic.status}\n水位: ${topic.lastEventSeq}\n成员: ${members.length}`,
          ),
        );
        return;
      }
      case "topic.share": {
        const topic = this.#requireCurrent(event.tenantKey, principalId);
        const members = this.#store.members(topic.id);
        if (!canEditTopic(topic, principalId, members)) throw new Error("principal cannot share Topic");
        const member: TopicMember = { principalId: command.principalId, role: command.role };
        this.#store.append({
          topicId: topic.id,
          type: "topic.shared",
          actorPrincipalId: principalId,
          payload: { member },
        });
        this.#respond(event, textCard("Topic 已共享", `${member.principalId}: ${member.role}`));
        return;
      }
      case "topic.archive": {
        const topic = this.#requireCurrent(event.tenantKey, principalId);
        const archived = archiveTopic(topic, principalId, this.#store.members(topic.id));
        this.#store.append({
          topicId: topic.id,
          type: "topic.archived",
          actorPrincipalId: principalId,
          payload: { topic: archived },
        });
        this.#respond(event, textCard("Topic 已归档", archived.title));
        return;
      }
      case "note": {
        const topic = this.#currentOrCreate(event, principalId, command.text);
        this.#appendMessage(topic, event, principalId, command.text, true);
        this.#respond(event, textCard("笔记已保存", topic.title));
        return;
      }
      case "research": {
        const topic = this.#currentOrCreate(event, principalId, command.question);
        this.#appendMessage(topic, event, principalId, command.question, false);
        await this.#dispatcher.dispatch({
          mode: "research",
          topicId: topic.id,
          topicTitle: topic.title,
          principalId,
          question: command.question,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
      case "message": {
        const topic = this.#currentOrCreate(event, principalId, command.text);
        this.#appendMessage(topic, event, principalId, command.text, false);
        if (event.appRole === "hub") {
          await this.#dispatcher.dispatch({
            mode: "research",
            topicId: topic.id,
            topicTitle: topic.title,
            principalId,
            question: command.text,
            replyAppRole: event.appRole,
            receiveId: event.chatId,
          });
        } else {
          await this.#dispatcher.dispatch({
            mode: "direct",
            provider: providerFromRole(event.appRole),
            topicId: topic.id,
            topicTitle: topic.title,
            principalId,
            question: command.text,
            replyAppRole: event.appRole,
            receiveId: event.chatId,
          });
        }
        return;
      }
      case "status":
      case "stop":
      case "report": {
        const topic = this.#requireCurrent(event.tenantKey, principalId);
        await this.#dispatcher.dispatch({
          mode: "control",
          action: command.kind,
          topicId: topic.id,
          topicTitle: topic.title,
          principalId,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
      case "action.write": {
        const topic = this.#requireCurrent(event.tenantKey, principalId);
        await this.#dispatcher.dispatch({
          mode: "action",
          action: {
            topicId: topic.id,
            kind: "write_file",
            target: command.path,
            risk: "medium",
            parameters: { content: command.content },
          },
          topicId: topic.id,
          topicTitle: topic.title,
          principalId,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
    }
  }

  #createTopic(tenantKey: string, principalId: string, title: string): Topic {
    const topic = createTopic(title, principalId, { id: this.#idFactory() });
    if (topic.tenantKey !== tenantKey) throw new Error("Topic tenant identity mismatch");
    this.#store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: principalId,
      payload: { topic },
      createdAt: topic.createdAt,
    });
    this.#store.setCurrentTopic(tenantKey, principalId, topic.id);
    return topic;
  }

  #currentOrCreate(event: FeishuMessageEvent, principalId: string, text: string): Topic {
    const currentId = this.#store.currentTopic(event.tenantKey, principalId);
    if (currentId !== undefined) {
      const current = this.#store.topic(currentId);
      if (current !== undefined && current.status === "active") return current;
    }
    return this.#createTopic(event.tenantKey, principalId, summarize(text));
  }

  #requireCurrent(tenantKey: string, principalId: string): Topic {
    const topicId = this.#store.currentTopic(tenantKey, principalId);
    const topic = topicId === undefined ? undefined : this.#store.topic(topicId);
    if (topic === undefined) throw new Error("No current Topic; use /topic new first");
    return topic;
  }

  #appendMessage(
    topic: Topic,
    event: FeishuMessageEvent,
    principalId: string,
    text: string,
    note: boolean,
  ): void {
    this.#store.append({
      topicId: topic.id,
      type: "message.added",
      actorPrincipalId: principalId,
      payload: {
        text,
        note,
        appRole: event.appRole,
        messageId: event.messageId,
        openId: event.openId,
      },
    });
  }

  #respond(event: FeishuMessageEvent, payload: unknown): void {
    this.#outbox.enqueue({
      id: `outbox:${event.appRole}:${event.eventId}`,
      appRole: event.appRole,
      receiveId: event.chatId,
      payload,
      idempotencyKey: `feishu-response:${event.appRole}:${event.eventId}`,
    });
  }
}

function providerFromRole(role: ProviderAppRole): ProviderName {
  return role;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}

function parseSdkEvent(appRole: AppRole, raw: unknown): FeishuMessageEvent {
  const root = object(raw, "Feishu event");
  const header = object(root.header, "Feishu event header");
  const event = object(root.event, "Feishu event body");
  const sender = object(event.sender, "Feishu sender");
  const senderId = object(sender.sender_id, "Feishu sender ID");
  const message = object(event.message, "Feishu message");
  const content = object(JSON.parse(string(message.content, "message content")) as unknown, "message content");
  const userId = optionalString(senderId.user_id);
  const unionId = optionalString(senderId.union_id);
  return {
    appRole,
    eventId: string(header.event_id, "event ID"),
    tenantKey: string(header.tenant_key, "tenant key"),
    ...(userId === undefined ? {} : { userId }),
    ...(unionId === undefined ? {} : { unionId }),
    openId: string(senderId.open_id, "open ID"),
    messageId: string(message.message_id, "message ID"),
    chatId: string(message.chat_id, "chat ID"),
    text: string(content.text, "text content"),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} is missing`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
