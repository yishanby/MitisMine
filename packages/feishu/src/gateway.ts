import type { ProviderName } from "../../agent-adapters/src/index.js";
import type { ApprovalAction } from "../../approval/src/index.js";
import type { Topic, TopicMember } from "../../domain/src/model.js";
import {
  archiveTopic,
  canEditTopic,
  canReadTopic,
  createTopic,
  resolvePrincipal,
} from "../../domain/src/topic.js";
import type { OutboxPort } from "../../storage/src/outbox.js";
import type { EventStore, StoredDirectSession } from "../../storage/src/store.js";
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
  readonly chatType?: "p2p" | "group";
  readonly senderType?: "user" | "app" | "bot" | "unknown";
  readonly mentions?: readonly {
    readonly key: string;
    readonly userId?: string;
    readonly unionId?: string;
    readonly name?: string;
  }[];
}

export interface GroupDiscussionMessageInput {
  readonly tenantKey: string;
  readonly principalId: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly text: string;
  readonly sourceAppRole: AppRole;
  readonly idempotencyKey: string;
  readonly preferredProvider?: ProviderName;
}

export interface GroupDiscussionPort {
  receive(input: GroupDiscussionMessageInput): Promise<void>;
}

export type DispatchInput =
  | {
      readonly mode: "research";
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly question: string;
      readonly idempotencyKey: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "action";
      readonly action: ApprovalAction;
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly idempotencyKey: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "direct";
      readonly provider: ProviderName;
      readonly directSessionId: string;
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly question: string;
      readonly idempotencyKey: string;
      readonly replyAppRole: AppRole;
      readonly receiveId: string;
    }
  | {
      readonly mode: "control";
      readonly action: "status" | "stop" | "report";
      readonly topicId: string;
      readonly topicTitle: string;
      readonly principalId: string;
      readonly idempotencyKey: string;
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
  readonly groupDiscussions?: GroupDiscussionPort;
}

export class FeishuGateway {
  readonly #store: EventStore;
  readonly #outbox: OutboxPort;
  readonly #dispatcher: FeishuDispatcher;
  readonly #idFactory: () => string;
  readonly #groupDiscussions: GroupDiscussionPort | undefined;

  constructor(options: GatewayOptions) {
    this.#store = options.store;
    this.#outbox = options.outbox;
    this.#dispatcher = options.dispatcher;
    this.#idFactory = options.idFactory;
    this.#groupDiscussions = options.groupDiscussions;
  }

  async receive(event: FeishuMessageEvent): Promise<{ duplicate: boolean }> {
    if (
      (event.chatType ?? "p2p") === "group"
      && (event.senderType ?? "user") !== "user"
    ) {
      return { duplicate: false };
    }
    const principalId = resolvePrincipal({
      tenantKey: event.tenantKey,
      ...(event.userId === undefined ? {} : { userId: event.userId }),
      ...(event.unionId === undefined ? {} : { unionId: event.unionId }),
    });
    const claim = this.#store.claimFeishuEvent(event.appRole, event.eventId);
    if (claim === "completed") {
      return { duplicate: true };
    }
    if (claim === "processing") throw new Error("Feishu event is already processing");
    try {
      if ((event.chatType ?? "p2p") === "group") {
        await this.#routeGroup(event, principalId, eventKey(event));
      } else {
        await this.#route(event, principalId, parseCommand(event.text), eventKey(event));
      }
      this.#store.completeFeishuEvent(event.appRole, event.eventId);
      return { duplicate: false };
    } catch (error) {
      this.#store.releaseFeishuEventClaim(event.appRole, event.eventId);
      throw error;
    }
  }

