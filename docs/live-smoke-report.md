# MitisMine live four-App smoke report

Date: 2026-07-17 (Asia/Shanghai)  
Environment: Windows, Node 24, Feishu long connection, local SQLite WAL worker

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

No App Secret, token, Cookie, or authorization value is included in this report.

## Results

| Check | Evidence | Result |
|---|---|---|
| Four long connections | Four SDK `client ready` events; `/ready` returned store=true, apps=4, workers=1 | Pass |
| Topic over Feishu | `/topic new Live smoke`; Topic ID persisted and reply card visible | Pass |
| Three-provider research | Claude, Codex, Copilot reports present; no degraded provider | Pass |
| Cross-review | 18 directed reviews over three rounds; 31 started and completed provider calls | Pass |
| Evidence report | 4 claims, 5 evidence items; important coverage 2/2 | Pass |
| Primary sources | RFC Editor HTML/TXT, IETF Datatracker, and IANA URLs with SHA-256 evidence hashes | Pass |
| Explicit disagreement | Run completed at round 3 with `unresolved=true`; report card says unresolved disputes remain | Pass |
| Direct App routing | Feishu events recorded app roles `claude`, `codex`, and `copilot`; corresponding replies returned | Pass |
| Restart recovery | Service restarted; `/ready` returned 200; `/status` and `/report` cards reloaded | Pass |
| Session recovery | Post-restart `RESUMED_CLAUDE_OK`, `RESUMED_CODEX_OK`, and `RESUMED_COPILOT_OK` used unchanged session IDs | Pass |
| Approval before write | Smoke target absent before approval; approval row was pending | Pass |
| Approval idempotency | First click created one 18-byte file; second click left the same mtime and stored result | Pass |
| Secret isolation | `.env.local` ignored; tracked-secret scan clean; child environment tests pass | Pass |

## Redacted excerpts

```text
status=200 ready=True apps=4 workers=1
```

```text
state=completed round=3 reviews=18 reports=[claude,codex,copilot]
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

## Reproduction

```powershell
pnpm build
pnpm start
pnpm exec tsx scripts/live-smoke.ts
```
