import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { ulid } from "ulid";

import { createAdapters, type AdapterRegistry } from "../../../packages/agent-adapters/src/index.js";
import { runJsonl } from "../../../packages/agent-protocol/src/runner.js";
import { compileContext } from "../../../packages/domain/src/context.js";
import type { DiscussionAction, GroupDiscussion } from "../../../packages/domain/src/discussion.js";
import { resolvePrincipal } from "../../../packages/domain/src/topic.js";
import {
  ApprovalEngine,
  TrustedActionExecutor,
} from "../../../packages/approval/src/index.js";
import { approvalCard, textCard } from "../../../packages/feishu/src/cards.js";
import {
  FeishuGateway,
  type DispatchInput,
  type FeishuDispatcher,
} from "../../../packages/feishu/src/gateway.js";
import { FeishuLongConnections } from "../../../packages/feishu/src/live.js";
import {
  OutboxDispatcher,
  type OutboxSender,
} from "../../../packages/feishu/src/outbox-dispatcher.js";
import {
  APP_ROLES,
  FeishuAppRegistry,
  type AppRegistration,
  type IdentityProbe,
  verifyCrossAppIdentity,
} from "../../../packages/feishu/src/registry.js";
import { ResearchOrchestrator } from "../../../packages/orchestrator/src/index.js";
import {
  AgentConcurrencyLimiter,
  type AgentCallLimiter,
} from "../../../packages/orchestrator/src/concurrency.js";
import {
  DiscussionControlDeliveryEffects,
  DiscussionCoordinator,
  GroupDiscussionChannel,
} from "../../../packages/orchestrator/src/discussion.js";
import { directResearchPrompt } from "../../../packages/orchestrator/src/prompts.js";
import { LocalWorkerTaskExecutor } from "../../../packages/orchestrator/src/worker.js";
import { SqliteOrchestrationStore } from "../../../packages/storage/src/orchestration.js";
import { SqliteApprovalStore } from "../../../packages/storage/src/approval.js";
import { SqliteDiscussionStore } from "../../../packages/storage/src/discussion.js";
import { DurableOutbox } from "../../../packages/storage/src/outbox.js";
import { EventStore } from "../../../packages/storage/src/store.js";
import { WorkerLeaseStore } from "../../worker/src/main.js";
import { loadConfig, type Config } from "./config.js";
import { RecoverySupervisor } from "./recovery.js";
export { RecoverySupervisor } from "./recovery.js";

import {
  AppConnectionRegistry,
  registerHealthRoutes,
  type HealthDependencies,
  WorkerRegistry,
} from "./health.js";

export interface ServiceDependencies extends HealthDependencies {
  readonly shutdown?: readonly (() => Promise<void> | void)[];
}

export type ControlPlaneService = FastifyInstance & { readonly deps: ServiceDependencies };

export async function createService(deps: ServiceDependencies): Promise<ControlPlaneService> {
  const app = Fastify({ logger: false }) as unknown as ControlPlaneService;
  Object.defineProperty(app, "deps", { value: deps, enumerable: true });
  registerHealthRoutes(app, deps);
  let shutDown = false;
  app.addHook("onClose", async () => {
    if (shutDown) return;
    shutDown = true;
    await runCleanups(deps.shutdown ?? []);
  });
  await app.ready();
  return app;
}

