# MitisMine live four-App smoke report

Initial smoke: 2026-07-17; final multi-Session, CLI, and visible-group rechecks:
2026-07-18 (Asia/Shanghai)

Environment: Windows, Node `24.12.0`, Feishu persistent connection, local SQLite WAL Worker

Audited code revision: `0b89aa6`

CLI versions at the final recheck:

- Claude Code `2.1.212`
- Codex CLI `0.143.0`
- GitHub Copilot CLI `1.0.72-1`
- pnpm `11.9.0`

## Identities

- Topic: `01KXR5RVXKMD5P7DR3EZXPTT8G` (`Live smoke`)
- Completed RFC Run: `01KXR6CC448GZDJ254FQV3AS4B`
- Research sessions:
  - Claude: `8cf936f7-b2ed-4302-a1c5-fdac9d4dcab1`
  - Codex: `019f7066-3c2e-7042-92eb-a8710143c159`
  - Copilot: `1158154e-dad1-4473-af61-488ba4017eae`
- Persistent direct sessions:
  - Claude: `2de4493a-6009-4ad5-95bd-858b604a143b`
  - Codex: `019f706c-1a53-7f30-aa54-0a91f726396a`
  - Copilot: `50adf797-4c83-416a-a969-6ec4ac3b6087`
- Canonical visible group Discussion:
  - Group: `MitisMine Visible Discussion Live Smoke 2026-07-18`
  - Chat: `oc_87039460e2874be6fbf1f007baa0d848`
  - Discussion: `01KXSM5XNX4STNQTPR245H86TY`
  - Control message: `om_x100b6a9b682cb8acdedd8608d972fba`
- Historical degraded Discussion (failure-isolation evidence only):
  - Discussion: `01KXSCB2AX0GSY6YNT98S8GN61`
  - Control message: `om_x100b6a996bdb50a8def36113e8c89be`

No App Secret, token, cookie, authorization value, or user credential is
included in this report.

## Results

| Check | Evidence | Result |
|---|---|---|
| Four long connections | Four SDK `client ready` events; `/ready` returned store=true, apps=4, workers=1 from PID `63444` | Pass |
| Identity preflight | Four persisted App observations resolved to one stable principal before startup side effects | Pass |
| Topic over Feishu | `/topic new Live smoke`; Topic ID persisted and reply card visible | Pass |
| Three-provider research | Claude, Codex, and Copilot reports present; state=completed, round=3 | Pass |
| Cross-review | 18 directed cross-reviews over three rounds; signoff reviews are counted separately by the current audit; 31 started and completed provider calls | Pass |
| Evidence report | 4 claims, 5 evidence items; important coverage 2/2 | Pass |
| Primary sources | RFC Editor HTML/TXT, IETF Datatracker, and IANA URLs with SHA-256 evidence hashes | Pass |
| Explicit disagreement | Research Run completed with `unresolved=true`; report card says unresolved disputes remain | Pass |
| Direct App routing | Feishu events recorded app roles `claude`, `codex`, and `copilot`; corresponding replies returned | Pass |
| Restart recovery | Service restarted; `/ready` returned 200; `/status` and `/report` cards reloaded | Pass |
| Session recovery | Post-restart `RESUMED_CLAUDE_OK`, `RESUMED_CODEX_OK`, and `RESUMED_COPILOT_OK` used unchanged session IDs | Pass |
| Multi-Session migration preflight | Revision `a74ca6d` started against the live database; legacy Claude/Codex/Copilot direct rows migrated to named `main` Sessions without changing their external IDs; `/ready` remained 200 | Pass |
| Fresh real CLI start+resume | `tests/live/cli-smoke.test.ts` passed 3/3 after ChatGPT login: Claude 14,283 ms; Codex 27,676 ms; Copilot 31,747 ms; 73,708 ms total tests, 74.61 s Vitest duration | Pass |
| Canonical visible group start and identity | `@MitisMine 总控` created Discussion `01KXSM5XNX4STNQTPR245H86TY` and one Hub control card; Claude, Codex, and Copilot each posted real content under their own App identity | Pass |
| Automatic turns | Seven completed visible turns: Claude at indexes 0 and 5; Codex at indexes 1 and 3; Copilot at indexes 2, 4, and 6 | Pass, 3/3 current content |
| Durable pause, steer, and resume | Pause persisted at round 2/turn index 5/version 14. A natural steer persisted while paused; resume consumed it in Claude's turn 5 and continued automatically | Pass |
| Cross-validation after steer | Claude corrected the claim that WAL readers only see the last checkpoint, explaining transaction-start snapshot visibility; Copilot's turn 6 explicitly accepted that correction | Pass |
| Same-card controls | Every sent or superseded control update through version 23 targeted `om_x100b6a9b682cb8acdedd8608d972fba`; pause, resume, and immediate-summary did not create a replacement control card | Pass |
| Immediate summary | An in-flight Claude turn at index 7 was intentionally cancelled; durable state moved active → summarizing at version 22 → completed at version 23 | Pass |
| Final visible summary | Hub posted a separate decision-ready summary covering consensus, the resolved correction, risks, mitigations, and quantified evidence gaps; the completed control card remained visibly rendered | Pass |
| Earlier Discussion failure isolation | Historical Discussion `01KXSCB2AX0GSY6YNT98S8GN61` exposed a then-current Codex provider error without blocking other providers or final synthesis | Historical pass; not a current authentication limitation |
| Approval before write | Smoke target absent before approval; approval row was pending | Pass |
| Approval idempotency | First click created one 18-byte file; second click left the same mtime and stored result | Pass |
| Secret isolation | `.env.local` ignored; tracked scan passed for 5 configured keys across 82 tracked files; child environment tests pass | Pass |
| Build verification | 22 deterministic test files passed and 1 skipped; 207 tests passed and 3 opt-in live tests skipped; fresh typecheck and build passed | Pass |
| Worker lease execution | Deterministic task IDs, heartbeat, terminal state, and expired same-task resume verified automatically | Pass |

