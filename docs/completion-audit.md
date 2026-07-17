# MitisMine completion audit

Audit date: 2026-07-18 (Asia/Shanghai)
Branch: `feat/multi-agent-feishu-research`
Audited code revision: `a74ca6d` (`feat: add standalone agent multi-session support`)
Approval-template hardening revision: `325d305`

The documentation commit follows the audited code revision; the final handoff
SHA is reported by the agent after commit.

## Acceptance evidence

| Acceptance criterion | Automated evidence | Live evidence | Status |
|---|---|---|---|
| Four Apps identify one user and share a cursor | Config identity-observation tests; startup verifier ordering; Gateway cross-App tests | Four persisted App observations resolve to one union principal; new preflight startup reached ready=200 | Pass |
| Topic create/switch/restore/share/archive/history | Topic and Feishu integration suites; durable inbox failure injection | Live Topic survived restarts; `/status` and `/report` reload | Pass |
| Standalone Agent multi-Session | Parser/Gateway/Store/Dispatcher tests cover create/list/use/show/rename/archive, lazy `main`, per-user/provider cursors, start/resume, isolation, serialization, cross-Session concurrency, restart and legacy migration | Updated control plane loaded the live database, migrated all three legacy provider direct Sessions, reached four-App ready=200, and the read-only live audit retained all three external IDs | Pass; fresh command-card interaction remains optional |
| Owner/editor/viewer enforcement | `canReadTopic`/`canEditTopic`; viewer command matrix | Viewer rules reflected in deployed command path | Pass |
| Three CLIs and Topic sessions | Adapter contracts; cross-Run/restart Topic-session tests | Recorded Claude/Codex/Copilot research and direct session IDs persisted | Pass; current Codex login needs renewal for a fresh quota smoke |
| Context reaches every agent | Context Pack unit test; real Gateway→ChannelDispatcher note/watermark test | Historical Topic/Run remains queryable | Pass |
| Independent fan-out, child sessions, concurrency ≤6 | Orchestrator tests: isolation, six unique child sessions, semaphore cap | Three live reports; no degraded provider | Pass |
| All-pairs review, repair, and ≤3 rounds | Six first-pass reviews; resolution report merge; signoff-only critique; round cap tests | 18 directed reviews over three rounds | Pass |
| Evidence-backed important Claims | Evidence normalization/Context Pack tests | 4 Claims, 5 Evidence, important coverage 2/2; RFC/IETF/IANA sources | Pass |
| Disagreement is not hidden | Run-machine, approved=false, resolution/signoff tests | Run completed `unresolved=true`; card stated unresolved disputes | Pass |
| Restart loses no durable state | Store/inbox/checkpoint/session/approval/Outbox/lease restart tests | Service restart returned ready=200; sessions/report/approval remained | Pass |
| Worker calls use lease protocol | Terminal/same-worker exclusion; durable completed-result cache; heartbeat abort/requeue; every Orchestrator call lease assertion; expired same-task resume | `/ready` reports one local Worker | Pass (local transport) |
| Privileged work waits for approval | Approval/Gateway tests, orphaned-executing recovery test | Target absent before click; double click preserved one write/mtime | Pass |
| `/stop` cancels real work | Abort propagation, stale-save guard, process-tree/grandchild test, lease requeue test | Not used on the evidence Run | Pass (automated) |
| Secrets do not reach Git/logs/children | Synthetic secret isolation; redaction; least-privilege adapter contracts; tracked-value scan | `.env.local` ignored/untracked; no Secret in live report | Pass |
| Health, safe shutdown, delivery replay | Readiness, all-hook cleanup, startup unwind, pending-call cancel/drain, Outbox stable UUID, active-flush drain, periodic lease recovery tests | New preflight startup: HTTP 200, 4 Apps, 1 Worker | Pass |
| Deterministic and live verification | 158 deterministic tests pass; 3 live tests opt-in | `pnpm smoke:live` returned `ok:true` after the multi-Session migration | Pass, with Codex reauthentication noted below |

## Verification snapshot

Fresh deterministic run on 2026-07-18:

```text
Test Files  15 passed | 1 skipped (16)
Tests       158 passed | 3 skipped (161)
```

The three skipped cases are the explicit `MITISMINE_LIVE_CLI=1` suite. During
hardening, Claude and Copilot passed real minimum-permission smoke calls. Codex
accepted the strict permission-profile arguments and reached the API, but the
current service account's stored API-key login returned 401. Raw token injection
was intentionally not restored; run `codex login` and repeat the live command.

The recorded four-App audit after identity preflight returned:

```text
ready=200 apps=4 workers=1
ok=true state=completed round=3 reviews=18 crossReviews=18
claims=4 evidence=5 importantCoverage=2/2 approval=completed
```

## Requirement-to-component map

- Topic authorization/history/context: `packages/domain`, `packages/storage/src/store.ts`, `packages/feishu`
- Direct Session UX/isolation/concurrency: `packages/storage/src/store.ts`, `packages/feishu/src/commands.ts`, `packages/feishu/src/gateway.ts`, `apps/control-plane/src/main.ts`
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

The final decoded dotenv scan checked both the Git index and working tree (5
local secret keys across 67 tracked files) and printed no Secret values.
