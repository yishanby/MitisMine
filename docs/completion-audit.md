# MitisMine completion audit

Audit date: 2026-07-19 (Asia/Shanghai)

Branch: `feat/visible-group-discussion`

Audited application revision: `6dbde98776a26e9270d4de3a3357fe9b668acf62`

This audit covers application code through
`6dbde98776a26e9270d4de3a3357fe9b668acf62`.
The documentation-only commit that
records this final evidence follows that revision and is intentionally not
represented here as audited application code.

The canonical Feishu interaction itself was executed on
`dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a`. Later revisions through the
audited application revision harden crash recovery, summary-steer delivery,
receipt/event reconciliation, startup-query behavior, missing Claude direct
Session replacement, streamed direct progress, and bounded Unicode recovery.
They do not rewrite the immutable canonical Discussion evidence.

PID `58564` was captured in the canonical `dcc1df4` Feishu acceptance window.
The exact CLI durations below come from a separate opt-in run on the current
`6dbde98` application revision; they are not timings of the Feishu interaction.

## Acceptance evidence

| Acceptance criterion | Automated evidence | Live evidence | Status |
|---|---|---|---|
| Four Apps identify one user and share a cursor | Config identity-observation tests; startup verifier ordering; Gateway cross-App tests | Four persisted App observations resolve to one union principal; `/ready` returned HTTP 200 with store=true, four Apps, and one Worker | Pass |
| Topic create/switch/restore/share/archive/history | Topic and Feishu integration suites; durable inbox failure injection | Live Topic survived restarts; `/status` and `/report` reload | Pass |
| Standalone Agent multi-Session | Parser/Gateway/Store/Dispatcher tests cover create/list/use/show/rename/archive, lazy `main`, per-user/provider cursors, start/resume, stale external-Session replacement, streamed progress, one-card patch throttling/heartbeat, isolation, serialization, cross-Session concurrency, restart and legacy migration | A real stale Claude resume was replaced in the same turn. A separate real Claude/Kusto call emitted safe Skill, Kusto, and analysis milestones; an injected corrupt final triggered exactly one same-Session rewrite and returned with zero replacement characters | Pass |
| Visible group Discussion with natural steer | Domain, Gateway, coordinator, card, store, recovery, Unicode guards, and Outbox suites cover one-active-per-chat, three unique speakers per round, same-card patching, steer consumption, pause/resume/summarize/stop, failed providers, turn-index 3/9 crash boundaries, fenced JSON, exact v2/scoped-legacy/minimal-v0 event replay, receipt-first and event-first crash recovery, bound-event replay, terminal tombstones, provider reconciliation, pending-steer summary regeneration, bounded paid retries, and indexed `(topic_id, seq)` recovery lookup | Unicode-clean canonical Discussion `01KXSRVC8DFBMTJRSY1KJKCM5C` completed at round 2/turn index 5/version 19. Claude, Codex, and Copilot produced five visible completed turns. Pause cancelled an in-flight Copilot attempt while retaining its slot; a genuine `MitisMine 总控` entity-mention steer persisted while paused and was consumed by Copilot after resume; Codex corrected an overstrong NFS claim and Copilot accepted the correction. All control updates targeted one control message; Hub sent the summary separately | Pass |
| Owner/editor/viewer enforcement | `canReadTopic`/`canEditTopic`; viewer command matrix | Viewer rules reflected in deployed command path | Pass |
| Three CLIs and Topic sessions | Adapter contracts; cross-Run/restart Topic-session tests | Current-revision real-CLI start+resume suite passed 3/3: Claude 24,770 ms, Codex 31,512 ms, Copilot 53,415 ms; a separate Claude read-only Kusto call used `Skill` and `mcp__kusto-tools__execute_kusto_query` and produced a 1,045-character Unicode-clean final | Pass |
| Context reaches every agent | Context Pack unit test; real Gateway→ChannelDispatcher note/watermark test | Historical Topic/Run remains queryable | Pass |
| Independent fan-out, child sessions, concurrency ≤6 | Orchestrator tests: isolation, six unique child sessions, semaphore cap | Three live reports; no degraded provider | Pass |
| All-pairs review, repair, and ≤3 rounds | Six first-pass reviews; resolution report merge; signoff-only critique; round cap tests | 18 directed reviews over three rounds | Pass |
| Evidence-backed important Claims | Evidence normalization/Context Pack tests | 4 Claims, 5 Evidence, important coverage 2/2; RFC/IETF/IANA sources | Pass |
| Disagreement is not hidden | Run-machine, approved=false, resolution/signoff tests | Research Run completed `unresolved=true`; card stated unresolved disputes. The canonical Discussion surfaced an overstrong WAL/NFS claim, followed by a visible Codex correction and Copilot acknowledgement. This demonstrates cross-provider consensus, not independent empirical or external technical verification | Pass |
| Restart loses no durable state | Store/inbox/checkpoint/session/approval/Outbox/lease restart tests | Service restart returned ready=200; sessions/report/approval remained | Pass |
| Worker calls use lease protocol | Terminal/same-worker exclusion; durable completed-result cache; heartbeat abort/requeue; every Orchestrator call lease assertion; expired same-task resume | `/ready` reports one local Worker | Pass (local transport) |
| Privileged work waits for approval | Approval/Gateway tests, orphaned-executing recovery test | Target absent before click; double click preserved one write/mtime | Pass |
| `/stop` cancels real work | Abort propagation, stale-save guard, process-tree/grandchild test, lease requeue test | Not used on the evidence Run | Pass (automated) |
| Secrets do not reach Git/logs/children | Synthetic secret isolation; redaction; least-privilege adapter contracts; tracked-value scan | `.env.local` ignored/untracked; the recorded scan checked 5 configured keys without exposing a value | Pass |
| Health, safe shutdown, delivery replay | Readiness, all-hook cleanup, startup unwind, pending-call cancel/drain, Outbox stable UUID, active-flush plus newly-queued-output drain, periodic lease recovery tests | Canonical acceptance service PID `58564`: HTTP 200, ready=true, store=true, four Apps, one Worker | Pass |
| Deterministic and live verification | 351 tests passed; 3 live tests remain opt-in and skipped in the deterministic run | Fresh opt-in CLI suite passed 3/3; real Claude progress and Unicode-rewrite paths passed; the Unicode-clean canonical group Discussion completed with all 3 providers producing real visible content; the final recorded lint, typecheck, build, secret scan, source-Unicode scan, and diff checks passed | Pass |

