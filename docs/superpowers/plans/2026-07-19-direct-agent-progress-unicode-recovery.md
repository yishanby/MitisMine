# Direct Agent Progress and Unicode Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep one Feishu status card current during direct Agent work and recover one corrupted Claude response without guessing characters.

**Architecture:** Adapter tasks receive an optional normalized-event callback. Claude detects invalid final Unicode, resumes the just-created Session once with a rewrite request, and returns only a clean final answer. A focused direct-progress reporter translates safe events into throttled Outbox patches targeting the original accepted message while a 15-second heartbeat covers quiet provider periods.

**Tech Stack:** TypeScript, Vitest, Node child processes, SQLite durable Outbox, Feishu message patch API

---

### Task 1: Stream normalized provider events and recover Claude Unicode

**Files:**
- Modify: `packages/agent-adapters/src/types.ts`
- Modify: `packages/agent-adapters/src/claude.ts`
- Modify: `packages/agent-adapters/src/index.ts`
- Test: `tests/contract/adapters.test.ts`

- [ ] **Step 1: Write failing callback and rewrite tests**

Add tests whose synthetic Claude runner emits normalized Session/tool/delta events immediately and whose first final contains U+FFFD. Assert the callback observes events before completion, exactly one `--resume` rewrite call follows, and the returned final is clean. Add a second test proving two corrupt finals fail after one rewrite.

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: FAIL because `AgentTask` has no event callback and Claude does not rewrite corrupt output.

- [ ] **Step 3: Implement the minimal Adapter boundary**

Add `onEvent?: (event: AgentEvent) => void | Promise<void>` to `AgentTask`. Await it for every normalized event in `collectNormalized`. Add a typed Unicode error carrying only provider and external Session ID. In Claude `start`/`resume`, catch only that error, emit a safe `progress` event, and call `resume` once with a fixed rewrite prompt. Do not retry any other error.

- [ ] **Step 4: Run the adapter tests and verify GREEN**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: all adapter tests pass.

### Task 2: Translate Claude tools and visible text into safe progress events

**Files:**
- Modify: `packages/agent-adapters/src/claude.ts`
- Test: `tests/contract/adapters.test.ts`

- [ ] **Step 1: Write failing normalization tests**

Feed top-level Claude `assistant` events containing `Skill` and `mcp__kusto-tools__execute_kusto_query` tool-use blocks plus stream text deltas. Assert emitted progress contains only safe tool display names and visible text, never tool input, query text, Session ID, or thinking.

- [ ] **Step 2: Run the adapter tests and verify RED**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: FAIL because Claude currently drops tool milestones and exposes no progress event.

- [ ] **Step 3: Implement safe Claude progress normalization**

Map allowlisted tool names to short Chinese milestones. Emit clean `delta` events for visible `text_delta` only. Never copy a tool input object, `thinking_delta`, or provider identifiers into progress messages.

- [ ] **Step 4: Run the adapter tests and verify GREEN**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: all adapter tests pass.

### Task 3: Patch one throttled Feishu progress card

**Files:**
- Create: `apps/control-plane/src/direct-progress.ts`
- Modify: `apps/control-plane/src/main.ts`
- Test: `tests/unit/direct-progress.test.ts`
- Test: `tests/integration/service.test.ts`

- [ ] **Step 1: Write failing reporter tests**

Use a fake clock and Outbox seam. Assert the reporter discovers the accepted message ID, patches the same target, coalesces events inside two seconds, sends a heartbeat after 15 seconds, truncates visible text, and ignores corrupt/hidden fields.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm exec vitest run tests/unit/direct-progress.test.ts tests/integration/service.test.ts`

Expected: FAIL because `DirectProgressReporter` does not exist and direct tasks have no event callback.

- [ ] **Step 3: Implement the reporter and direct wiring**

Create a reporter that reads `outbox:<dispatch-key>:accepted` for its delivered message ID, emits uniquely keyed update operations, and clears its timer on completion/failure. Wire `task.onEvent` in the direct path. Mark the card complete or failed without changing the separate final response behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm exec vitest run tests/unit/direct-progress.test.ts tests/integration/service.test.ts`

Expected: focused tests pass with no leaked provider parameters.

### Task 4: Full and live verification

**Files:**
- Modify: `docs/completion-audit.md`
- Modify: `docs/live-smoke-report.md`
- Modify: `docs/superpowers/specs/2026-07-18-agent-multi-session-design.md`

- [ ] **Step 1: Run repository verification**

Run `pnpm test:run`, `pnpm lint`, `pnpm typecheck`, `pnpm build`, the configured secret scan, and `git diff --check`. Every command must exit zero.

- [ ] **Step 2: Run a real Claude/Kusto direct smoke**

Use the live opt-in path with the Lumina Kusto Skill. Verify at least one Skill/tool milestone reaches the progress callback, no unsafe tool input is present, the final answer is Unicode-clean, and at most one rewrite attempt occurs.

- [ ] **Step 3: Commit, push, and restart**

Commit application code before audit documentation so the audit can name an immutable application SHA. Push `feat/visible-group-discussion`, rebuild, gracefully stop the prior process, start the new build with the existing `.env.local`, and verify `/ready` reports store=true, four Apps, and one Worker.
