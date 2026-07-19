# MitisMine completion audit

Audit date: 2026-07-19 (Asia/Shanghai)

Branch: `feat/visible-group-discussion`

Audited application revision: `b2e08865d1c97b4296b6465661423a9078304f71`

This audit covers application code through
`b2e08865d1c97b4296b6465661423a9078304f71`.
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
`b2e08865` application revision; they are not timings of the Feishu interaction.

## Acceptance evidence

| Acceptance criterion | Automated evidence | Live evidence | Status |
|---|---|---|---|
| Four Apps identify one user and share a cursor | Config identity-observation tests; startup verifier ordering; Gateway cross-App tests | Four persisted App observations resolve to one union principal; `/ready` returned HTTP 200 with store=true, four Apps, and one Worker | Pass |
| Topic create/switch/restore/share/archive/history | Topic and Feishu integration suites; durable inbox failure injection | Live Topic survived restarts; `/status` and `/report` reload | Pass |
| Standalone Agent multi-Session | Parser/Gateway/Store/Dispatcher tests cover create/list/use/show/rename/archive, lazy `main`, per-user/provider cursors, start/resume, stale external-Session replacement, streamed progress, one-card patch throttling/heartbeat, isolation, serialization, cross-Session concurrency, restart and legacy migration | A real stale Claude resume was replaced in the same turn. A separate real Claude/Kusto call emitted safe Skill, Kusto, and analysis milestones; an injected corrupt final triggered exactly one same-Session rewrite and returned with zero replacement characters | Pass |
| Visible group Discussion with natural steer | Domain, Gateway, coordinator, card, store, recovery, Unicode guards, and Outbox suites cover one-active-per-chat, three unique speakers per round, same-card patching, steer consumption, pause/resume/summarize/stop, failed providers, turn-index 3/9 crash boundaries, fenced JSON, exact v2/scoped-legacy/minimal-v0 event replay, receipt-first and event-first crash recovery, bound-event replay, terminal tombstones, provider reconciliation, pending-steer summary regeneration, bounded paid retries, and indexed `(topic_id, seq)` recovery lookup | Unicode-clean canonical Discussion `01KXSRVC8DFBMTJRSY1KJKCM5C` completed at round 2/turn index 5/version 19. Claude, Codex, and Copilot produced five visible completed turns. Pause cancelled an in-flight Copilot attempt while retaining its slot; a genuine `MitisMine 总控` entity-mention steer persisted while paused and was consumed by Copilot after resume; Codex corrected an overstrong NFS claim and Copilot accepted the correction. All control updates targeted one control message; Hub sent the summary separately | Pass |
| Owner/editor/viewer enforcement | `canReadTopic`/`canEditTopic`; viewer command matrix | Viewer rules reflected in deployed command path | Pass |
| Three CLIs and Topic sessions | Adapter contracts; cross-Run/restart Topic-session tests | Current-revision real-CLI start+resume suite passed 3/3: Claude 29,651 ms, Codex 87,640 ms, Copilot 41,228 ms | Pass |
| Native capabilities and Session-wide modification | Adapter contracts prove Codex inherits user config, Claude uses `bypassPermissions` plus default tools, Copilot uses `--allow-all`, and every start/resume selects native environment inheritance | Each provider created a marker in an isolated workspace on its first turn, modified it after resume, and retained the same external Session; Claude, Codex, and Copilot each executed a harmless Kusto query whose fresh UTC time and random GUID were validated without recording either value | Pass |
| Context reaches every agent | Context Pack unit test; real Gateway→ChannelDispatcher note/watermark test | Historical Topic/Run remains queryable | Pass |
| Independent fan-out, child sessions, concurrency ≤6 | Orchestrator tests: isolation, six unique child sessions, semaphore cap | Three live reports; no degraded provider | Pass |
| All-pairs review, repair, and ≤3 rounds | Six first-pass reviews; resolution report merge; signoff-only critique; round cap tests | 18 directed reviews over three rounds | Pass |
| Evidence-backed important Claims | Evidence normalization/Context Pack tests | 4 Claims, 5 Evidence, important coverage 2/2; RFC/IETF/IANA sources | Pass |
| Disagreement is not hidden | Run-machine, approved=false, resolution/signoff tests | Research Run completed `unresolved=true`; card stated unresolved disputes. The canonical Discussion surfaced an overstrong WAL/NFS claim, followed by a visible Codex correction and Copilot acknowledgement. This demonstrates cross-provider consensus, not independent empirical or external technical verification | Pass |
| Restart loses no durable state | Store/inbox/checkpoint/session/approval/Outbox/lease restart tests | Service restart returned ready=200; sessions/report/approval remained | Pass |
| Worker calls use lease protocol | Terminal/same-worker exclusion; durable completed-result cache; heartbeat abort/requeue; every Orchestrator call lease assertion; expired same-task resume | `/ready` reports one local Worker | Pass (local transport) |
| Privileged work waits for approval | Approval/Gateway tests, orphaned-executing recovery test | Target absent before click; double click preserved one write/mtime | Pass |
| `/stop` cancels real work | Abort propagation, stale-save guard, process-tree/grandchild test, lease requeue test | Not used on the evidence Run | Pass (automated) |
| Secrets do not reach Git/logs/children | Native-environment tests preserve proxy/provider/tool values while removing every case variant of `FEISHU_*`, `LARK_*`, and `MITISMINE_*`; runner redaction and tracked-value scan remain active | Local Skill/MCP content stayed outside Git; the recorded scan checked 5 synthetic secret values without exposing a value | Pass |
| Health, safe shutdown, delivery replay | Readiness, all-hook cleanup, startup unwind, pending-call cancel/drain, Outbox stable UUID, active-flush plus newly-queued-output drain, periodic lease recovery tests | Canonical acceptance service PID `58564`: HTTP 200, ready=true, store=true, four Apps, one Worker | Pass |
| Deterministic and live verification | 353 tests passed; 3 live tests remain opt-in and skipped in the deterministic run | Fresh opt-in CLI suite passed 3/3; all three providers passed start/resume, Session write, and Kusto capability checks; real Claude progress and Unicode-rewrite paths passed; the final recorded lint, typecheck, build, secret scan, source-Unicode scan, and diff checks passed | Pass |

