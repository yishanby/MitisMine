# Visible Feishu Group Discussion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable Feishu group mode where Hub automatically moderates visible Claude/Codex/Copilot turns while users can steer and control the discussion at any time.

**Architecture:** A group-only Gateway path persists one active Discussion per chat. A dedicated `DiscussionCoordinator` serializes visible provider turns, consumes steer messages, resumes provider CLI sessions, and updates a single Hub control card through an operation-aware durable Outbox. P2P research and direct multi-Session paths remain unchanged.

**Tech Stack:** Node.js 24, TypeScript, Vitest, built-in `node:sqlite`, Feishu Node SDK persistent connections, existing adapter and Outbox ports.

---

## File map

```text
packages/domain/src/discussion.ts               Pure state transitions and provider rotation
packages/storage/src/discussion.ts              SQLite Discussion/steer/turn projection API
packages/storage/src/schema.ts                  Group tables and Outbox delivery columns
packages/storage/src/outbox.ts                  Create/update operations and delivery results
packages/feishu/src/gateway.ts                  Group message parsing, dedup, start/steer routing
packages/feishu/src/cards.ts                    Discussion control card rendering
packages/feishu/src/live.ts                     Feishu create/patch calls and sender-type parsing
packages/feishu/src/outbox-dispatcher.ts        Persist created message IDs and delivery effects
packages/orchestrator/src/discussion.ts          Automatic visible roundtable coordinator
packages/orchestrator/src/prompts.ts             Discussion turn and summary contracts
apps/control-plane/src/main.ts                   Composition, card callbacks, recovery, shutdown
tests/unit/discussion.test.ts                    Pure state-machine tests
tests/integration/discussion-store.test.ts       Persistence, restart, idempotency tests
tests/integration/feishu.test.ts                 Group routing and robot-loop tests
tests/integration/discussion.test.ts             Coordinator, steer and concurrency tests
tests/integration/service.test.ts                Composition/recovery/card callback tests
tests/integration/operations.test.ts             Outbox create/update delivery tests
```

### Task 1: Define the Discussion state machine

**Files:**
- Create: `packages/domain/src/discussion.ts`
- Create: `tests/unit/discussion.test.ts`

- [ ] **Step 1: Write failing transition and rotation tests**

```ts
const run = createDiscussion({ id: "d1", topicId: "t1", tenantKey: "tenant", chatId: "chat", question: "Q" });
expect(nextDiscussionProvider(run)).toBe("claude");
expect(completeDiscussionTurn(run, { provider: "claude", continueDiscussion: true }).nextProvider)
  .toBe("codex");
expect(() => transitionDiscussion(run, "resume")).toThrow(/active/i);
```

- [ ] **Step 2: Run `pnpm test:run tests/unit/discussion.test.ts` and verify module-not-found RED**
- [ ] **Step 3: Implement immutable types and functions**

```ts
export type DiscussionState = "active" | "paused" | "summarizing" | "completed" | "stopped" | "failed";
export const DISCUSSION_PROVIDERS = ["claude", "codex", "copilot"] as const;
export function transitionDiscussion(run: GroupDiscussion, action: "pause" | "resume" | "summarize" | "stop"): GroupDiscussion;
export function completeDiscussionTurn(run: GroupDiscussion, result: DiscussionTurnResult): GroupDiscussion;
export function shouldSummarize(roundVotes: readonly boolean[], round: number, maxRounds: number): boolean;
```

- [ ] **Step 4: Run focused tests and `pnpm typecheck`**
- [ ] **Step 5: Commit `feat: add visible discussion state machine`**

### Task 2: Persist chats, Discussions, steers and turns

**Files:**
- Modify: `packages/storage/src/schema.ts`
- Create: `packages/storage/src/discussion.ts`
- Create: `tests/integration/discussion-store.test.ts`

- [ ] **Step 1: Write failing tests for group binding and one-active-run invariant**

```ts
store.bindChatTopic("tenant", "chat", "topic-1");
expect(store.chatTopic("tenant", "chat")).toBe("topic-1");
store.createDiscussion(discussion);
expect(() => store.createDiscussion({ ...discussion, id: "d2" })).toThrow(/active discussion/i);
```

