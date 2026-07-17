import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { ulid } from "ulid";

import { createAdapters, type AdapterRegistry } from "../../../packages/agent-adapters/src/index.js";
import { runJsonl } from "../../../packages/agent-protocol/src/runner.js";
import { compileContext } from "../../../packages/domain/src/context.js";
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
import { OutboxDispatcher } from "../../../packages/feishu/src/outbox-dispatcher.js";
import {
  APP_ROLES,
  FeishuAppRegistry,
  type AppRegistration,
} from "../../../packages/feishu/src/registry.js";
import { ResearchOrchestrator } from "../../../packages/orchestrator/src/index.js";
import { directResearchPrompt } from "../../../packages/orchestrator/src/prompts.js";
import { SqliteOrchestrationStore } from "../../../packages/storage/src/orchestration.js";
import { SqliteApprovalStore } from "../../../packages/storage/src/approval.js";
import { DurableOutbox } from "../../../packages/storage/src/outbox.js";
import { EventStore } from "../../../packages/storage/src/store.js";
import { WorkerLeaseStore } from "../../worker/src/main.js";
import { loadConfig, type Config } from "./config.js";

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
    for (const stop of [...(deps.shutdown ?? [])].reverse()) await stop();
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

  constructor(options: {
    orchestrator: Pick<ResearchOrchestrator, "start" | "resume" | "cancel">;
    checkpoints: Pick<SqliteOrchestrationStore, "load" | "latestForTopic">;
    store: EventStore;
    outbox: DurableOutbox;
    adapters: AdapterRegistry;
    agentWorkspaceRoot: string;
    approval: Pick<ApprovalEngine, "request">;
  }) {
    this.#orchestrator = options.orchestrator;
    this.#checkpoints = options.checkpoints;
    this.#store = options.store;
    this.#outbox = options.outbox;
    this.#adapters = options.adapters;
    this.#agentWorkspaceRoot = options.agentWorkspaceRoot;
    this.#approval = options.approval;
  }

  async dispatch(input: DispatchInput): Promise<void> {
    this.#enqueue(
      input,
      "已接收",
      input.mode === "control" ? input.action : "任务已进入队列",
      "accepted",
    );
    const handling = this.#handle(input);
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
    });
  }

  async #handle(input: DispatchInput): Promise<void> {
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
          ? "调���已停止"
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
      const previous = this.#store.agentSession(input.topicId, input.provider, "direct");
      const task = {
        topicId: input.topicId,
        runId: `direct-${ulid()}`,
        prompt: directResearchPrompt(input.question, this.#contextPack(input.topicId)),
        cwd: this.#workspace(input.topicId),
      };
      const result = previous?.externalSessionId === undefined
        ? await adapter.start(task)
        : await adapter.resume({ ...task, externalSessionId: previous.externalSessionId });
      const text = finalText(result.events);
      this.#store.upsertAgentSession({
        id: previous?.id ?? `direct:${input.topicId}:${input.provider}`,
        topicId: input.topicId,
        provider: input.provider,
        role: "direct",
        externalSessionId: result.externalSessionId,
        contextWatermark: this.#store.topic(input.topicId)?.lastEventSeq ?? 0,
        status: "active",
      });
      this.#store.append({
        topicId: input.topicId,
        type: "agent.direct.completed",
        actorPrincipalId: input.principalId,
        payload: { provider: input.provider, externalSessionId: result.externalSessionId, text },
        idempotencyKey: `${input.idempotencyKey}:direct-completed`,
      });
      this.#enqueue(input, `${input.provider} 回复`, text);
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

  #contextPack(topicId: string): string {
    const topic = this.#store.topic(topicId);
    if (topic === undefined) throw new Error(`Topic not found: ${topicId}`);
    const events = this.#store.events(topicId).map((event) => {
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

export async function startControlPlane(config: Config): Promise<ControlPlaneRuntime> {
  mkdirSync(config.MITISMINE_DATA_DIR, { recursive: true });
  mkdirSync(dirname(config.MITISMINE_DB_PATH), { recursive: true });
  const store = EventStore.open(config.MITISMINE_DB_PATH);
  const outbox = DurableOutbox.open(config.MITISMINE_DB_PATH);
  const checkpoints = SqliteOrchestrationStore.open(config.MITISMINE_DB_PATH);
  const approvals = SqliteApprovalStore.open(config.MITISMINE_DB_PATH);
  const leases = WorkerLeaseStore.open(config.MITISMINE_DB_PATH);
  leases.requeueExpired();
  const apps = new AppConnectionRegistry();
  const workers = new WorkerRegistry();
  workers.connectPersistent("local");
  const adapters = createAdapters(runJsonl);
  const orchestrator = new ResearchOrchestrator({ adapters, store: checkpoints, maxConcurrency: 6 });
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
  });
  const gateway = new FeishuGateway({ store, outbox, dispatcher, idFactory: ulid });
  const registrations = registrationsFromConfig(config);
  const live = new FeishuLongConnections({
    registrations,
    gateway,
    connections: apps,
    onCardAction: async (_role, raw) => handleApprovalCard(approval, raw),
  });
  const outboxDispatcher = new OutboxDispatcher({ outbox, sender: live });
  let storeOpen = true;
  const service = await createService({
    storeHealthy: () => storeOpen,
    apps,
    workers,
    shutdown: [
      () => { store.close(); storeOpen = false; },
      () => checkpoints.close(),
      () => approvals.close(),
      () => leases.close(),
      () => outbox.close(),
      () => live.close(),
      () => outboxDispatcher.stop(),
    ],
  });
  await service.listen({ host: config.MITISMINE_HTTP_HOST, port: config.MITISMINE_HTTP_PORT });
  await live.ready();
  outboxDispatcher.start();
  for (const runId of checkpoints.nonTerminalRunIds()) {
    void orchestrator.resume(runId).catch(() => undefined);
  }
  return { service, close: () => service.close() };
}

async function main(): Promise<void> {
  const runtime = await startControlPlane(loadConfig(process.env));
  const shutdown = (): void => {
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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
  const action = asObject(root.action, "card action payload");
  const value = asObject(action.value, "card action value");
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