export class ChannelDispatcher implements FeishuDispatcher {
  readonly #orchestrator: Pick<ResearchOrchestrator, "start" | "resume" | "cancel">;
  readonly #checkpoints: Pick<SqliteOrchestrationStore, "load" | "latestForTopic">;
  readonly #store: EventStore;
  readonly #outbox: DurableOutbox;
  readonly #adapters: AdapterRegistry;
  readonly #agentWorkspaceRoot: string;
  readonly #approval: Pick<ApprovalEngine, "request">;
  readonly #limiter: AgentCallLimiter;
  readonly #pending = new Map<Promise<void>, {
    readonly controller: AbortController;
    readonly runId?: string;
  }>();
  readonly #directQueues = new Map<string, Promise<void>>();
  #shuttingDown = false;

  constructor(options: {
    orchestrator: Pick<ResearchOrchestrator, "start" | "resume" | "cancel">;
    checkpoints: Pick<SqliteOrchestrationStore, "load" | "latestForTopic">;
    store: EventStore;
    outbox: DurableOutbox;
    adapters: AdapterRegistry;
    agentWorkspaceRoot: string;
    approval: Pick<ApprovalEngine, "request">;
    limiter?: AgentCallLimiter;
  }) {
    this.#orchestrator = options.orchestrator;
    this.#checkpoints = options.checkpoints;
    this.#store = options.store;
    this.#outbox = options.outbox;
    this.#adapters = options.adapters;
    this.#agentWorkspaceRoot = options.agentWorkspaceRoot;
    this.#approval = options.approval;
    this.#limiter = options.limiter ?? new AgentConcurrencyLimiter(6);
  }

  async dispatch(input: DispatchInput): Promise<void> {
    if (this.#shuttingDown) throw new Error("Channel dispatcher is shutting down");
    this.#enqueue(
      input,
      "已接收",
      input.mode === "control" ? input.action : "任务已进入队列",
      "accepted",
    );
    const controller = new AbortController();
    const handling = input.mode === "direct"
      ? this.#serializeDirect(input.directSessionId, () => this.#handle(input, controller.signal))
      : this.#handle(input, controller.signal);
    this.#pending.set(handling, {
      controller,
      ...(input.mode === "research"
        ? { runId: `research:${input.idempotencyKey}` }
        : {}),
    });
    void handling.then(
      () => { this.#pending.delete(handling); },
      () => { this.#pending.delete(handling); },
    );
    if (
      input.mode === "research"
      && this.#checkpoints.load(`research:${input.idempotencyKey}`) === undefined
    ) {
      await handling;
      return;
    }
    void handling.catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown failure";
      this.#enqueue(input, "任务失败", message, "failed");
    }).catch(() => {});
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const pending = [...this.#pending.entries()];
    for (const [, { controller }] of pending) {
      controller.abort(new Error("Control plane is shutting down"));
    }
    const runIds = new Set(
      pending.flatMap(([, entry]) => entry.runId === undefined ? [] : [entry.runId]),
    );
    await Promise.allSettled([...runIds].map(async (runId) => this.#orchestrator.cancel(runId)));
    await Promise.allSettled(pending.map(([handling]) => handling));
  }

  async #handle(input: DispatchInput, signal: AbortSignal): Promise<void> {
    if (input.mode === "research") {
      const runId = `research:${input.idempotencyKey}`;
      const result = this.#checkpoints.load(runId) === undefined
        ? await this.#orchestrator.start({
            runId,
            topicId: input.topicId,
            question: input.question,
            cwd: this.#workspace(input.topicId),
            contextPack: this.#contextPack(input.topicId),
          })
        : await this.#orchestrator.resume(runId);
      this.#store.append({
        topicId: input.topicId,
        type: "research.completed",
        actorPrincipalId: input.principalId,
        payload: { runId, state: result.run.state, report: result.report },
        idempotencyKey: `${input.idempotencyKey}:research-completed`,
      });
      this.#enqueue(
        input,
        result.run.state === "cancelled"
          ? "调研已停止"
          : result.run.state === "paused"
            ? "调研已暂停"
            : result.run.unresolved
              ? "调研完成（存在未决争议）"
              : "调研完成",
        result.report === undefined ? "未生成报告" : renderReport(result.report),
      );
      return;
    }
    if (input.mode === "direct") {
      const adapter = this.#adapters[input.provider];
      const session = this.#store.directSession(input.directSessionId);
      if (
        session === undefined
        || session.topicId !== input.topicId
        || session.provider !== input.provider
        || session.status === "archived"
      ) {
        throw new Error("Direct Session does not belong to this Topic and provider");
      }
      if (signal.aborted) throw signal.reason ?? new Error("Direct turn aborted");
      this.#store.updateDirectSession(session.id, { status: "running" });
      try {
        const task = {
          topicId: input.topicId,
          runId: `direct-${ulid()}`,
          prompt: directResearchPrompt(
            input.question,
            this.#contextPack(input.topicId, input.directSessionId),
          ),
          cwd: this.#workspace(input.topicId),
          signal,
        };
        const result = await this.#limiter.run(async () => session.externalSessionId === undefined
          ? adapter.start(task)
          : adapter.resume({ ...task, externalSessionId: session.externalSessionId }));
        const text = finalText(result.events);
        const contextWatermark = this.#store.topic(input.topicId)?.lastEventSeq ?? 0;
        const latest = this.#store.directSession(session.id);
        this.#store.updateDirectSession(session.id, {
          externalSessionId: result.externalSessionId,
          contextWatermark,
          status: latest?.status === "archived" ? "archived" : "active",
        });
        this.#store.append({
          topicId: input.topicId,
          type: "agent.direct.completed",
          actorPrincipalId: input.principalId,
          payload: {
            provider: input.provider,
            directSessionId: input.directSessionId,
            externalSessionId: result.externalSessionId,
            text,
          },
          idempotencyKey: `${input.idempotencyKey}:direct-completed`,
        });
        this.#enqueue(input, `${input.provider} 回复`, text);
      } catch (error) {
        const current = this.#store.directSession(session.id);
        if (current !== undefined && current.status !== "archived") {
          this.#store.updateDirectSession(session.id, { status: "active" });
        }
        throw error;
      }
      return;
    }
    if (input.mode === "action") {
      const request = this.#approval.request(input.action, input.principalId);
      this.#enqueuePayload(
        input,
        approvalCard({
          title: "需要批准",
          preview: `动作: ${input.action.kind}\n目标: ${input.action.target}`,
          risk: input.action.risk,
          token: request.token,
        }),
      );
      return;
    }
    const latest = this.#checkpoints.latestForTopic(input.topicId);
    if (input.action === "status") {
      this.#enqueue(
        input,
        "调研状态",
        latest === undefined
          ? "当前 Topic 尚无调研 Run"
          : `Run: ${latest.run.id}\n状态: ${latest.run.state}\n轮次: ${latest.run.round}`,
      );
      return;
    }
    if (input.action === "report") {
      this.#enqueue(
        input,
        "最新报告",
        latest?.report === undefined ? "暂无报告" : renderReport(latest.report),
      );
      return;
    }
    if (latest === undefined) {
      this.#enqueue(input, "停止请求", "当前 Topic 没有可停止的 Run");
      return;
    }
    await this.#orchestrator.cancel(latest.run.id);
    this.#enqueue(input, "调研已停止", `Run: ${latest.run.id}`);
  }

  #workspace(topicId: string): string {
    const root = resolve(this.#agentWorkspaceRoot);
    const workspace = resolve(root, topicId);
    if (workspace !== root && !workspace.startsWith(`${root}\\`) && !workspace.startsWith(`${root}/`)) {
      throw new Error("Topic workspace escapes the configured agent workspace root");
    }
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  #contextPack(topicId: string, directSessionId?: string): string {
    const topic = this.#store.topic(topicId);
    if (topic === undefined) throw new Error(`Topic not found: ${topicId}`);
    const events = this.#store.events(topicId).filter((event) => {
      if (!event.type.startsWith("agent.direct.")) return true;
      if (directSessionId === undefined) return true;
      const payload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, unknown>
        : {};
      return payload.directSessionId === directSessionId;
    }).map((event) => {
      const payload = typeof event.payload === "object" && event.payload !== null
        ? event.payload as Record<string, unknown>
        : {};
      const pinned = event.type === "message.added" && payload.note === true;
      return {
        seq: event.seq,
        type: event.type,
        text: JSON.stringify({
          ...(event.actorPrincipalId === undefined ? {} : { actorPrincipalId: event.actorPrincipalId }),
          payload: event.payload,
          createdAt: event.createdAt,
        }),
        relevance: pinned ? 1 : event.type === "message.added" ? 0.9 : 0.5,
        pinned,
      };
    });
    return compileContext({
      maxChars: 12_000,
      summary: JSON.stringify({
        id: topic.id,
        title: topic.title,
        status: topic.status,
        ownerPrincipalId: topic.ownerPrincipalId,
        createdAt: topic.createdAt,
        updatedAt: topic.updatedAt,
      }),
      events,
      evidence: [],
      watermark: topic.lastEventSeq,
    }).serialized;
  }

  #serializeDirect(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.#directQueues.get(sessionId) ?? Promise.resolve();
    const handling = previous.catch(() => {}).then(task);
    this.#directQueues.set(sessionId, handling);
    void handling.finally(() => {
      if (this.#directQueues.get(sessionId) === handling) this.#directQueues.delete(sessionId);
    }).catch(() => {});
    return handling;
  }

  #enqueue(input: DispatchInput, title: string, content: string, effect = "result"): void {
    this.#enqueuePayload(input, textCard(title, content), effect);
  }

  #enqueuePayload(input: DispatchInput, payload: unknown, effect = "result"): void {
    const id = `outbox:${input.idempotencyKey}:${effect}`;
    this.#outbox.enqueue({
      id,
      appRole: input.replyAppRole,
      receiveId: input.receiveId,
      payload,
      idempotencyKey: `dispatch:${input.idempotencyKey}:${effect}`,
    });
  }
}