## Verification snapshot

Fresh deterministic run on 2026-07-19:

```text
Test Files  24 passed | 1 skipped (25)
Tests       353 passed | 3 skipped (356)
Duration    10.47 s
```

The three skipped cases are the explicit `MITISMINE_LIVE_CLI=1` suite. A fresh
opt-in run after interactive ChatGPT login passed all three real provider calls:

```text
Node 24.12.0; pnpm 11.9.0
Claude Code 2.1.212; Codex CLI 0.143.0; GitHub Copilot CLI 1.0.72-1
```

```text
tests/live/cli-smoke.test.ts  3 passed (3)
Claude start+resume           29651 ms
Codex start+resume            87640 ms
Copilot start+resume          41228 ms
Tests                         158521 ms
Vitest duration               159.51 s
```

Native capability acceptance on `b2e08865d1c97b4296b6465661423a9078304f71`
also established:

```text
workspace_write_start_resume={claude:pass,codex:pass,copilot:pass}
same_external_session={claude:true,codex:true,copilot:true}
kusto_result_validation={claude:pass,codex:pass,copilot:pass}
control_plane_env_prefixes_in_children=0
```

The Kusto Skill remains local-only. Claude uses its existing user Skill and MCP.
Copilot registers that Skill directory and MCP at user scope. Codex uses a
properly cased user `SKILL.md`, a user MCP registration, a local preload that
keeps the MCP stdout protocol clean, and `default_tools_approval_mode =
"approve"` so non-interactive read queries are not cancelled. No Skill body,
MCP environment value, query result, or provider Session ID is recorded in Git.

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
- Codex and Copilot Kusto access depends on the documented user-profile Skill,
  MCP, and clean-stdio preload installation on this machine; those local files
  are intentionally not embedded in the public repository.
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
