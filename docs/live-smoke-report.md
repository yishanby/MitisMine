# MitisMine live four-App smoke report

Date: 2026-07-17; multi-Session and visible-group rechecks 2026-07-18 (Asia/Shanghai)
Environment: Windows, Node 24.12.0, Feishu persistent connection, local SQLite WAL Worker

CLI versions at final recheck:

- Claude Code `2.1.212`
- Codex CLI `0.143.0`
- GitHub Copilot CLI `1.0.72-0`
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
- Visible group Discussion:
  - Group: `MitisMine Visible Discussion Live Smoke 2026-07-18`
  - Chat: `oc_87039460e2874be6fbf1f007baa0d848`
  - Discussion: `01KXSCB2AX0GSY6YNT98S8GN61`
  - Control message: `om_x100b6a996bdb50a8def36113e8c89be`

No App Secret, token, Cookie, or authorization value is included in this report.

## Results

| Check | Evidence | Result |
|---|---|---|
| Four long connections | Four SDK `client ready` events; `/ready` returned store=true, apps=4, workers=1 | Pass |
| Identity preflight | Four persisted App observations resolved to one stable principal before startup side effects | Pass |
| Topic over Feishu | `/topic new Live smoke`; Topic ID persisted and reply card visible | Pass |
| Three-provider research | Claude, Codex, Copilot reports present; no degraded provider | Pass |
| Cross-review | 18 directed cross-reviews over three rounds; signoff reviews are counted separately by the current audit; 31 started and completed provider calls | Pass |
| Evidence report | 4 claims, 5 evidence items; important coverage 2/2 | Pass |
| Primary sources | RFC Editor HTML/TXT, IETF Datatracker, and IANA URLs with SHA-256 evidence hashes | Pass |
| Explicit disagreement | Run completed at round 3 with `unresolved=true`; report card says unresolved disputes remain | Pass |
| Direct App routing | Feishu events recorded app roles `claude`, `codex`, and `copilot`; corresponding replies returned | Pass |
| Restart recovery | Service restarted; `/ready` returned 200; `/status` and `/report` cards reloaded | Pass |
| Session recovery | Post-restart `RESUMED_CLAUDE_OK`, `RESUMED_CODEX_OK`, and `RESUMED_COPILOT_OK` used unchanged session IDs | Pass |
| Multi-Session migration preflight | Revision `a74ca6d` started against the live database; legacy Claude/Codex/Copilot direct rows migrated to named `main` Sessions without changing their external IDs; `/ready` remained 200 | Pass |
| Visible group start and identity | `@MitisMine 总控` created one Discussion and one Hub control card; Claude, Codex and Copilot each posted under their own App identity | Pass |
| Automatic round and steer | Claude completed turn 1; a human steer clarified the single-process/multi-process boundary; Codex surfaced `provider_error` without blocking; Copilot completed turn 3 and incorporated the requested boundary | Pass with graceful Codex degradation |
| Same-card controls | Pause and resume kept the same control message ID and resumed the same speaker slot; the final immediate-summary action changed the durable state from `paused` to `summarizing` to `completed` | Pass |
| Final visible summary | Hub posted consensus, disagreements, evidence gaps and next actions; the original card rendered `自动讨论 · 已完成` | Pass |
| Restart recovery | New code loaded the original live database; `/ready` returned 4 Apps and 1 Worker; the paused Discussion remained addressable and completed after the card callback | Pass |
| Approval before write | Smoke target absent before approval; approval row was pending | Pass |
| Approval idempotency | First click created one 18-byte file; second click left the same mtime and stored result | Pass |
| Secret isolation | `.env.local` ignored; tracked-secret scan clean; child environment tests pass | Pass |
| Worker lease execution | Deterministic task IDs, heartbeat, terminal state, and expired same-task resume verified automatically | Pass |

## Redacted excerpts

```text
status=200 ready=True apps=4 workers=1
```

```text
discussion=01KXSCB2AX0GSY6YNT98S8GN61
state=completed turn_index=3 control_message_unchanged=true
visible_identities=[hub,claude,codex,copilot]
steer_absorbed_by=copilot
```

```text
state=completed round=3 reviews=18 crossReviews=18 reports=[claude,codex,copilot]
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
Feishu messages, run a new research workflow, or click an approval card. Perform
the interaction sequence in the operator guide first when creating fresh evidence.

Terminal A:

```powershell
pnpm build
pnpm start
```

Terminal B:

```powershell
pnpm smoke:live
```

For fresh evidence, the exact Feishu inputs are `/topic new Live smoke`, a
`/research` question containing `RFC 2606`, ordinary follow-ups in all three
provider Apps before and after restart, and
`/action write smoke/approved.txt approved-by-feishu` followed by two clicks on
the same approval button. Section 10 of the operator guide is the copyable
sequence.

Real provider start+resume is separate and quota-consuming:

```powershell
$env:MITISMINE_LIVE_CLI="1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

At the final recheck Claude and Copilot passed. Codex accepted its strict
permission profile but the service account's stored API-key login returned 401;
reauthenticate with `codex login` before treating a fresh 3/3 run as current.

The 2026-07-18 multi-Session recheck did not send new Feishu chat messages or
consume provider quota. It verified the upgraded schema/migration, four live
connections, readiness, and existing three-provider direct Session continuity;
command interaction is covered by deterministic Gateway integration tests.

The visible-group recheck did send messages in the dedicated smoke group. It
verified natural steer, visible per-App identities, one-card controls, provider
failure isolation, restart continuity, and final Hub synthesis. Codex reached
the provider but returned the previously documented authentication error; renew
the service account with `codex login` before requiring fresh 3/3 content.