## Redacted excerpts

```text
status=200 ready=true store=true
apps=[hub,claude,codex,copilot] workers=1 pid=63444
```

```text
cli_smoke=passed tests=3/3
claude_ms=14283 codex_ms=27676 copilot_ms=31747
tests_ms=73708 vitest_duration_s=74.61
```

```text
discussion=01KXSM5XNX4STNQTPR245H86TY
state=completed round=3 turn_index=7 version=23
control_message=om_x100b6a9b682cb8acdedd8608d972fba
visible_turns=[claude,codex,copilot,codex,copilot,claude,copilot]
```

```text
paused_at={round:2,turn_index:5,version:14}
steer=persisted_then_consumed_by_claude_turn_5
correction=accepted_by_copilot_turn_6
summary_transition=active->summarizing(v22)->completed(v23)
same_control_message_through_version_23=true
```

```text
research_state=completed round=3 reviews=18 crossReviews=18
reports=[claude,codex,copilot]
claims=4 evidence=5 importantCovered=2/2 unresolved=true
```

```text
approval status=completed
mtime_before=639198940261892293
mtime_after =639198940261892293
file_exists=true content_matches=true
```

## Issues found and resolved during smoke

1. The local Worker aged out after 30 seconds because it was treated as a remote heartbeat worker. It is now registered as an in-process persistent Worker with a regression test.
2. Claude and Copilot originally emitted `subtaskProposals` as `{id,text}` because the prompt did not state the required fields. The prompt now explicitly requires `{id,title,prompt}` and the second Run completed with all three providers.
3. A browser search misclick sent one `DIRECT_CLAUDE_OK` check to the hub, creating an extra completed Run. The immutable event log shows `appRole=hub`; subsequent provider checks verified the target conversation before sending. This did not alter the RFC Run evidence.
4. Immediate summary from a `kick()`-started loop originally treated the intentional abort as a coordinator failure and changed `summarizing` back to `paused`. Control and shutdown interruptions are now typed, expected interruptions are not logged as failures, and unexpected active/summary failures pause for retry; regression tests drive the real `kick()` path.
5. Copilot wrapped its valid Discussion contract in a `json` markdown fence, so the first live message displayed the raw block. Turn and final-summary parsers now share fenced-JSON unwrapping; future output renders only the intended text.
6. A crash between turn advancement and round-policy evaluation could skip the boundary. Recovery now re-evaluates every completed three-turn boundary before claiming the next turn, with fixtures at turn indexes 3 and 9.
7. A steer preferring an Agent that already spoke could duplicate that Agent and omit another. The preference is now deferred to the next round, and every round order remains three unique providers.
8. A very fast pause-then-resume could reuse the old cancelling loop and leave an `active` Discussion with no driver. Resume now waits for the cancelled loop to drain before kicking a fresh loop; the regression test resumes immediately without manual waiting.

## Reproduction

The commands below audit the already-recorded Topic/Run. They do not create
Feishu messages, run a new research workflow, or click an approval card.

Terminal A:

```powershell
pnpm build
pnpm start
```

Terminal B:

```powershell
pnpm smoke:live
```

To reproduce the canonical visible-group flow in a dedicated group containing
all four bots:

1. Send `@Hub 请三位各用一句话说明 SQLite WAL 的一个适用条件并互相校验；有分歧就指出。`.
2. Confirm Hub creates one control card and each of Claude, Codex, and Copilot visibly speaks real content.
3. After five completed turns, click **暂停** and confirm the card is paused. In the recorded run this was round 2/turn index 5/version 14.
4. While paused, send this steer through the reliable `@Hub` path: `steer：请重点校正“读只能看到上次 checkpoint”的说法；SQLite WAL 的读事务应看到开始时的数据库快照。`
5. Click **继续**. Confirm Claude consumes the steer and corrects the claim, then Copilot explicitly accepts the correction.
6. While the next Claude turn is in flight at index 7, click **立即总结**.
7. Confirm the original control message ID remains unchanged, its completed card is visible, and Hub posts a separate decision-ready summary.

Real provider start+resume is separate and quota-consuming:

```powershell
$env:MITISMINE_LIVE_CLI="1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

The final run passed Claude, Codex, and Copilot 3/3. The complete canonical
Discussion sequence and scoped evidence gaps are recorded in
`docs/group-discussion-smoke-report.md`.

For fresh Topic/research/direct-Session/approval evidence, follow section 10 of
the operator guide. The 2026-07-18 multi-Session recheck itself was read-only:
it verified schema migration, four live connections, readiness, and the existing
three-provider direct Session continuity; command interaction remains covered by
deterministic Gateway integration tests.
