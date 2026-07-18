# Visible group Discussion smoke report

Date: 2026-07-18 (Asia/Shanghai)

Audited code revision: `dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a`

Scope: one real Feishu group Discussion using the rebuilt persistent four-App
service. This is the canonical Unicode-clean visible-group acceptance run.

Discussion `01KXSM5XNX4STNQTPR245H86TY` is retained only as historical pre-fix
evidence: a Claude turn and the Hub summary contain U+FFFD, so that run is not
canonical, Unicode-clean, polished, or decision-ready. The still earlier
Discussion `01KXSCB2AX0GSY6YNT98S8GN61` remains historical failure-isolation
evidence only.

## Environment and non-secret identities

| Item | Recorded value |
|---|---|
| Service readiness | HTTP 200; ready=true; store=true; apps=`hub,claude,codex,copilot`; workers=1 |
| Rebuilt service PID | `58564` |
| Group | `MitisMine Visible Discussion Live Smoke 2026-07-18` |
| Chat | `oc_87039460e2874be6fbf1f007baa0d848` |
| Discussion | `01KXSRVC8DFBMTJRSY1KJKCM5C` |
| Control message | `om_x100b6a84163cb4a0c3dadf616c2fcda` |
| User steer message | `om_x100b6a8429f170b0c4afe4588666c37` |
| Question | `请三位各用不超过60个汉字说明 SQLite WAL 的一个适用条件，并互相校验。` |
| Final durable state | completed; round=2; turn_index=5; version=19 |
| Completed visible turns | 5 |
| Summary length | 324 characters |

No App Secret, access token, cookie, authorization header, CLI credential, or
user credential is included here.

## Reproduction and exact interaction sequence

1. In Feishu, the human clicked the @ toolbar, selected the real mention entity
   whose display name is exactly `MitisMine 总控`, verified it was an entity
   mention, and then typed the recorded question. Merely typing `@Hub` or plain
   text is not the reproduced start path.
2. Hub created Discussion `01KXSRVC8DFBMTJRSY1KJKCM5C` and control message
   `om_x100b6a84163cb4a0c3dadf616c2fcda`.
3. Claude turn 0 and Codex turn 1 completed visibly. Copilot turn 2 then began.
4. While Copilot turn 2 was in flight, the human clicked **暂停**. The attempt
   was cancelled; durable state reached `paused` at round 1, turn index 2,
   version 8. The Copilot speaker slot was retained.
5. While paused, the human selected a genuine `MitisMine 总控` entity mention
   and sent this natural steer:

   ```text
   请把后续发言控制在60个汉字内，并明确：读事务看到开始时的已提交快照。
   ```

   Message `om_x100b6a8429f170b0c4afe4588666c37` remained pending while
   paused. The start question is also represented internally as a consumed
   initial steer; it is distinct from this user steer.
6. The human clicked **继续**. Copilot retained turn index 2, consumed the user
   steer after resume, and explicitly addressed the transaction-start committed
   snapshot point.
7. Codex turn 3 corrected an overstrong claim that cross-host/NFS access would
   `必然损坏`, replacing it with the narrower conclusion that the arrangement is
   unreliable and not recommended. Copilot turn 4 accepted that correction.
8. Claude turn 5 began. The human clicked **立即总结**; that turn was
   intentionally cancelled and produced no visible content.
9. Durable state reached `summarizing` at round 2, turn index 5, version 18 and
   then `completed` at version 19. The existing Hub control card was patched to
   completed at the same control message ID. Hub sent the summary as a separate
   message; the summary was not posted inside or on the original control card.

## Visible identity and turn evidence

| Turn index | Visible App identity | Length | Result |
|---:|---|---:|---|
| 0 | Claude | 99 | Completed visible content |
| 1 | Codex | 58 | Completed visible content |
| 2 | Copilot | 93 | Completed after resume; consumed the pending user steer |
| 3 | Codex | 47 | Completed; corrected the overstrong NFS/cross-host claim |
| 4 | Copilot | 66 | Completed; accepted the Codex correction |
| 5 | Claude | — | In flight, then intentionally cancelled; no visible content |

Claude therefore supplied one completed visible provider message, Codex two,
and Copilot two. Hub supplied the control card and a separate summary message;
provider turns were not relabeled as Hub text.

## Durable control and delivery evidence

- Pause was durable at round 1/turn index 2/version 8.
- The in-flight Copilot attempt was cancelled without advancing the speaker
  slot. The pending user steer was consumed by Copilot turn 2 only after resume.
- Immediate summary was durable at round 2/turn index 5/version 18, followed by
  completed version 19. The in-flight Claude turn remained cancelled.
- Create established control message
  `om_x100b6a84163cb4a0c3dadf616c2fcda`.
- Every control update, whether sent or superseded, targeted exactly that same
  message ID. No replacement control card was created.
- The existing control card was patched to completed. The Hub summary was sent
  separately and does not violate the one-control-card invariant.
- Every visible provider or summary Outbox row was sent.

## Unicode integrity

The canonical Discussion was audited across both durable records and the
visible UI segment. Replacement count was zero, with no U+FFFD, in all of:

- the Discussion question and `summary_text`;
- every `discussion_turns` text, open-questions value, and steer ID;
- both `discussion_steers` texts, including the consumed initial steer and the
  later user steer;
- every related Outbox `payload_json`, `delivery_effect_json`, and
  `result_json` value; and
- the visible UI segment for this Discussion.

The separate 324-character Hub summary was Unicode-clean. Its content captured
consensus on local single-host/local-disk, read-heavy, short-write conditions;
single-writer and high-write limits; WAL growth from long transactions; and the
corrected conclusion that NFS/cross-host access is unreliable and not
recommended rather than `必然损坏`.

## Consensus boundary

The steer caused resumed Copilot turn 2 to state the transaction-start committed
snapshot point. Codex turn 3 then narrowed the overstrong NFS/cross-host claim,
and Copilot turn 4 accepted the correction. This is visible cross-provider
acknowledgement and consensus. It is not independent empirical testing,
benchmarking, or verification against an external technical source.

## Verification context

The final verification window recorded:

- fresh root `pnpm test:run`: 23 test files passed, 1 skipped; 221 tests passed,
  3 opt-in live tests skipped; duration 5.73 s;
- opt-in real CLI suite: 3/3 passed (Claude 14,283 ms; Codex 27,676 ms;
  Copilot 31,747 ms; 73,708 ms test total; 74.61 s Vitest duration);
- the latest recorded typecheck and build runs: passed;
- tracked-secret scan: passed for 5 configured keys without exposing a value;
  no stale tracked-file count is asserted; and
- historical research smoke: completed at round 3 with 18 reviews, 18
  cross-reviews, and important evidence coverage 2/2.

## Remaining evidence gaps

The result is intentionally scoped and does not prove more than the recorded run:

- It covers one tenant, one group, one question, and five completed visible
  turns; it is not a load, soak, cross-tenant, or multi-control-plane HA test.
- Immediate summary ended the run before natural nine-turn exhaustion. Automated
  tests cover round boundaries, including turn indexes 3 and 9.
- Pause, resume, and immediate summary were exercised. The destructive **停止**
  control was not exercised in this canonical success run and remains covered by
  automated cancellation and authorization tests.
- The persistent service remained running; restart recovery was verified in
  separate live and automated evidence, not during this exact Discussion.
- The run demonstrates visible provider exchange and cross-provider consensus;
  it does not independently verify every technical statement in every turn.

These boundaries do not qualify the demonstrated 3/3 visible-content, durable
pause/resume, same-card control, steer consumption, Unicode integrity, or
immediate-summary outcomes.