- [ ] **Step 2: Verify RED** with `pnpm test:run tests/integration/discussion-store.test.ts`.
- [ ] **Step 3: Add the four tables and a partial unique active-chat index** for `group_chat_topics`, `group_discussions`, `discussion_steers`, and `discussion_turns` exactly as defined in the spec.
- [ ] **Step 4: Implement `SqliteDiscussionStore`** with transactional methods:

```ts
createDiscussion(input: GroupDiscussion): GroupDiscussion;
activeForChat(tenantKey: string, chatId: string): GroupDiscussion | undefined;
recordSteer(input: DiscussionSteerInput): { steer: DiscussionSteer; inserted: boolean };
pendingSteers(discussionId: string): DiscussionSteer[];
claimNextTurn(discussionId: string, turn: DiscussionTurn): boolean;
completeTurn(input: CompleteDiscussionTurnInput): void;
recoverInterrupted(): { discussionIds: string[]; turnIds: string[] };
```

- [ ] **Step 5: Add RED/GREEN restart tests** proving running turns requeue, pending steer survives, provider/session cursor remains, and duplicate Feishu message IDs enrich but do not duplicate steer.
- [ ] **Step 6: Run focused tests and typecheck.**
- [ ] **Step 7: Commit `feat: persist group discussions and steers`**.

### Task 3: Make Outbox support one updatable control card

