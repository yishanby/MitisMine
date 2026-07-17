# Standalone Agent Multi-Session Implementation Plan

**Goal:** Let each Feishu provider App run independently with multiple persistent, isolated Sessions inside every shared Topic, without changing group research behavior.

**Architecture:** SQLite owns direct Session records and per-user cursors. The Feishu gateway parses provider-only Session commands and resolves the selected Session before dispatch. The channel dispatcher serializes turns by Session ID, resumes the matching CLI external Session, and builds a Context Pack that includes shared Topic events plus only that Session's direct conversation.

**Tech stack:** Node.js 24, TypeScript, built-in `node:sqlite`, Vitest, existing Feishu gateway and agent adapter contracts.

---

### Task 1: Parse the Session command surface

**Files:**
- Modify: `packages/feishu/src/commands.ts`
- Test: `tests/integration/feishu.test.ts`

- [ ] Add failing parser cases for `new`, `list`, `use`, `resume`, `show`, `rename`, and `archive`, including missing-argument errors.
- [ ] Extend the command union with strongly typed Session commands.
- [ ] Keep ordinary message and existing Topic/research command behavior unchanged.
- [ ] Run the focused tests and typecheck.

### Task 2: Persist direct Sessions and cursors

**Files:**
- Modify: `packages/storage/src/schema.ts`
- Modify: `packages/storage/src/store.ts`
- Test: `tests/integration/store.test.ts`

- [ ] Add failing tests for create/list/get/resolve/rename/archive, case-insensitive title uniqueness, independent provider/user cursors, and restart persistence.
- [ ] Add `direct_sessions` and `direct_session_cursors` DDL, indexes, constraints, and TypeScript row/domain mappings.
- [ ] Implement transactional Store methods and validation that cursor/session Topic and provider match.
- [ ] Add failing legacy migration test, then migrate `agent_sessions.role='direct'` rows idempotently to `main` while preserving external IDs and watermarks.
- [ ] Run focused storage tests and typecheck.

### Task 3: Route provider Session commands with permissions

**Files:**
- Modify: `packages/feishu/src/gateway.ts`
- Modify: `packages/feishu/src/cards.ts` if a reusable renderer is needed
- Test: `tests/integration/feishu.test.ts`

- [ ] Add failing tests for provider-only routing, list/show/use read access, mutation edit access, auto-selection, cursor independence, and replay idempotency.
- [ ] Implement human-readable list/show responses with current marker, short ID, status, updated time, external-state indicator, and watermark.
- [ ] Implement `new`, `use`/`resume`, `rename`, and `archive`, including ambiguous selector and conflict errors.
- [ ] Reject Session commands from the hub with provider-App guidance.
- [ ] For a provider ordinary message, lazily create/select `main`, append a Session-tagged message event, and dispatch its stable Session ID.
- [ ] Run focused gateway tests and typecheck.

### Task 4: Resume the selected CLI Session and isolate context

**Files:**
- Modify: `packages/feishu/src/gateway.ts` dispatch input types
- Modify: `apps/control-plane/src/main.ts`
- Test: `tests/integration/service.test.ts`

- [ ] Add failing tests proving two direct Sessions call `start` independently and later call `resume` with their own external IDs.
- [ ] Replace the legacy `(topic, provider, role='direct')` lookup with the dispatched direct Session ID.
- [ ] Tag completion events with `directSessionId` and update only the selected direct Session.
- [ ] Add failing context tests showing shared Topic notes are visible while another direct Session's message/response is absent.
- [ ] Filter direct events in Context Pack construction by the selected Session ID.
- [ ] Preserve the research Context Pack behavior by keeping its unfiltered shared path.
- [ ] Run focused service tests and typecheck.

### Task 5: Serialize same-Session turns and recover failures

**Files:**
- Modify: `apps/control-plane/src/main.ts`
- Test: `tests/integration/service.test.ts`

- [ ] Add a failing deferred-adapter test proving two turns to one Session never overlap.
- [ ] Add a failing test proving turns to different Sessions can overlap.
- [ ] Implement a keyed promise queue with cleanup after success or failure.
- [ ] Mark Sessions `running` only during execution and restore `active` after success/failure.
- [ ] Verify a failed adapter call preserves the previous external Session ID and a later turn can resume it.

### Task 6: Document and audit the user flow

**Files:**
- Modify: `README.md`
- Modify: `docs/operator-guide.md`
- Modify: `docs/completion-audit.md`
- Modify: `docs/live-smoke-report.md` only with actual live evidence

- [ ] Document Topic versus Session, all commands, permissions, lazy `main`, provider cursor scope, and recovery behavior.
- [ ] Add deterministic audit evidence for Session isolation, persistence, concurrency, permissions, migration, and existing group research non-regression.
- [ ] Run secret scanning before recording any output.

### Task 7: Full verification and review

- [ ] Run focused tests after every RED/GREEN slice.
- [ ] Run `pnpm test:run`, `pnpm typecheck`, `pnpm build`, `pnpm scan:secrets`, and `git diff --check`.
- [ ] Review the complete diff for access-control, idempotency, migration, context-isolation, and concurrency bugs.
- [ ] Start the real control plane using the existing non-committed environment and verify all four Feishu long connections without releasing the signed-in browser.
- [ ] Run live provider tests only where the corresponding CLI is authenticated; report authentication limitations as external facts, not as successful verification.
- [ ] Commit implementation and evidence without committing secrets or local runtime data.