export interface ControlPlaneRuntime {
  readonly service: ControlPlaneService;
  close(): Promise<void>;
}

export interface ControlPlaneStartupOptions {
  readonly identityVerifier?: (observations: readonly IdentityProbe[]) => string;
  readonly adapterFactory?: () => AdapterRegistry;
  readonly serviceFactory?: (deps: ServiceDependencies) => Promise<ControlPlaneService>;
  readonly liveFactory?: (options: {
    readonly registrations: readonly AppRegistration[];
    readonly gateway: FeishuGateway;
    readonly connections: AppConnectionRegistry;
    readonly onCardAction: (role: AppRegistration["role"], data: unknown) => Promise<unknown>;
  }) => OutboxSender & { ready(): Promise<void>; close(): void };
}

export async function startControlPlane(
  config: Config,
  options: ControlPlaneStartupOptions = {},
): Promise<ControlPlaneRuntime> {
  (options.identityVerifier ?? verifyCrossAppIdentity)(
    config.MITISMINE_IDENTITY_PROBES_JSON.observations,
  );
  mkdirSync(config.MITISMINE_DATA_DIR, { recursive: true });
  mkdirSync(dirname(config.MITISMINE_DB_PATH), { recursive: true });
  const shutdown: Array<() => Promise<void> | void> = [];
  let service: ControlPlaneService | undefined;
  try {
    const store = EventStore.open(config.MITISMINE_DB_PATH);
    let storeOpen = true;
    shutdown.push(() => { storeOpen = false; store.close(); });
    const outbox = DurableOutbox.open(config.MITISMINE_DB_PATH);
    shutdown.push(() => outbox.close());
    const discussions = SqliteDiscussionStore.open(config.MITISMINE_DB_PATH);
    shutdown.push(() => discussions.close());
    const checkpoints = SqliteOrchestrationStore.open(config.MITISMINE_DB_PATH);
    shutdown.push(() => checkpoints.close());
    const approvals = SqliteApprovalStore.open(config.MITISMINE_DB_PATH);
    shutdown.push(() => approvals.close());
    const leases = WorkerLeaseStore.open(config.MITISMINE_DB_PATH);
    shutdown.push(() => leases.close());
    leases.requeueExpired();

    const apps = new AppConnectionRegistry();
    const workers = new WorkerRegistry();
    workers.connectPersistent("local");
    const adapters = options.adapterFactory?.() ?? createAdapters(runJsonl);
    const agentConcurrency = new AgentConcurrencyLimiter(6);
    const worker = new LocalWorkerTaskExecutor({ leases });
    const orchestrator = new ResearchOrchestrator({
      adapters,
      store: checkpoints,
      worker,
      limiter: agentConcurrency,
    });
    const recovery = new RecoverySupervisor({ leases, checkpoints, orchestrator });
    const trustedExecutor = new TrustedActionExecutor(resolve(config.MITISMINE_DATA_DIR, "approved-actions"));
    const approval = new ApprovalEngine({
      signingSecret: config.MITISMINE_APPROVAL_KEY,
      store: approvals,
      executor: (action, idempotencyKey) => trustedExecutor.execute(action, idempotencyKey),
    });
    const dispatcher = new ChannelDispatcher({
      orchestrator,
      checkpoints,
      store,
      outbox,
      adapters,
      agentWorkspaceRoot: config.MITISMINE_AGENT_WORKSPACE_ROOT,
      approval,
      limiter: agentConcurrency,
    });
    const discussionCoordinator = new DiscussionCoordinator({
      store: discussions,
      events: store,
      outbox,
      adapters,
      workspaceRoot: config.MITISMINE_AGENT_WORKSPACE_ROOT,
      idFactory: ulid,
      limiter: agentConcurrency,
    });
    discussions.recoverInterrupted();
    const recoverableDiscussions = discussions.recoverableDiscussions().map(({ id }) => id);
    const groupDiscussions = new GroupDiscussionChannel({
      store: discussions,
      events: store,
      coordinator: discussionCoordinator,
      idFactory: ulid,
    });
    groupDiscussions.recoverPendingSteerEvents();
    const gateway = new FeishuGateway({
      store,
      outbox,
      dispatcher,
      idFactory: ulid,
      groupDiscussions,
    });
    const registrations = registrationsFromConfig(config);
    const live = (options.liveFactory ?? ((input) => new FeishuLongConnections(input)))({
      registrations,
      gateway,
      connections: apps,
      onCardAction: async (role, raw) => {
        const value = cardActionValue(raw);
        return typeof value.action === "string" && value.action.startsWith("discussion.")
          ? handleDiscussionCardAction(role, raw, {
              discussion: (id) => discussions.discussion(id),
              control: (id, action, principalId) =>
                discussionCoordinator.control(id, action, principalId),
            })
          : handleApprovalCard(approval, raw);
      },
    });
    const outboxDispatcher = new OutboxDispatcher({
      outbox,
      sender: live,
      deliveryEffects: new DiscussionControlDeliveryEffects({
        store: discussions,
        coordinator: discussionCoordinator,
      }),
    });
    shutdown.push(() => runCleanups([
      () => outboxDispatcher.stop(),
      () => recovery.stop(),
      () => dispatcher.shutdown(),
      () => discussionCoordinator.shutdown(),
      () => live.close(),
    ]));

    service = await (options.serviceFactory ?? createService)({
      storeHealthy: () => storeOpen,
      apps,
      workers,
      shutdown,
    });
    outboxDispatcher.start();
    recovery.start();
    void recovery.runOnce();
    await service.listen({ host: config.MITISMINE_HTTP_HOST, port: config.MITISMINE_HTTP_PORT });
    await live.ready();
    for (const discussionId of recoverableDiscussions) discussionCoordinator.kick(discussionId);
    return { service, close: () => service?.close() ?? Promise.resolve() };
  } catch (startupError) {
    try {
      if (service === undefined) await runCleanups(shutdown);
      else await service.close();
    } catch (cleanupError) {
      throw new AggregateError([startupError, cleanupError], "Control plane startup and cleanup failed");
    }
    throw startupError;
  }
}

