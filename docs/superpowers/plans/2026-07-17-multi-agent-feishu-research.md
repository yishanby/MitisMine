# MitisMine Multi-Agent Feishu Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify a persistent Feishu channel that coordinates Claude Code, Codex, and Copilot CLI inside shared Topics with evidence-backed cross-review.

**Architecture:** A TypeScript control plane owns Topic state, a durable SQLite event log, Feishu long connections, research orchestration, and approvals. Provider adapters run the three CLIs through one streaming protocol; local and remote workers share the same lease contract. Tests use fake CLI executables and Feishu fixtures before live four-App smoke tests.

**Tech Stack:** Node.js 24, TypeScript, pnpm, Vitest, built-in `node:sqlite`, Zod, Fastify, WebSocket, Pino, `@larksuiteoapi/node-sdk`.

---

## File map

```text
package.json                         Root scripts and dependencies
tsconfig.json                       Strict TypeScript configuration
vitest.config.ts                    Unit/integration test discovery
.env.example                        Non-secret four-App configuration contract
apps/control-plane/src/main.ts      Process composition and shutdown
apps/control-plane/src/config.ts    Validated environment loading
apps/control-plane/src/health.ts    HTTP health/readiness endpoint
apps/worker/src/main.ts             Local/remote worker process
packages/domain/src/model.ts        Domain types and schemas
packages/domain/src/topic.ts        Topic lifecycle and authorization
packages/domain/src/run-machine.ts  ResearchRun transition rules
packages/domain/src/context.ts      Context Pack compiler
packages/domain/src/evidence.ts     Claim/evidence/critique normalization
packages/storage/src/schema.ts      SQLite DDL
packages/storage/src/store.ts       Transactional event store and projections
packages/storage/src/outbox.ts      Durable Feishu delivery queue
packages/agent-protocol/src/types.ts Worker task and event schemas
packages/agent-protocol/src/runner.ts Child-process JSONL runner
packages/agent-adapters/src/*.ts    Claude/Codex/Copilot command adapters
packages/orchestrator/src/index.ts  Durable multi-agent workflow
packages/orchestrator/src/prompts.ts Phase-specific prompts
packages/approval/src/index.ts      Approval tokens and trusted execution
packages/feishu/src/registry.ts     Four-App role registry and identities
packages/feishu/src/commands.ts     Topic/research command parser
packages/feishu/src/cards.ts        Status/report/approval cards
packages/feishu/src/gateway.ts      SDK long connections and event routing
tests/unit/*.test.ts                Pure domain tests
tests/contract/*.test.ts            CLI adapter and secret isolation tests
tests/integration/*.test.ts         Store/orchestrator/Feishu fixture tests
tests/fixtures/fake-agent.mjs       Deterministic fake CLI
tests/live/*.test.ts                Opt-in real CLI and Feishu smoke tests
```

### Task 1: Bootstrap the strict TypeScript project

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.env.example`
- Create: `apps/control-plane/src/config.ts`
- Test: `tests/unit/config.test.ts`

- [ ] **Step 1: Write the failing config test**

```ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/control-plane/src/config.js";