  async #routeGroup(
    event: FeishuMessageEvent,
    principalId: string,
    routeKey: string,
  ): Promise<void> {
    if (this.#groupDiscussions === undefined) {
      throw new Error("Group Discussion coordinator is not configured");
    }
    const text = stripBotMentions(event.text, event.mentions);
    if (!text) throw new Error("Group Discussion message is empty after removing mentions");
    await this.#groupDiscussions.receive({
      tenantKey: event.tenantKey,
      principalId,
      chatId: event.chatId,
      messageId: event.messageId,
      text,
      sourceAppRole: event.appRole,
      idempotencyKey: `${routeKey}:group-discussion`,
      ...(event.appRole !== "hub" && providerExplicitlyMentioned(event)
        ? { preferredProvider: event.appRole }
        : {}),
    });
  }

  async receiveSdkEvent(appRole: AppRole, raw: unknown): Promise<{ duplicate: boolean }> {
    return this.receive(parseSdkEvent(appRole, raw));
  }

  async #route(
    event: FeishuMessageEvent,
    principalId: string,
    command: FeishuCommand,
    routeKey: string,
  ): Promise<void> {
    if (event.appRole === "hub" && isSessionCommand(command)) {
      this.#respond(
        event,
        textCard("请使用 Agent App", "请在 Claude、Codex 或 Copilot App 中管理对应 Agent 的 Session。"),
      );
      return;
    }
    if (event.appRole !== "hub" && isHubOnly(command)) {
      this.#respond(
        event,
        textCard("请使用 Hub App", "该命令会修改 Topic 或启动/��止任务，只能在 Hub App 中执行。"),
      );
      return;
    }
    switch (command.kind) {
      case "topic.new": {
        const topic = this.#createTopic(event.tenantKey, principalId, command.title, `${routeKey}:topic`);
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
        const topic = this.#requireCurrent(event.tenantKey, principalId, "read");
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
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
        const mention = event.mentions?.find((candidate) => candidate.key === command.principalId);
        const memberPrincipalId = mention === undefined
          ? command.principalId
          : resolvePrincipal({
              tenantKey: event.tenantKey,
              ...(mention.userId === undefined ? {} : { userId: mention.userId }),
              ...(mention.unionId === undefined ? {} : { unionId: mention.unionId }),
            });
        const member: TopicMember = { principalId: memberPrincipalId, role: command.role };
        this.#store.append({
          topicId: topic.id,
          type: "topic.shared",
          actorPrincipalId: principalId,
          payload: { member },
          idempotencyKey: `${routeKey}:topic-shared`,
        });
        this.#respond(event, textCard("Topic 已共享", `${member.principalId}: ${member.role}`));
        return;
      }
      case "topic.archive": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
        const archived = archiveTopic(topic, principalId, this.#store.members(topic.id));
        this.#store.append({
          topicId: topic.id,
          type: "topic.archived",
          actorPrincipalId: principalId,
          payload: { topic: archived },
          idempotencyKey: `${routeKey}:topic-archived`,
        });
        this.#respond(event, textCard("Topic 已归档", archived.title));
        return;
      }
      case "note": {
        const topic = this.#currentOrCreate(event, principalId, command.text, routeKey);
        this.#appendMessage(topic, event, principalId, command.text, true, routeKey);
        this.#respond(event, textCard("笔记已保存", topic.title));
        return;
      }
      case "research": {
        const topic = this.#currentOrCreate(event, principalId, command.question, routeKey);
        this.#appendMessage(topic, event, principalId, command.question, false, routeKey);
        await this.#dispatcher.dispatch({
          mode: "research",
          topicId: topic.id,
          topicTitle: topic.title,
          principalId,
          question: command.question,
          idempotencyKey: `${routeKey}:dispatch`,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
      case "message": {
        const topic = this.#currentOrCreate(event, principalId, command.text, routeKey);
        if (event.appRole === "hub") {
          this.#appendMessage(topic, event, principalId, command.text, false, routeKey);
          await this.#dispatcher.dispatch({
            mode: "research",
            topicId: topic.id,
            topicTitle: topic.title,
            principalId,
            question: command.text,
            idempotencyKey: `${routeKey}:dispatch`,
            replyAppRole: event.appRole,
            receiveId: event.chatId,
          });
        } else {
          const provider = providerFromRole(event.appRole);
          const session = this.#ensureCurrentDirectSession(
            event.tenantKey,
            principalId,
            topic.id,
            provider,
            `${routeKey}:lazy-session`,
          );
          this.#appendDirectMessage(
            topic,
            event,
            principalId,
            provider,
            session.id,
            command.text,
            routeKey,
          );
          await this.#dispatcher.dispatch({
            mode: "direct",
            provider,
            directSessionId: session.id,
            topicId: topic.id,
            topicTitle: topic.title,
            principalId,
            question: command.text,
            idempotencyKey: `${routeKey}:dispatch`,
            replyAppRole: event.appRole,
            receiveId: event.chatId,
          });
        }
        return;
      }
      case "session.new": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
        const provider = providerForSessionRole(event.appRole);
        const session = this.#store.createDirectSession({
          id: this.#idFactory(),
          topicId: topic.id,
          provider,
          title: command.title,
          idempotencyKey: `${routeKey}:session-new`,
        });
        this.#store.setCurrentDirectSession(
          event.tenantKey, principalId, topic.id, provider, session.id,
        );
        this.#respond(
          event,
          textCard("Session 已创建", `${session.title}\nID: ${shortSessionId(session.id)}`),
        );
        return;
      }
      case "session.list": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "read");
        const provider = providerForSessionRole(event.appRole);
        const current = this.#store.currentDirectSession(
          event.tenantKey, principalId, topic.id, provider,
        );
        const sessions = this.#store.listDirectSessions(topic.id, provider);
        const body = sessions.length === 0
          ? "暂无 Session；发送普通消息将自动创建 main。"
          : sessions.map((session) => {
              const marker = session.id === current?.id ? "→" : " ";
              return `${marker} ${shortSessionId(session.id)} · ${session.title} · ${session.status} · ${session.updatedAt}`;
            }).join("\n");
        this.#respond(event, textCard(`${provider} Sessions`, body));
        return;
      }
      case "session.use": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "read");
        const provider = providerForSessionRole(event.appRole);
        const session = this.#store.resolveDirectSession(topic.id, provider, command.selector);
        if (session === undefined) throw new Error("Active direct Session not found");
        this.#store.setCurrentDirectSession(
          event.tenantKey, principalId, topic.id, provider, session.id,
        );
        this.#respond(
          event,
          textCard("已切换 Session", `${session.title}\nID: ${shortSessionId(session.id)}`),
        );
        return;
      }
      case "session.show": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "read");
        const provider = providerForSessionRole(event.appRole);
        const session = this.#store.currentDirectSession(
          event.tenantKey, principalId, topic.id, provider,
        );
        this.#respond(
          event,
          session === undefined
            ? textCard("当前 Session", "尚未选择；发送普通消息将自动创建 main。")
            : textCard(
                session.title,
                `Provider: ${provider}\nID: ${session.id}\n状态: ${session.status}\n外部 Session: ${session.externalSessionId === undefined ? "尚未建立" : "已建立"}\n上下文水位: ${session.contextWatermark}`,
              ),
        );
        return;
      }
      case "session.rename": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
        const provider = providerForSessionRole(event.appRole);
        const current = this.#requireCurrentDirectSession(
          event.tenantKey, principalId, topic.id, provider,
        );
        const renamed = this.#store.renameDirectSession(current.id, command.title);
        this.#respond(event, textCard("Session 已重命名", renamed.title));
        return;
      }
      case "session.archive": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
        const provider = providerForSessionRole(event.appRole);
        const effectKey = `${routeKey}:session-archive`;
        const current = this.#store.directSessionEffect(effectKey)
          ?? this.#requireCurrentDirectSession(
            event.tenantKey, principalId, topic.id, provider,
          );
        this.#store.archiveDirectSession(current.id, undefined, effectKey);
        const fallback = this.#store.listDirectSessions(topic.id, provider)
          .find((session) => session.status !== "archived");
        if (fallback !== undefined) {
          this.#store.setCurrentDirectSession(
            event.tenantKey, principalId, topic.id, provider, fallback.id,
          );
        }
        this.#respond(
          event,
          textCard(
            "Session 已归档",
            fallback === undefined ? current.title : `${current.title}\n当前: ${fallback.title}`,
          ),
        );
        return;
      }
      case "status":
      case "stop":
      case "report": {
        const topic = this.#requireCurrent(
          event.tenantKey,
          principalId,
          command.kind === "stop" ? "edit" : "read",
        );
        await this.#dispatcher.dispatch({
          mode: "control",
          action: command.kind,
          topicId: topic.id,
          topicTitle: topic.title,
          principalId,
          idempotencyKey: `${routeKey}:dispatch`,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
      case "action.write": {
        const topic = this.#requireCurrent(event.tenantKey, principalId, "edit");
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
          idempotencyKey: `${routeKey}:dispatch`,
          replyAppRole: event.appRole,
          receiveId: event.chatId,
        });
        return;
      }
    }
  }

  #createTopic(
    tenantKey: string,
    principalId: string,
    title: string,
    idempotencyKey: string,
  ): Topic {
    const topic = createTopic(title, principalId, { id: this.#idFactory() });
    if (topic.tenantKey !== tenantKey) throw new Error("Topic tenant identity mismatch");
    const created = this.#store.append({
      topicId: topic.id,
      type: "topic.created",
      actorPrincipalId: principalId,
      payload: { topic },
      createdAt: topic.createdAt,
      idempotencyKey,
    });
    const stored = this.#store.topic(created.topicId);
    if (stored === undefined) throw new Error("Idempotent Topic effect is missing its projection");
    this.#store.setCurrentTopic(tenantKey, principalId, stored.id);
    return stored;
  }

  #currentOrCreate(
    event: FeishuMessageEvent,
    principalId: string,
    text: string,
    routeKey: string,
  ): Topic {
    const currentId = this.#store.currentTopic(event.tenantKey, principalId);
    if (currentId !== undefined) {
      const current = this.#store.topic(currentId);
      if (current !== undefined && current.status === "active") {
        this.#assertAccess(current, principalId, "edit");
        return current;
      }
    }
    return this.#createTopic(event.tenantKey, principalId, summarize(text), `${routeKey}:topic`);
  }

  #requireCurrent(
    tenantKey: string,
    principalId: string,
    permission: "read" | "edit",
  ): Topic {
    const topicId = this.#store.currentTopic(tenantKey, principalId);
    const topic = topicId === undefined ? undefined : this.#store.topic(topicId);
    if (topic === undefined) throw new Error("No current Topic; use /topic new first");
    this.#assertAccess(topic, principalId, permission);
    return topic;
  }

  #assertAccess(topic: Topic, principalId: string, permission: "read" | "edit"): void {
    const members = this.#store.members(topic.id);
    const allowed = permission === "edit"
      ? canEditTopic(topic, principalId, members)
      : canReadTopic(topic, principalId, members);
    if (!allowed) throw new Error(`principal is not allowed to ${permission} Topic`);
  }

  #appendMessage(
    topic: Topic,
    event: FeishuMessageEvent,
    principalId: string,
    text: string,
    note: boolean,
    routeKey: string,
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
      idempotencyKey: `${routeKey}:message`,
    });
  }

  #appendDirectMessage(
    topic: Topic,
    event: FeishuMessageEvent,
    principalId: string,
    provider: ProviderName,
    directSessionId: string,
    text: string,
    routeKey: string,
  ): void {
    this.#store.append({
      topicId: topic.id,
      type: "agent.direct.message",
      actorPrincipalId: principalId,
      payload: {
        provider,
        directSessionId,
        text,
        appRole: event.appRole,
        messageId: event.messageId,
        openId: event.openId,
      },
      idempotencyKey: `${routeKey}:direct-message`,
    });
  }

  #ensureCurrentDirectSession(
    tenantKey: string,
    principalId: string,
    topicId: string,
    provider: ProviderName,
    idempotencyKey: string,
  ): StoredDirectSession {
    const current = this.#store.currentDirectSession(
      tenantKey, principalId, topicId, provider,
    );
    if (current !== undefined) return current;
    const existingMain = this.#store.resolveDirectSession(topicId, provider, "main");
    const session = existingMain ?? this.#store.createDirectSession({
      id: this.#idFactory(),
      topicId,
      provider,
      title: nextDefaultSessionTitle(this.#store.listDirectSessions(topicId, provider)),
      idempotencyKey,
    });
    this.#store.setCurrentDirectSession(tenantKey, principalId, topicId, provider, session.id);
    return session;
  }

  #requireCurrentDirectSession(
    tenantKey: string,
    principalId: string,
    topicId: string,
    provider: ProviderName,
  ): StoredDirectSession {
    const current = this.#store.currentDirectSession(
      tenantKey, principalId, topicId, provider,
    );
    if (current === undefined) throw new Error("No current Session; use /session new first");
    return current;
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