**Files:**
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/outbox.ts`
- Modify: `packages/feishu/src/live.ts`
- Modify: `packages/feishu/src/outbox-dispatcher.ts`
- Test: `tests/integration/operations.test.ts`

- [ ] **Step 1: Write failing create/update delivery tests** asserting create returns `messageId`, update calls patch with that ID, and retry retains the same operation target.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Extend Outbox inputs and rows**:

```ts
type OutboxOperation = "create" | "update";
interface EnqueueOutboxInput {
  operation?: OutboxOperation;
  targetMessageId?: string;
  deliveryEffect?: { kind: "discussion.control.created"; discussionId: string };
}
interface OutboxSendResult { messageId?: string }
```

- [ ] **Step 4: Implement Feishu SDK calls**: `create` uses `im.v1.message.create`; `update` uses `im.v1.message.patch` with `{ message_id }`. Return the created message ID without logging response bodies.
- [ ] **Step 5: Add `OutboxDeliveryEffects` port**; after a successful create, transactionally save the result and call `recordControlMessage(discussionId, messageId)`. Replayed sends return the stored result and never create a second control card.
- [ ] **Step 6: Run focused tests, existing Outbox replay tests, and typecheck.**
- [ ] **Step 7: Commit `feat: support durable Feishu card updates`**.

### Task 4: Parse and route group messages without bot loops

**Files:**
- Modify: `packages/feishu/src/gateway.ts`
- Modify: `packages/feishu/src/live.ts`
- Test: `tests/integration/feishu.test.ts`

- [ ] **Step 1: Add failing SDK parsing tests** for `chat_type="group"`, `sender_type="user"`, and `sender_type="app"`.
- [ ] **Step 2: Add failing routing tests** proving:
  - P2P still uses existing paths;
  - first human Hub group message starts one Discussion;
  - later human messages become one steer even when delivered through two Apps;
  - provider-App receipt enriches `preferredProvider`;
  - app/bot senders are ignored before identity resolution and cannot claim an inbox event.
- [ ] **Step 3: Verify RED.**
- [ ] **Step 4: Extend event types**:

```ts
interface FeishuMessageEvent {
  chatType: "p2p" | "group";
  senderType: "user" | "app" | "bot" | "unknown";
}
interface GroupDiscussionPort {
  start(input: StartGroupDiscussionInput): Promise<void>;
  steer(input: GroupSteerInput): Promise<void>;
}
```

- [ ] **Step 5: Implement group-only routing** before existing command parsing; strip bot mention placeholders from the question, bind chat Topic, and use message ID as the cross-App steer key.
- [ ] **Step 6: Run Feishu tests and typecheck.**
- [ ] **Step 7: Commit `feat: route human Feishu group discussions`**.

### Task 5: Render the single Discussion control card

**Files:**
- Modify: `packages/feishu/src/cards.ts`
- Create: `tests/unit/discussion-card.test.ts`

- [ ] **Step 1: Write failing snapshot-free structural tests** for active, paused, summarizing, and terminal cards.
- [ ] **Step 2: Verify RED.**
- [ ] **Step 3: Implement `discussionCard(view)`** with one dynamic pause/resume button plus summarize and stop buttons. Button values contain only `action`, `discussionId`, and `version`.
- [ ] **Step 4: Verify the card never includes prompts, external Session IDs, Secrets, or full transcript text.**
- [ ] **Step 5: Run focused tests and commit `feat: add group discussion control card`**.

### Task 6: Implement automatic visible roundtable turns

**Files:**
- Create: `packages/orchestrator/src/discussion.ts`
- Modify: `packages/orchestrator/src/prompts.ts`
- Create: `tests/integration/discussion.test.ts`

- [ ] **Step 1: Write a failing one-round test** with deterministic adapters and an in-memory Outbox, expecting messages from `claude`, `codex`, and `copilot` in order.
- [ ] **Step 2: Write a failing steer test** where steer arrives while Claude is running and Codex's prompt must contain it before any older context.
- [ ] **Step 3: Write failing tests** for preferred provider, full-round consensus, three-round cap, same-Discussion serialization, different-Discussion concurrency, partial provider failure, pause abort, and shutdown drain.
- [ ] **Step 4: Verify all new tests fail for missing coordinator behavior.**
- [ ] **Step 5: Implement prompts and strict parser**:

```ts
interface DiscussionAgentOutput {
  message: string;
  continueDiscussion: boolean;
  openQuestions: string[];
}
export function discussionTurnPrompt(input: DiscussionPromptInput): string;
export function discussionSummaryPrompt(input: DiscussionSummaryInput): string;
```

- [ ] **Step 6: Implement `DiscussionCoordinator`** with keyed run loops, persisted turn claims, provider `agent_sessions`, visible provider Outbox messages, card refresh requests, and summary transition.
- [ ] **Step 7: Run focused tests and typecheck.**
- [ ] **Step 8: Commit `feat: orchestrate visible automatic discussions`**.

### Task 7: Add card controls, recovery and composition

**Files:**
- Modify: `apps/control-plane/src/main.ts`
- Modify: `apps/control-plane/src/recovery.ts`
- Test: `tests/integration/service.test.ts`

- [ ] **Step 1: Write failing control callback tests** for pause, resume, summarize, stop, wrong-App rejection, illegal transition, operator identity, owner-only stop, and callback replay.
- [ ] **Step 2: Write a failing startup recovery test** proving active Discussions resume only after stores, Outbox, adapters, and four App connections are composed.
- [ ] **Step 3: Verify RED.**
- [ ] **Step 4: Compose `SqliteDiscussionStore`, `DiscussionCoordinator`, delivery effects, and Gateway port.** Route Hub control callbacks before approval callbacks using a strict action discriminator.
- [ ] **Step 5: Extend graceful shutdown** to stop accepting group work, abort provider turns, await loops, then close stores in reverse order.
- [ ] **Step 6: Run service tests, full integration tests, and typecheck.**
- [ ] **Step 7: Commit `feat: compose recoverable group discussions`**.

### Task 8: Documentation, audit and live group smoke

**Files:**
- Modify: `README.md`
- Modify: `docs/operator-guide.md`
- Modify: `docs/completion-audit.md`
- Create: `docs/group-discussion-smoke-report.md`

- [ ] **Step 1: Document group setup**: add all four Apps, required group permissions/events, `@Hub` start, natural steer, card controls, automatic finish, and P2P distinction.
- [ ] **Step 2: Run fresh deterministic verification**:

```powershell
pnpm test:run
pnpm typecheck
pnpm build
pnpm scan:secrets
git diff --check
```

- [ ] **Step 3: Start the real control plane and verify `/ready`** reports store, four Apps, and Worker healthy.
- [ ] **Step 4: In one real Feishu group**, start a bounded low-cost Discussion, steer after the first visible Agent reply, exercise pause/resume and summarize, and verify all three provider App identities plus one unchanged control-card message ID.
- [ ] **Step 5: Record only non-secret IDs/counts and honest provider-auth limitations in the smoke report.**
- [ ] **Step 6: Perform a requirement-by-requirement diff review and commit `docs: document visible group discussion verification`**.
