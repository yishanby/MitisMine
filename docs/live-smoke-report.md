# MitisMine live four-App smoke report

Initial smoke: 2026-07-17; final multi-Session, CLI, and visible-group rechecks:
2026-07-18 (Asia/Shanghai)

Environment: Windows, Node `24.12.0`, Feishu persistent connection, local SQLite WAL Worker

Audited code revision: `dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a`

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
  - Discussion: `01KXSRVC8DFBMTJRSY1KJKCM5C`
  - Control message: `om_x100b6a84163cb4a0c3dadf616c2fcda`
- Historical pre-fix Discussion (not canonical or Unicode-clean):
  - Discussion: `01KXSM5XNX4STNQTPR245H86TY`
  - A Claude turn and the Hub summary contain U+FFFD
- Historical degraded Discussion (failure-isolation evidence only):
  - Discussion: `01KXSCB2AX0GSY6YNT98S8GN61`
  - Control message: `om_x100b6a996bdb50a8def36113e8c89be`

No App Secret, token, cookie, authorization value, or user credential is
included in this report.

## Results

| Check | Evidence | Result |
|---|---|---|
| Four long connections | Four SDK `client ready` events; after rebuild and restart, `/ready` returned HTTP 200, ready=true, store=true, apps=4, workers=1 from PID `58564` | Pass |
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
| Canonical visible group start and identity | In Feishu, the human used the @ toolbar and selected the real entity whose display name is exactly `MitisMine 总控`, verified it was an entity mention, and then typed the question. The UI showed one Hub control card and real content from all three provider identities; the read-only Discussion audit associated that flow with `01KXSRVC8DFBMTJRSY1KJKCM5C` | Pass |
| Automatic turns | The UI showed five completed provider messages. The read-only Discussion audit mapped their code-point/Han counts to Claude 0 (99/72), Codex 1 (58/37), Copilot 2 (93/71), Codex 3 (47/30), and Copilot 4 (66/46), and recorded Claude turn 5 as cancelled with no visible content | Pass, 3/3 current content |
| Durable pause, steer, and resume | A separate read-only SQLite audit—not the visible UI alone—showed that pause cancelled the in-flight Copilot turn 2 attempt, persisted round 1/turn index 2/version 8, retained the speaker slot, kept the genuine entity-mention steer pending, and associated its consumption with Copilot turn 2 after resume | Pass |
| Instruction delivery and length compliance | Provider messages addressed the requested WAL and snapshot points, but length adherence was partial. Against the initial ≤60-Han limit, Claude 0 (72 Han) and Copilot 2 (71) violated it; Codex 1 (37), Codex 3 (30), and Copilot 4 (46) complied. Copilot 2 also violated the repeated post-pause limit. `consumed` proves steer delivery and turn association, not full provider compliance | Partial provider compliance; orchestration evidence remains valid |
| Cross-provider acknowledgement after steer | Resumed Copilot turn 2 explicitly addressed the transaction-start snapshot point. Codex turn 3 corrected the overstrong claim that cross-host/NFS access would `必然损坏`; Copilot turn 4 accepted that correction | Pass; visible consensus, not independent empirical or external technical verification |
| Same-card controls | The read-only Outbox audit showed every sent or superseded control update through version 19 targeted `om_x100b6a84163cb4a0c3dadf616c2fcda`; pause, resume, and immediate-summary did not create a replacement control card | Pass |
| Immediate summary | The read-only Discussion audit recorded the in-flight Claude turn at index 5 as intentionally cancelled and state as summarizing at round 2/turn index 5/version 18, then completed at version 19 | Pass |
| Final visible summary | The UI showed the control card render completed and Hub send a separate Unicode-clean summary. The read-only Outbox audit established that the existing card was patched at the same message ID and that the separate summary length was 324 characters | Pass |
| Unicode integrity | The read-only database/Outbox audit found replacement_count=0 in the question, `summary_text`, all turn text/open questions/steer IDs, both steer texts, and every related payload/delivery effect/result. The separately inspected visible UI segment also had no U+FFFD, and every visible provider/summary Outbox row was sent | Pass |
| Historical Discussion classification | Discussion `01KXSM5XNX4STNQTPR245H86TY` contains U+FFFD in a Claude turn and Hub summary and is retained only as pre-fix evidence. Earlier Discussion `01KXSCB2AX0GSY6YNT98S8GN61` remains failure-isolation evidence | Historical only; neither is canonical |
| Approval before write | Smoke target absent before approval; approval row was pending | Pass |
| Approval idempotency | First click created one 18-byte file; second click left the same mtime and stored result | Pass |
| Secret isolation | `.env.local` ignored; the recorded tracked scan passed for 5 configured keys without exposing a value; child environment tests pass | Pass |
| Build verification | Fresh root `pnpm test:run`: 23 test files passed and 1 skipped; 221 tests passed and 3 opt-in live tests skipped; duration 5.73 s. The latest recorded typecheck and build runs passed | Pass |
| Worker lease execution | Deterministic task IDs, heartbeat, terminal state, and expired same-task resume verified automatically | Pass |

## Redacted excerpts

```text
status=200 ready=true store=true
apps=[hub,claude,codex,copilot] workers=1 pid=58564
```

```text
cli_smoke=passed tests=3/3
claude_ms=14283 codex_ms=27676 copilot_ms=31747
tests_ms=73708 vitest_duration_s=74.61
```