async function runCleanups(
  shutdown: readonly (() => Promise<void> | void)[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const stop of [...shutdown].reverse()) {
    try {
      await stop();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Multiple control plane cleanups failed");
}

async function main(): Promise<void> {
  const runtime = await startControlPlane(loadConfig(process.env));
  const shutdown = (): void => {
    void shutdownControlPlane(runtime);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

export async function shutdownControlPlane(
  runtime: ControlPlaneRuntime,
  exit: (code: number) => void = (code) => process.exit(code),
  reportError: (message: string) => void = (message) => console.error(message),
): Promise<void> {
  try {
    await runtime.close();
    exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown cleanup failure";
    reportError(`Control plane shutdown failed: ${message}`);
    exit(1);
  }
}

export function registrationsFromConfig(config: Config): AppRegistration[] {
  const registry = new FeishuAppRegistry([
    { role: "hub", appId: config.FEISHU_HUB_APP_ID, appSecret: config.FEISHU_HUB_APP_SECRET },
    { role: "claude", appId: config.FEISHU_CLAUDE_APP_ID, appSecret: config.FEISHU_CLAUDE_APP_SECRET },
    { role: "codex", appId: config.FEISHU_CODEX_APP_ID, appSecret: config.FEISHU_CODEX_APP_SECRET },
    { role: "copilot", appId: config.FEISHU_COPILOT_APP_ID, appSecret: config.FEISHU_COPILOT_APP_SECRET },
  ]);
  return APP_ROLES.map((role) => registry.get(role));
}

function finalText(events: readonly { readonly type: string; readonly [key: string]: unknown }[]): string {
  const fatal = events.find(
    (event) => event.type === "error" && event.code !== "process_stderr",
  );
  if (fatal !== undefined) {
    const code = typeof fatal.code === "string" ? fatal.code : "provider_error";
    throw new Error(`Direct provider failed with ${code}`);
  }
  const event = [...events].reverse().find(
    (candidate) => candidate.type === "final" && typeof candidate.text === "string",
  );
  if (event === undefined || typeof event.text !== "string") {
    throw new Error("Direct provider did not emit a final event");
  }
  return event.text;
}

function renderReport(report: { readonly summary: string; readonly claims: readonly { readonly text: string; readonly status: string }[] }): string {
  const claims = report.claims.map((claim) => `- [${claim.status}] ${claim.text}`).join("\n");
  return `${report.summary}\n\n${claims}`;
}

async function handleApprovalCard(approval: ApprovalEngine, raw: unknown): Promise<unknown> {
  const root = asObject(raw, "card action");
  const value = cardActionValue(raw);
  if (value.action !== "approve" || typeof value.token !== "string") {
    return { toast: { type: "warning", content: "未执行" } };
  }
  const operator = asObject(root.operator, "card action operator");
  const expectedPrincipal = approval.principalForToken(value.token);
  const parts = expectedPrincipal.split(":");
  const identityType = parts.at(-2);
  const identityValue = parts.at(-1);
  const actual = identityType === "user" ? operator.user_id : operator.union_id;
  if (typeof actual !== "string" || actual !== identityValue) {
    throw new Error("Approval card operator does not match token principal");
  }
  await approval.approve(value.token, expectedPrincipal);
  return { toast: { type: "success", content: "已批准并执行" } };
}

function cardActionValue(raw: unknown): Record<string, unknown> {
  const root = asObject(raw, "card action");
  const action = asObject(root.action, "card action payload");
  return asObject(action.value, "card action value");
}

export async function handleDiscussionCardAction(
  role: AppRegistration["role"],
  raw: unknown,
  coordinator: {
    discussion(id: string): Pick<
      GroupDiscussion,
      "tenantKey" | "chatId" | "controlMessageId" | "version"
    > | undefined;
    control(id: string, action: DiscussionAction, principalId: string): Promise<void>;
  },
): Promise<unknown> {
  if (role !== "hub") throw new Error("Discussion controls are only accepted by the Hub App");
  const root = asObject(raw, "card action");
  const action = asObject(root.action, "card action payload");
  const value = asObject(action.value, "card action value");
  const rawAction = value.action;
  const discussionId = value.discussionId;
  const version = value.version;
  if (
    typeof rawAction !== "string"
    || !rawAction.startsWith("discussion.")
    || !["pause", "resume", "summarize", "stop"].includes(rawAction.slice("discussion.".length))
    || typeof discussionId !== "string"
    || !discussionId
    || typeof version !== "number"
    || !Number.isInteger(version)
    || version < 0
  ) {
    throw new Error("Discussion card action is invalid");
  }
  const discussion = coordinator.discussion(discussionId);
  if (discussion === undefined) throw new Error(`Discussion not found: ${discussionId}`);
  const operator = asObject(root.operator, "card action operator");
  const context = asObject(root.context, "card action context");
  if (
    operator.tenant_key !== discussion.tenantKey
    || context.open_chat_id !== discussion.chatId
    || discussion.controlMessageId === undefined
    || context.open_message_id !== discussion.controlMessageId
  ) {
    throw new Error("Discussion card tenant or message context does not match");
  }
  if (version !== discussion.version) {
    return { toast: { type: "warning", content: "状态已更新，请使用最新卡片" } };
  }
  const principalId = resolvePrincipal({
    tenantKey: discussion.tenantKey,
    ...(typeof operator.user_id === "string" ? { userId: operator.user_id } : {}),
    ...(typeof operator.union_id === "string" ? { unionId: operator.union_id } : {}),
  });
  const discussionAction = rawAction.slice("discussion.".length) as DiscussionAction;
  await coordinator.control(discussionId, discussionAction, principalId);
  const content: Record<DiscussionAction, string> = {
    pause: "已暂停",
    resume: "已继续",
    summarize: "正在总结",
    stop: "已停止",
  };
  return { toast: { type: "success", content: content[discussionAction] } };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main();
}