function isHubOnly(command: FeishuCommand): boolean {
  return ![
    "topic.use",
    "topic.show",
    "status",
    "report",
    "message",
    "session.new",
    "session.list",
    "session.use",
    "session.show",
    "session.rename",
    "session.archive",
  ].includes(command.kind);
}

function isSessionCommand(command: FeishuCommand): boolean {
  return command.kind.startsWith("session.");
}

function providerFromRole(role: ProviderAppRole): ProviderName {
  return role;
}

function providerForSessionRole(role: AppRole): ProviderName {
  if (role === "hub") throw new Error("Session commands require a provider App");
  return providerFromRole(role);
}

function shortSessionId(id: string): string {
  return id.slice(0, 8);
}

function nextDefaultSessionTitle(sessions: readonly StoredDirectSession[]): string {
  const titles = new Set(sessions.map((session) => session.title.toLocaleLowerCase()));
  if (!titles.has("main")) return "main";
  let suffix = 2;
  while (titles.has(`main ${suffix}`)) suffix += 1;
  return `main ${suffix}`;
}

function eventKey(event: FeishuMessageEvent): string {
  return `feishu:${event.appRole}:${event.eventId}`;
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= 60 ? oneLine : `${oneLine.slice(0, 59)}…`;
}

function stripBotMentions(
  text: string,
  mentions: FeishuMessageEvent["mentions"],
): string {
  let result = text;
  for (const mention of mentions ?? []) {
    if (mention.name === undefined || /(?:^mitismine\b|总控)/i.test(mention.name)) {
      result = result.replaceAll(mention.key, " ");
    }
  }
  return result.replace(/\s+/g, " ").trim();
}

