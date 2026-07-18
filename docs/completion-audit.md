# MitisMine completion audit

Audit date: 2026-07-18 (Asia/Shanghai)

Branch: `feat/visible-group-discussion`

Audited code revision: `0b89aa6`

This audit covers code through `0b89aa6`. The documentation-only commit that
records this final evidence follows that revision; its SHA is reported in the
handoff rather than represented here as audited application code.

## Acceptance evidence

| Acceptance criterion | Automated evidence | Live evidence | Status |
|---|---|---|---|
| Four Apps identify one user and share a cursor | Config identity-observation tests; startup verifier ordering; Gateway cross-App tests | Four persisted App observations resolve to one union principal; `/ready` returned HTTP 200 with store=true, four Apps, and one Worker | Pass |
| Topic create/switch/restore/share/archive/history | Topic and Feishu integration suites; durable inbox failure injection | Live Topic survived restarts; `/status` and `/report` reload | Pass |
| Standalone Agent multi-Session | Parser/Gateway/Store/Dispatcher tests cover create/list/use/show/rename/archive, lazy `main`, per-user/provider cursors, start/resume, isolation, serialization, cross-Session concurrency, restart and legacy migration | Updated control plane loaded the live database, migrated all three legacy provider direct Sessions, reached four-App ready=200, and retained all three external IDs | Pass |
| Visible group Discussion with natural steer | Domain, Gateway, coordinator, card, store, recovery and Outbox suites cover one-active-per-chat, three unique speakers per round, same-card patching, steer consumption, pause/resume/summarize/stop, failed providers, turn-index 3/9 crash boundaries and fenced JSON | Canonical Discussion `01KXSM5XNX4STNQTPR245H86TY` completed at round 3/turn index 7/version 23. Claude, Codex, and Copilot produced seven visible completed turns. Pause reached a durable state; steer persisted while paused; resume consumed it; Claude corrected a WAL visibility claim and Copilot explicitly accepted the correction; immediate summary completed on the original control card | Pass |
| Owner/editor/viewer enforcement | `canReadTopic`/`canEditTopic`; viewer command matrix | Viewer rules reflected in deployed command path | Pass |
| Three CLIs and Topic sessions | Adapter contracts; cross-Run/restart Topic-session tests | Fresh real-CLI start+resume suite passed 3/3: Claude 14,283 ms, Codex 27,676 ms, Copilot 31,747 ms; recorded research and direct external IDs remain persisted | Pass |
| Context reaches every agent | Context Pack unit test; real Gateway→ChannelDispatcher note/watermark test | Historical Topic/Run remains queryable | Pass |
| Independent fan-out, child sessions, concurrency ≤6 | Orchestrator tests: isolation, six unique child sessions, semaphore cap | Three live reports; no degraded provider | Pass |
| All-pairs review, repair, and ≤3 rounds | Six first-pass reviews; resolution report merge; signoff-only critique; round cap tests | 18 directed reviews over three rounds | Pass |
| Evidence-backed important Claims | Evidence normalization/Context Pack tests | 4 Claims, 5 Evidence, important coverage 2/2; RFC/IETF/IANA sources | Pass |
| Disagreement is not hidden | Run-machine, approved=false, resolution/signoff tests | Research Run completed `unresolved=true`; card stated unresolved disputes. The canonical Discussion surfaced and visibly resolved a WAL visibility disagreement | Pass |
| Restart loses no durable state | Store/inbox/checkpoint/session/approval/Outbox/lease restart tests | Service restart returned ready=200; sessions/report/approval remained | Pass |
| Worker calls use lease protocol | Terminal/same-worker exclusion; durable completed-result cache; heartbeat abort/requeue; every Orchestrator call lease assertion; expired same-task resume | `/ready` reports one local Worker | Pass (local transport) |
| Privileged work waits for approval | Approval/Gateway tests, orphaned-executing recovery test | Target absent before click; double click preserved one write/mtime | Pass |
| `/stop` cancels real work | Abort propagation, stale-save guard, process-tree/grandchild test, lease requeue test | Not used on the evidence Run | Pass (automated) |
| Secrets do not reach Git/logs/children | Synthetic secret isolation; redaction; least-privilege adapter contracts; tracked-value scan | `.env.local` ignored/untracked; scan checked 5 configured keys across 82 tracked files without exposing a value | Pass |
| Health, safe shutdown, delivery replay | Readiness, all-hook cleanup, startup unwind, pending-call cancel/drain, Outbox stable UUID, active-flush plus newly-queued-output drain, periodic lease recovery tests | Persistent service PID `63444`: HTTP 200, store=true, four Apps, one Worker | Pass |
| Deterministic and live verification | 207 deterministic tests passed; 3 live tests remain opt-in | Fresh opt-in CLI suite passed 3/3; canonical group Discussion completed with 3/3 providers producing real visible content; typecheck and build passed | Pass |

## Verification snapshot

Fresh deterministic run on 2026-07-18:

```text
Test Files  22 passed | 1 skipped (23)
Tests       207 passed | 3 skipped (210)
```

The three skipped cases are the explicit `MITISMINE_LIVE_CLI=1` suite. A fresh
opt-in run after interactive ChatGPT login passed all three real provider calls:

```text
Node 24.12.0; pnpm 11.9.0
Claude Code 2.1.212; Codex CLI 0.143.0; GitHub Copilot CLI 1.0.72-1
```

```text
tests/live/cli-smoke.test.ts  3 passed (3)
Claude start+resume           14283 ms
Codex start+resume            27676 ms
Copilot start+resume          31747 ms
Tests                         73708 ms
Vitest duration               74.61 s
```

Fresh `pnpm typecheck` and `pnpm build` runs passed. The tracked-secret scan
passed for 5 configured keys across 82 tracked files, and `git diff --check` was
clean before the documentation commit.

The recorded four-App audit returned:

```text
ready=200 store=true apps=[hub,claude,codex,copilot] workers=1 pid=63444
research_state=completed round=3 reviews=18 crossReviews=18
claims=4 evidence=5 importantCoverage=2/2
discussion=01KXSM5XNX4STNQTPR245H86TY state=completed round=3
turn_index=7 version=23 completed_visible_turns=7 providers=3/3
control_message=om_x100b6a9b682cb8acdedd8608d972fba
```

The earlier Discussion `01KXSCB2AX0GSY6YNT98S8GN61` remains useful only as a
historical failure-isolation run. Its Codex provider error is not the current
provider result and does not qualify the canonical 3/3 acceptance outcome.

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
- The canonical group smoke covers one tenant, one group, seven completed turns,
  and pause/resume/immediate-summary. Stop, natural nine-turn exhaustion, and
  restart during that exact Discussion remain automated or separately evidenced.

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