## Verification snapshot

Fresh deterministic run on 2026-07-19:

```text
Test Files  24 passed | 1 skipped (25)
Tests       351 passed | 3 skipped (354)
Duration    10.86 s
```

The three skipped cases are the explicit `MITISMINE_LIVE_CLI=1` suite. A fresh
opt-in run after interactive ChatGPT login passed all three real provider calls:

```text
Node 24.12.0; pnpm 11.9.0
Claude Code 2.1.212; Codex CLI 0.143.0; GitHub Copilot CLI 1.0.72-1
```

```text
tests/live/cli-smoke.test.ts  3 passed (3)
Claude start+resume           24770 ms
Codex start+resume            31512 ms
Copilot start+resume          53415 ms
Tests                         109699 ms
Vitest duration               110.49 s
```

The final recorded `pnpm lint`, `pnpm typecheck`, and `pnpm build` runs passed. The
tracked-secret scan passed for 5 configured keys without exposing a value; no
stale tracked-file count is asserted here. `git diff --check` is rerun for the
documentation commit.

The recorded four-App audit returned:

```text
ready=200 ready=true store=true apps=[hub,claude,codex,copilot] workers=1 pid=58564
research_state=completed round=3 reviews=18 crossReviews=18
claims=4 evidence=5 importantCoverage=2/2
discussion=01KXSRVC8DFBMTJRSY1KJKCM5C state=completed round=2
turn_index=5 version=19 completed_visible_turns=5 providers=3/3
control_message=om_x100b6a84163cb4a0c3dadf616c2fcda
summary_length=324 unicode_replacement_count=0
```

Discussion `01KXSM5XNX4STNQTPR245H86TY` is retained only as historical pre-fix
evidence: a Claude turn and the Hub summary contain U+FFFD, so it is not
canonical, Unicode-clean, polished, or decision-ready evidence. The still
earlier Discussion `01KXSCB2AX0GSY6YNT98S8GN61` remains useful only as a
historical failure-isolation run. Neither qualifies the canonical 3/3 outcome.

## Requirement-to-component map

- Topic authorization/history/context: `packages/domain`, `packages/storage/src/store.ts`, `packages/feishu`
- Direct Session UX/isolation/concurrency: `packages/storage/src/store.ts`, `packages/feishu/src/commands.ts`, `packages/feishu/src/gateway.ts`, `apps/control-plane/src/main.ts`
- Visible Discussion orchestration and evidence: `packages/orchestrator/src/discussion.ts`, `packages/storage/src/discussion.ts`, `packages/feishu`, `docs/group-discussion-smoke-report.md`
- Run workflow and leased local execution: `packages/orchestrator`, `packages/orchestrator/src/worker.ts`, `apps/worker`
- CLI isolation/adaptation: `packages/agent-protocol`, `packages/agent-adapters`
- Approvals: `packages/approval`, `packages/storage/src/approval.ts`
- Four-App channel and idempotent delivery: `packages/feishu`, `apps/control-plane`
- Reproducible audit: `scripts/live-smoke.ts`, `docs/live-smoke-report.md`

## Honest boundaries

- Report/evidence/critique content is durable in checkpoint JSON; normalized
  ledger tables are reserved but not yet the write path.
- Context Packs include Topic metadata, history, and watermark, not a separate
  attachment/Artifact index.
- Local completed effects are idempotent, but a crash during an external direct
  provider turn can require resending the user message.
- Remote Worker transport, leader election, and multi-control-plane HA are not shipped.
- Persistent CLI credential stores belong to a trusted dedicated OS account.
- The canonical group smoke covers one tenant, one group, five completed turns,
  and pause/resume/immediate-summary. Cross-provider acknowledgement establishes
  visible consensus, not independent empirical or external technical
  verification. Stop, natural nine-turn exhaustion, and restart during that
  exact Discussion remain automated or separately evidenced.

## Final command set

```powershell
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test --run
pnpm build
$env:MITISMINE_LIVE_CLI="1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
# In Terminal A: pnpm start
# In Terminal B:
pnpm smoke:live
pnpm scan:secrets
git diff --check
git status --short
```

No App Secret, access token, cookie, authorization value, or user credential is
included in this audit.