function providerExplicitlyMentioned(event: FeishuMessageEvent): boolean {
  if (event.appRole === "hub") return false;
  return event.mentions?.some(
    ({ name }) => name?.toLowerCase().includes(event.appRole) === true,
  ) === true;
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
  const mentions = Array.isArray(message.mentions)
    ? message.mentions.map((rawMention) => {
        const mention = object(rawMention, "message mention");
        const mentionId = object(mention.id, "message mention ID");
        const mentionUserId = optionalString(mentionId.user_id);
        const mentionUnionId = optionalString(mentionId.union_id);
        const mentionName = optionalString(mention.name);
        return {
          key: string(mention.key, "message mention key"),
          ...(mentionUserId === undefined ? {} : { userId: mentionUserId }),
          ...(mentionUnionId === undefined ? {} : { unionId: mentionUnionId }),
          ...(mentionName === undefined ? {} : { name: mentionName }),
        };
      })
    : [];
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
    chatType: message.chat_type === "group" ? "group" : "p2p",
    senderType: parseSenderType(sender.sender_type),
    ...(mentions.length === 0 ? {} : { mentions }),
  };
}

function parseSenderType(value: unknown): "user" | "app" | "bot" | "unknown" {
  if (value === "user" || value === "app" || value === "bot") return value;
  return "unknown";
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