describe("loadConfig", () => {
  it("requires all four Feishu credentials without exposing secrets", () => {
    expect(() => loadConfig({})).toThrow(/FEISHU_HUB_APP_ID/);
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

Run: `pnpm test -- tests/unit/config.test.ts`  
Expected: FAIL because `config.ts` does not exist.

- [ ] **Step 3: Add project configuration and validated config**

```ts
import { z } from "zod";

const schema = z.object({
  MITISMINE_DB_PATH: z.string().default("data/mitismine.db"),
  MITISMINE_DATA_DIR: z.string().default("data"),
  FEISHU_HUB_APP_ID: z.string().min(1), FEISHU_HUB_APP_SECRET: z.string().min(1),
  FEISHU_CLAUDE_APP_ID: z.string().min(1), FEISHU_CLAUDE_APP_SECRET: z.string().min(1),
  FEISHU_CODEX_APP_ID: z.string().min(1), FEISHU_CODEX_APP_SECRET: z.string().min(1),
  FEISHU_COPILOT_APP_ID: z.string().min(1), FEISHU_COPILOT_APP_SECRET: z.string().min(1),
});
export type Config = z.infer<typeof schema>;
export const loadConfig = (env: Record<string, string | undefined>): Config => schema.parse(env);
```

- [ ] **Step 4: Install dependencies and run checks**

Run: `pnpm install && pnpm test -- tests/unit/config.test.ts && pnpm typecheck`  
Expected: one passing test and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vitest.config.ts .env.example apps/control-plane/src/config.ts tests/unit/config.test.ts
git commit -m "chore: bootstrap MitisMine TypeScript service"
```

### Task 2: Implement Topic identity and lifecycle

**Files:**
- Create: `packages/domain/src/model.ts`
- Create: `packages/domain/src/topic.ts`
- Test: `tests/unit/topic.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
import { describe, expect, it } from "vitest";
import { createTopic, canEditTopic, resolvePrincipal } from "../../packages/domain/src/topic.js";

it("uses tenant user_id across apps and falls back to union_id", () => {
  expect(resolvePrincipal({ tenantKey:"t", userId:"u", unionId:"x" })).toBe("t:user:u");
  expect(resolvePrincipal({ tenantKey:"t", unionId:"x" })).toBe("t:union:x");
});

it("creates an active topic owned by the principal", () => {
  const topic = createTopic("Research", "t:user:u", "01JTESTTOPIC0000000000000");
  expect(topic.status).toBe("active");
  expect(canEditTopic(topic, "t:user:u", [])).toBe(true);
});
```

- [ ] **Step 2: Run and see module-not-found failure**

Run: `pnpm test -- tests/unit/topic.test.ts`  
Expected: FAIL before implementation.

- [ ] **Step 3: Implement immutable Topic rules and Zod schemas**

```ts
export const resolvePrincipal = (id: {tenantKey:string; userId?:string; unionId?:string}) => {
  if (id.userId) return `${id.tenantKey}:user:${id.userId}`;
  if (id.unionId) return `${id.tenantKey}:union:${id.unionId}`;
  throw new Error("stable Feishu identity missing");
};
```

- [ ] **Step 4: Verify Topic tests and typecheck**

Run: `pnpm test -- tests/unit/topic.test.ts && pnpm typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain tests/unit/topic.test.ts
git commit -m "feat: add shared Topic identity and lifecycle"
```

### Task 3: Implement the durable SQLite event store

**Files:**
- Create: `packages/storage/src/schema.ts`
- Create: `packages/storage/src/store.ts`
- Test: `tests/integration/store.test.ts`

- [ ] **Step 1: Write failing transaction and replay tests**

```ts
it("appends events with monotonic per-topic sequence and rebuilds projections", () => {
  const store = openTestStore();
  store.append("topic-1", "topic.created", { title:"A" });
  store.append("topic-1", "message.added", { text:"B" });
  expect(store.events("topic-1").map(e => e.seq)).toEqual([1,2]);
  expect(store.topic("topic-1")?.title).toBe("A");
});
```

- [ ] **Step 2: Run and verify failure**

Run: `pnpm test -- tests/integration/store.test.ts`  
Expected: FAIL because storage is absent.

- [ ] **Step 3: Create DDL and transactional append API**

Use `DatabaseSync` with WAL, foreign keys, a unique `(topic_id, seq)`, unique Feishu `event_id`, research runs, sessions, evidence, approvals, and outbox tables. `append()` must acquire `BEGIN IMMEDIATE`, calculate the next sequence, insert the event, update projections, and commit or roll back.

```ts
db.exec("BEGIN IMMEDIATE");
try { const result = writeEventAndProjection(db, input); db.exec("COMMIT"); return result; }
catch (error) { db.exec("ROLLBACK"); throw error; }
```

- [ ] **Step 4: Verify WAL replay and restart**

Run: `pnpm test -- tests/integration/store.test.ts`  
Expected: PASS including reopening a temporary database.

- [ ] **Step 5: Commit**

```bash
git add packages/storage tests/integration/store.test.ts
git commit -m "feat: add durable Topic event store"
```

### Task 4: Build Context Pack and evidence normalization

**Files:**
- Create: `packages/domain/src/context.ts`
- Create: `packages/domain/src/evidence.ts`
- Test: `tests/unit/context.test.ts`
- Test: `tests/unit/evidence.test.ts`

- [ ] **Step 1: Write failing tests for bounded context and evidence coverage**

```ts
it("keeps the summary, recent events, evidence, and source watermark", () => {
  const pack = compileContext({ maxChars:8000, summary:"S", events, evidence, watermark:42 });
  expect(pack.watermark).toBe(42);
  expect(pack.summary).toBe("S");
  expect(pack.serialized.length).toBeLessThanOrEqual(8000);
});

it("marks important unsupported claims", () => {
  expect(normalizeReport(reportWithUnsupportedClaim).claims[0].status).toBe("unsupported");
});
```

- [ ] **Step 2: Verify failures**

Run: `pnpm test -- tests/unit/context.test.ts tests/unit/evidence.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement deterministic compaction and Zod report schema**

The compiler orders pinned artifacts, active claims, recent events, then older relevant events; it truncates only event bodies and never drops evidence identifiers. Evidence hashes use SHA-256 over normalized URL, quote, and retrieval timestamp.

- [ ] **Step 4: Verify tests**

Run: `pnpm test -- tests/unit/context.test.ts tests/unit/evidence.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain tests/unit/context.test.ts tests/unit/evidence.test.ts
git commit -m "feat: compile bounded evidence context"
```

### Task 5: Implement ResearchRun state machine

**Files:**
- Create: `packages/domain/src/run-machine.ts`
- Test: `tests/unit/run-machine.test.ts`

- [ ] **Step 1: Write failing transition tests**

```ts
it("allows three rounds and then completes with unresolved disputes", () => {
  let run = queuedRun();
  run = transition(run, {type:"START"});
  run = transition(run, {type:"NORMALIZED"});
  run = transition(run, {type:"REVIEWED", openMediumHigh:1});
  run = transition(run, {type:"REVIEWED", openMediumHigh:1});
  run = transition(run, {type:"REVIEWED", openMediumHigh:1});
  expect(run.state).toBe("synthesize");
  expect(run.unresolved).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/unit/run-machine.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement exhaustive event/state transitions**

Use a discriminated union and `assertNever`; invalid transitions throw `InvalidTransitionError`. Persist round changes only through returned immutable state.

- [ ] **Step 4: Verify tests and typecheck**

Run: `pnpm test -- tests/unit/run-machine.test.ts && pnpm typecheck`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/run-machine.ts tests/unit/run-machine.test.ts
git commit -m "feat: add durable research state machine"
```

### Task 6: Define worker protocol and secure JSONL process runner

**Files:**
- Create: `packages/agent-protocol/src/types.ts`
- Create: `packages/agent-protocol/src/runner.ts`
- Create: `tests/fixtures/fake-agent.mjs`
- Test: `tests/contract/runner.test.ts`

- [ ] **Step 1: Write failing runner tests**

```ts
it("streams JSONL and removes Feishu secrets from the child environment", async () => {
  const events = await collect(runJsonl({ command:process.execPath, args:[fake,"env"], env:{FEISHU_HUB_APP_SECRET:"secret",SAFE:"yes"} }));
  expect(events.at(-1)).toMatchObject({type:"final", safe:"yes", leaked:false});
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/contract/runner.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement timeout, cancellation, line limits, and curated env**

The child receives only `PATH`, home, provider auth variables, locale, and explicitly allowed values. Keys matching `SECRET|TOKEN|COOKIE|AUTHORIZATION|FEISHU|LARK` are removed unless provider-auth allowlisted. Malformed JSONL becomes a structured error event; stderr is size-limited.

- [ ] **Step 4: Verify contract tests**

Run: `pnpm test -- tests/contract/runner.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-protocol tests/fixtures/fake-agent.mjs tests/contract/runner.test.ts
git commit -m "feat: add secure streaming agent runner"
```

### Task 7: Implement Claude, Codex, and Copilot adapters

**Files:**
- Create: `packages/agent-adapters/src/types.ts`
- Create: `packages/agent-adapters/src/claude.ts`
- Create: `packages/agent-adapters/src/codex.ts`
- Create: `packages/agent-adapters/src/copilot.ts`
- Create: `packages/agent-adapters/src/index.ts`
- Test: `tests/contract/adapters.test.ts`

- [ ] **Step 1: Write failing command/session tests**

```ts
it.each(["claude","codex","copilot"] as const)("%s starts and resumes the same Topic session", async provider => {
  const adapter = adapters[provider](fakeRunner);
  const first = await adapter.start(task);
  const second = await adapter.resume({...task, externalSessionId:first.externalSessionId});
  expect(second.externalSessionId).toBe(first.externalSessionId);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/contract/adapters.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement exact CLI argument builders and event parsers**

Claude uses print/stream-json and `--resume`; Codex uses `exec --json --sandbox read-only` and `exec resume`; Copilot uses prompt/json, a fixed session UUID, `--no-ask-user`, and secret redaction. Each parser emits the shared protocol and captures the provider session ID.

- [ ] **Step 4: Verify fake-adapter contracts**

Run: `pnpm test -- tests/contract/adapters.test.ts`  
Expected: PASS for all three rows.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-adapters tests/contract/adapters.test.ts
git commit -m "feat: add three persistent CLI adapters"
```

### Task 8: Implement the multi-agent orchestrator

**Files:**
- Create: `packages/orchestrator/src/prompts.ts`
- Create: `packages/orchestrator/src/index.ts`
- Test: `tests/integration/orchestrator.test.ts`

- [ ] **Step 1: Write a failing full-workflow test**

```ts
it("fans out independently, cross-reviews all pairs, resolves disputes, and signs off", async () => {
  const result = await harness.run("question");
  expect(result.phases).toEqual(["independent_research","normalize_evidence","cross_review","resolve_disputes","synthesize","signoff","completed"]);
  expect(result.reviews).toHaveLength(6);
  expect(result.report.claims.every(c => c.evidence.length > 0 || c.status === "unsupported")).toBe(true);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/integration/orchestrator.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement durable fan-out, all-to-all review, and rotating synthesis**

Use a provider semaphore of 6, persist before and after every provider call, isolate independent outputs until review, accept at most two subtask proposals per provider, and stop targeted review after round 3.

- [ ] **Step 4: Add restart and partial-failure cases**

Run: `pnpm test -- tests/integration/orchestrator.test.ts`  
Expected: PASS for normal, restart-at-review, two-provider degradation, and fewer-than-two pause.

- [ ] **Step 5: Commit**

```bash
git add packages/orchestrator tests/integration/orchestrator.test.ts
git commit -m "feat: orchestrate evidence-backed agent debate"
```

### Task 9: Implement approval tokens and trusted execution

**Files:**
- Create: `packages/approval/src/index.ts`
- Test: `tests/unit/approval.test.ts`

- [ ] **Step 1: Write failing approval tests**

```ts
it("executes an approved action exactly once and rejects tampering", async () => {
  const request = engine.request(action, owner);
  await engine.approve(request.token, owner);
  await expect(engine.approve(request.token, owner)).rejects.toThrow(/already used/);
  expect(executor.calls).toBe(1);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/unit/approval.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement HMAC-bound tokens, expiry, roles, and idempotency**

Bind the token to request ID, topic ID, principal ID, action SHA-256 and expiration. Store status before execution and completion after execution; retries return the stored result.

- [ ] **Step 4: Verify approval tests**

Run: `pnpm test -- tests/unit/approval.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/approval tests/unit/approval.test.ts
git commit -m "feat: gate privileged actions with Feishu approval"
```

### Task 10: Implement Feishu commands, cards, and four-App routing

**Files:**
- Create: `packages/feishu/src/registry.ts`
- Create: `packages/feishu/src/commands.ts`
- Create: `packages/feishu/src/cards.ts`
- Create: `packages/feishu/src/gateway.ts`
- Create: `tests/fixtures/feishu-message.json`
- Test: `tests/integration/feishu.test.ts`

- [ ] **Step 1: Write failing command and routing tests**

```ts
it("shares a global Topic cursor across four app-specific open_ids", async () => {
  await gateway.receive(message("hub", "/topic new Research"));
  await gateway.receive(message("claude", "continue"));
  expect(harness.lastDispatch()).toMatchObject({provider:"claude", topicTitle:"Research"});
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/integration/feishu.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement parser, role registry, cards, dedupe, and Outbox**

Recognize every command in the design, route ordinary hub text to full research and provider-bot text to direct mode, reject identity mismatches, and persist the Feishu event before responding.

- [ ] **Step 4: Verify fixture tests**

Run: `pnpm test -- tests/integration/feishu.test.ts`  
Expected: PASS including duplicate event and restart cases.

- [ ] **Step 5: Commit**

```bash
git add packages/feishu tests/fixtures/feishu-message.json tests/integration/feishu.test.ts
git commit -m "feat: route four Feishu apps into shared Topics"
```

### Task 11: Compose services, health checks, and worker leases

**Files:**
- Create: `apps/control-plane/src/health.ts`
- Create: `apps/control-plane/src/main.ts`
- Create: `apps/worker/src/main.ts`
- Test: `tests/integration/service.test.ts`

- [ ] **Step 1: Write failing startup/recovery tests**

```ts
it("reports not-ready until store, four apps, and workers are healthy", async () => {
  const app = await createService(fakeDeps({workers:0}));
  expect((await app.inject({url:"/ready"})).statusCode).toBe(503);
  app.deps.workers.connect("local");
  expect((await app.inject({url:"/ready"})).statusCode).toBe(200);
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm test -- tests/integration/service.test.ts`  
Expected: FAIL.

- [ ] **Step 3: Implement graceful startup, lease heartbeat, and restart scan**

On startup migrate the database, replay projections, requeue expired leases, start the outbox, then connect Feishu. On SIGINT/SIGTERM stop accepting events, cancel or checkpoint workers, flush Outbox state, and close SQLite.

- [ ] **Step 4: Verify service tests**

Run: `pnpm test -- tests/integration/service.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps tests/integration/service.test.ts
git commit -m "feat: compose resilient control plane and worker"
```

### Task 12: Configure real App secrets without committing them

**Files:**
- Create ignored file: `.env.local`
- Modify: `.env.example`
- Test: `tests/unit/secret-isolation.test.ts`

- [ ] **Step 1: Read the four secrets from the authenticated Feishu console**

Write values directly to `.env.local`; never print them in terminal or assistant output.

- [ ] **Step 2: Verify Git cannot see secrets**

Run: `git status --short --ignored .env.local && git grep -n "FEISHU_.*APP_SECRET=.*[^<]" -- ':!docs/superpowers/plans/*'`  
Expected: `.env.local` is ignored and grep finds no populated secret.

- [ ] **Step 3: Verify child process isolation**

Run: `pnpm test -- tests/unit/secret-isolation.test.ts tests/contract/runner.test.ts`  
Expected: PASS; fake child reports no Feishu secret variables.

- [ ] **Step 4: Commit only the example and test**

```bash
git add .env.example tests/unit/secret-isolation.test.ts
git commit -m "test: enforce Feishu secret isolation"
```

### Task 13: Run full automated and real CLI verification

**Files:**
- Create: `tests/live/cli-smoke.test.ts`
- Create: `tests/live/README.md`

- [ ] **Step 1: Run all deterministic checks**

Run: `pnpm lint && pnpm typecheck && pnpm test --run`  
Expected: all commands exit 0 with no skipped deterministic tests.

- [ ] **Step 2: Run a minimal real prompt through every installed CLI**

Run: `MITISMINE_LIVE_CLI=1 pnpm test -- tests/live/cli-smoke.test.ts`  
Expected: Claude, Codex, and Copilot each start, return schema-valid JSON, and resume the same session once.

- [ ] **Step 3: Verify no secret or cross-Topic leakage**

Run: `pnpm test -- tests/contract/adapters.test.ts tests/unit/secret-isolation.test.ts`  
Expected: PASS.

- [ ] **Step 4: Commit smoke harness**

```bash
git add tests/live
git commit -m "test: add real three-CLI smoke coverage"
```

### Task 14: Run four-App live Feishu smoke test

**Files:**
- Create: `scripts/live-smoke.ts`
- Create: `docs/live-smoke-report.md`

- [ ] **Step 1: Start the service with all four long connections**

Run: `pnpm start`  
Expected: health endpoint ready, four App roles connected, no secrets in logs.

- [ ] **Step 2: Exercise Topic and full research from Feishu**

Send `/topic new Live smoke`, then `/research Summarize the purpose of RFC 2606 with primary-source evidence` to the hub bot. Send `/status` while running.

Expected: three providers run concurrently, six first-pass cross-reviews are recorded, and the report cites RFC 2606.

- [ ] **Step 3: Exercise direct provider continuation and restart**

Send one follow-up to each provider bot, record their session IDs, restart the service, then send `/report` and another follow-up.

Expected: the same Topic and provider sessions resume; no history is lost.

- [ ] **Step 4: Exercise approval idempotency**

Request a harmless write to a dedicated smoke file, verify no write before approval, approve in Feishu, and click approve again.

Expected: one file write and one stored execution result.

- [ ] **Step 5: Write evidence report and commit**

`docs/live-smoke-report.md` must record timestamps, Topic ID, Run ID, provider session IDs, test commands, pass/fail, and redacted screenshots/log excerpts.

```bash
git add scripts/live-smoke.ts docs/live-smoke-report.md
git commit -m "test: verify live four-app research workflow"
```

### Task 15: Final requirement audit and operator documentation

**Files:**
- Create: `README.md`
- Create: `docs/operator-guide.md`
- Create: `docs/completion-audit.md`

- [ ] **Step 1: Document installation, commands, security, recovery, and troubleshooting**

Include exact pnpm commands, `.env.local` setup, four App roles, Feishu commands, worker registration, backup/restore, database location, log redaction, and safe shutdown.

- [ ] **Step 2: Audit every acceptance criterion against evidence**

For each design acceptance criterion, record the test name or live-smoke evidence that proves it. Mark missing or indirect evidence as incomplete and continue implementation until resolved.

- [ ] **Step 3: Run final verification from a clean process**

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test --run`  
Expected: exit code 0 for all commands.

- [ ] **Step 4: Confirm repository and secret hygiene**

Run: `git status --short && git grep -n -I -E "(app_secret|FEISHU_.*SECRET)=.+" -- . ':!docs/superpowers/plans/*'`  
Expected: clean worktree; no populated secrets.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/operator-guide.md docs/completion-audit.md
git commit -m "docs: add MitisMine operations and completion audit"
```