```text
discussion=01KXSRVC8DFBMTJRSY1KJKCM5C
state=completed round=2 turn_index=5 version=19
control_message=om_x100b6a84163cb4a0c3dadf616c2fcda
visible_turns=[claude:{cp:99,han:72},codex:{cp:58,han:37},copilot:{cp:93,han:71},codex:{cp:47,han:30},copilot:{cp:66,han:46}]
summary_length=324 replacement_count=0
```

```text
paused_at={round:1,turn_index:2,version:8}
steer_message=om_x100b6a8429f170b0c4afe4588666c37
steer=persisted_then_consumed_by_copilot_turn_2
initial_60_han={claude_0:false,codex_1:true,copilot_2:false,codex_3:true,copilot_4:true}
post_pause_60_han={copilot_2:false}
steer_compliance={snapshot:true,delivery_associated:true,full_compliance:false}
correction=codex_turn_3_acknowledged_by_copilot_turn_4
summary_transition=summarizing(v18)->completed(v19)
same_control_message_through_version_19=true
hub_summary_message=separate_from_control_card
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
9. The historical pre-fix Discussion contained U+FFFD in one Claude turn and
   the Hub summary. Unicode guards were added, the service was rebuilt
   from `dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a`, and a new canonical run
   verified zero replacements across durable Discussion fields, both steers,
   related Outbox JSON, the visible UI segment, and the separate Hub summary.

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

1. In Feishu, click the @ toolbar and select the real mention entity whose
   display name is exactly `MitisMine 总控`. Verify that Feishu inserted an
   entity mention; do not merely type `@Hub` or plain text. Then type and send:

   ```text
   请三位各用不超过60个汉字说明 SQLite WAL 的一个适用条件，并互相校验。
   ```

2. Confirm Hub creates one control card and that Claude and Codex post visible
   replies under their own App identities. When Copilot begins its next visible
   activity, click **暂停** and confirm the control card renders a paused state.
3. While paused, again select the genuine `MitisMine 总控` entity mention and
   send this natural steer:

   ```text
   请把后续发言控制在60个汉字内，并明确：读事务看到开始时的已提交快照。
   ```

4. Click **继续**. In the UI, confirm the next Copilot reply explicitly addresses
   the transaction-start snapshot point. Confirm the subsequent Codex reply
   corrects the overstrong statement that cross-host/NFS access would
   `必然损坏`, then the next Copilot reply accepts that correction. This visible
   exchange establishes cross-provider acknowledgement and consensus, not
   independent empirical or external technical verification.
5. When Claude begins the next visible activity, click **立即总结**. Confirm no
   additional Claude provider content appears, the control card renders a
   completed state, and Hub posts its Unicode-clean summary as a separate
   message rather than inside or on the control card.

Those UI steps establish visible App identities, the rendered pause/completed
card states, the visible provider exchange, the absence of an additional Claude
message, and the separate Hub summary. They do not expose exact turn indexes,
versions, steer database status, cancellation rows, or Outbox target message
IDs.

The recorded acceptance evidence therefore included a subsequent read-only
SQLite/Outbox audit. That audit—not UI observation—established all of the
following:

- pause cancelled the in-flight Copilot attempt and persisted round 1/turn
  index 2/version 8 while retaining the speaker slot;
- user steer `om_x100b6a8429f170b0c4afe4588666c37` stayed pending while
  paused and was consumed by Copilot turn 2 after resume; the separately
  consumed initial steer represents the start question;
- the completed/cancelled turn rows, exact provider order, indexes, and lengths;
- immediate summary persisted round 2/turn index 5/version 18 as summarizing,
  then version 19 as completed; and
- every sent or superseded control update targeted
  `om_x100b6a84163cb4a0c3dadf616c2fcda`, with all visible provider and summary
  Outbox rows sent.

The persisted Copilot turn 2 text was:

```text
同意二位。WAL 核心优势：读事务见启动快照，无脏读且并发高效。关键限制是单写者、内存映射依赖。NFS 跨主机访问违反映射前提—确实会导致损坏。建议补充：WAL 文件与数据库需同盘位置。
```

It followed the snapshot instruction but measured 93 UTF-16 code units, 93
code points, and 71 Han characters. It therefore violated both the initial and
repeated 60-Han-character limits. Across all five completed replies, Claude turn
0 also violated the initial limit at 72 Han characters; Codex turn 1 (37), Codex
turn 3 (30), and Copilot turn 4 (46) complied. Copilot turn 4 had 66 total code
points but still met the rule because the request limited Han characters.
Provider messages addressed the requested WAL and snapshot points, but length
adherence was partial. The steer row's `consumed` status proves delivery and
association with Copilot turn 2, not full compliance with every instruction.

Real provider start+resume is separate and quota-consuming:

```powershell
$env:MITISMINE_LIVE_CLI="1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

The CLI run passed Claude, Codex, and Copilot 3/3. The complete canonical
Discussion sequence and scoped evidence gaps are recorded in
`docs/group-discussion-smoke-report.md`.

For fresh Topic/research/direct-Session/approval evidence, follow section 10 of
the operator guide. The 2026-07-18 multi-Session recheck itself was read-only:
it verified schema migration, four live connections, readiness, and the existing
three-provider direct Session continuity; command interaction remains covered by
deterministic Gateway integration tests.
