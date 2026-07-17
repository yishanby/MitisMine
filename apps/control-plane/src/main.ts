import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import Fastify, { type FastifyInstance } from "fastify";
import { ulid } from "ulid";

import { createAdapters, type AdapterRegistry } from "../../../packages/agent-adapters/src/index.js";
import { runJsonl } from "../../../packages/agent-protocol/src/runner.js";
import { textCard } from "../../../packages/feishu/src/cards.js";
import {
  FeishuGateway,
  type DispatchInput,
  type FeishuDispatcher,
} from "../../../packages/feishu/src/gateway.js";
import { FeishuLongConnections } from "../../../packages/feishu/src/live.js";
import { OutboxDispatcher } from "../../../packages/feishu/src/outbox-dispatcher.js";
import { type AppRegistration } from "../../../packages/feishu/src/registry.js";
import { ResearchOrchestrator } from "../../../packages/orchestrator/src/index.js";
import { SqliteOrchestrationStore } from "../../../packages/storage/src/orchestration.js";
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

class ChannelDispatcher implements FeishuDispatcher {
  readonly #orchestrator: ResearchOrchestrator;
  readonly #checkpoints: SqliteOrchestrationStore;
  readonly #store: EventStore;
  readonly #outbox: DurableOutbox;
  readonly #adapters: AdapterRegistry;
  readonly #dataDirectory: string;

  constructor(options: {
    orchestrator: ResearchOrchestrator;
    checkpoints: SqliteOrchestrationStore;
    store: EventStore;
    outbox: DurableOutbox;
    adapters: AdapterRegistry;
    dataDirectory: string;
  }) {
    this.#orchestrator = options.orchestrator;
    this.#checkpoints = options.checkpoints;
    this.#store = options.store;
    this.#outbox = options.outbox;
    this.#adapters = options.adapters;
    this.#dataDirectory = options.dataDirectory;
  }

  async dispatch(input: DispatchInput): Promise<void> {
    this.#enqueue(input, "已接收", input.mode === "control" ? input.action : "任务已进入队列");
    void this.#handle(input).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown failure";
      this.#enqueue(input, "任务失败", message);
    });
  }

  async #handle(input: DispatchInput): Promise<void> {
    if (input.mode === "research") {
      const runId = ulid();
      const result = await this.#orchestrator.start({
        runId,
        topicId: input.topicId,
        question: input.question,
        cwd: this.#workspace(input.topicId),
      });
      this.#store.append({
        topicId: input.topicId,
        type: "research.completed",
        actorPrincipalId: input.principalId,
        payload: { runId, state: result.run.state, report: result.report },
      });
      this.#enqueue(
        input,
        result.run.unresolved ? "调研完成（存在未决争议）" : "调研完成",
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
        prompt: input.question,
        cwd: this.#workspace(input.topicId),
      };
      const result = previous?.externalSessionId === undefined
        ? await adapter.start(task)
        : await adapter.resume({ ...task, externalSessionId: previous.externalSessionId });
      this.#store.upsertAgentSession({
        id: previous?.id ?? `direct:${input.topicId}:${input.provider}`,
        topicId: input.topicId,
        provider: input.provider,
        role: "direct",
        externalSessionId: result.externalSessionId,
        contextWatermark: this.#store.topic(input.topicId)?.lastEventSeq ?? 0,
        status: "active",
      });
      const text = finalText(result.events);
      this.#store.append({
        topicId: input.topicId,
        type: "agent.direct.completed",
        actorPrincipalId: input.principalId,
        payload: { provider: input.provider, externalSessionId: result.externalSessionId, text },
      });
      this.#enqueue(input, `${input.provider} 回复`, text);
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
    this.#enqueue(input, "停止请求", "停止信号已记录；正在运行的子进程将在安全检查点终止。 ");
  }

  #workspace(topicId: string): string {
    const root = resolve(this.#dataDirectory, "topics");
    const workspace = resolve(root, topicId);
    if (workspace !== root && !workspace.startsWith(`${root}\\`) && !workspace.startsWith(`${root}/`)) {
      throw new Error("Topic workspace escapes the configured data directory");
    }
    mkdirSync(workspace, { recursive: true });
    return workspace;
  }

  #enqueue(input: DispatchInput, title: string, content: string): void {
    const id = ulid();
    this.#outbox.enqueue({
      id,
      appRole: input.replyAppRole,
      receiveId: input.receiveId,
      payload: textCard(title, content),
      idempotencyKey: `dispatch:${input.topicId}:${id}`,
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
  const leases = WorkerLeaseStore.open(config.MITISMINE_DB_PATH);
  leases.requeueExpired();
  const apps = new AppConnectionRegistry();
  const workers = new WorkerRegistry();
  workers.connect("local");
  const adapters = createAdapters(runJsonl);
  const orchestrator = new ResearchOrchestrator({ adapters, store: checkpoints, maxConcurrency: 6 });
  const dispatcher = new ChannelDispatcher({
    orchestrator,
    checkpoints,
    store,
    outbox,
    adapters,
    dataDirectory: config.MITISMINE_DATA_DIR,
  });
  const gateway = new FeishuGateway({ store, outbox, dispatcher, idFactory: ulid });
  const registrations = registrationsFromConfig(config);
  const live = new FeishuLongConnections({ registrations, gateway, connections: apps });
  const outboxDispatcher = new OutboxDispatcher({ outbox, sender: live });
  let storeOpen = true;
  const service = await createService({
    storeHealthy: () => storeOpen,
    apps,
    workers,
    shutdown: [
      () => { store.close(); storeOpen = false; },
      () => checkpoints.close(),
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

function registrationsFromConfig(config: Config): AppRegistration[] {
  return [
    { role: "hub", appId: config.FEISHU_HUB_APP_ID, appSecret: config.FEISHU_HUB_APP_SECRET },
    { role: "claude", appId: config.FEISHU_CLAUDE_APP_ID, appSecret: config.FEISHU_CLAUDE_APP_SECRET },
    { role: "codex", appId: config.FEISHU_CODEX_APP_ID, appSecret: config.FEISHU_CODEX_APP_SECRET },
    { role: "copilot", appId: config.FEISHU_COPILOT_APP_ID, appSecret: config.FEISHU_COPILOT_APP_SECRET },
  ];
}

function finalText(events: readonly { readonly type: string; readonly [key: string]: unknown }[]): string {
  const event = [...events].reverse().find(
    (candidate) => candidate.type === "final" && typeof candidate.text === "string",
  );
  return event !== undefined && typeof event.text === "string" ? event.text : "未收到最终文本";
}

function renderReport(report: { readonly summary: string; readonly claims: readonly { readonly text: string; readonly status: string }[] }): string {
  const claims = report.claims.map((claim) => `- [${claim.status}] ${claim.text}`).join("\n");
  return `${report.summary}\n\n${claims}`;
}

const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  void main();
}
