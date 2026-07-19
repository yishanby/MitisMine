# Visible group Discussion smoke report

Date: 2026-07-18 (Asia/Shanghai)

Canonical interaction revision: `dcc1df4fb5cedd74ff2f8d19d17bf987e42e385a`

Current audited application revision: `04c04d4a17cfe7fe6f4227c1cf268dfa6bb38399`

Scope: one real Feishu group Discussion using the rebuilt persistent four-App
service. This is the canonical Unicode-clean visible-group acceptance run.

The immutable Feishu interaction was recorded on the canonical interaction
revision. Subsequent code through the current audited application revision was
verified against the same durable records and adds recovery, identity,
summary-steer, and startup-query hardening without claiming a second UI run.

Service PID `58564` belongs to the canonical `dcc1df4` Feishu acceptance
window. The exact CLI durations below come from a separate opt-in run on the
current `04c04d4` application revision.

Discussion `01KXSM5XNX4STNQTPR245H86TY` is retained only as historical pre-fix
evidence: a Claude turn and the Hub summary contain U+FFFD, so that run is not
canonical, Unicode-clean, polished, or decision-ready. The still earlier
Discussion `01KXSCB2AX0GSY6YNT98S8GN61` remains historical failure-isolation
evidence only.

## Environment and non-secret identities

| Item | Recorded value |
|---|---|
| Service readiness | HTTP 200; ready=true; store=true; apps=`hub,claude,codex,copilot`; workers=1 |
| Canonical interaction service PID | `58564` |
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

## UI-observable interaction sequence

1. In Feishu, the human clicked the @ toolbar, selected the real mention entity
   whose display name is exactly `MitisMine 总控`, verified it was an entity
   mention, and then typed the recorded question. Merely typing `@Hub` or plain
   text is not the reproduced start path.
2. Hub displayed one control card. Claude and Codex completed visible replies
   under their own App identities. As Copilot began its next visible activity,
   the human clicked **暂停**, and the card rendered a paused state.
3. While paused, the human selected a genuine `MitisMine 总控` entity mention
   and sent this natural steer:

   ```text
   请把后续发言控制在60个汉字内，并明确：读事务看到开始时的已提交快照。
   ```

4. The human clicked **继续**. The next Copilot reply visibly addressed the
   transaction-start committed snapshot point. The subsequent Codex reply
   narrowed the overstrong claim that cross-host/NFS access would `必然损坏` to
   unreliable and not recommended; the next Copilot reply accepted that
   correction.
5. As Claude began the next visible activity, the human clicked **立即总结**.
   No additional Claude provider message appeared. The existing control card
   rendered a completed state, and Hub sent the Unicode-clean summary as a
   separate message rather than inside or on that control card.

The UI therefore proves visible identities and content, the rendered
pause/completed states, the absence of an additional Claude provider message,
and the separate Hub summary. It does not expose exact turn indexes, versions,
steer status, cancelled/completed database rows, or Outbox target message IDs.

## Recorded durable interaction audit

A subsequent read-only SQLite/Outbox audit—not the visible UI alone—established
the exact durable sequence:

1. Create established Discussion `01KXSRVC8DFBMTJRSY1KJKCM5C` and control
   message `om_x100b6a84163cb4a0c3dadf616c2fcda`.
2. Pause cancelled the in-flight Copilot turn 2 attempt and persisted `paused`
   at round 1, turn index 2, version 8 while retaining the Copilot speaker slot.
3. User steer `om_x100b6a8429f170b0c4afe4588666c37` stayed pending while
   paused and was consumed by Copilot turn 2 only after resume. The separately
   consumed initial steer represents the start question, not this user steer.
4. Claude turn 5 was recorded as cancelled with no visible content. Immediate
   summary persisted `summarizing` at round 2, turn index 5, version 18 and then
   `completed` at version 19.
5. Every sent or superseded control update targeted the same control message ID.
   Every visible provider and summary Outbox row was sent; the summary was a
   separate Hub message.

The persisted Copilot turn 2 text was:

```text
同意二位。WAL 核心优势：读事务见启动快照，无脏读且并发高效。关键限制是单写者、内存映射依赖。NFS 跨主机访问违反映射前提—确实会导致损坏。建议补充：WAL 文件与数据库需同盘位置。
```

It followed the snapshot instruction but not the length constraint stated in
both the initial question and the repeated steer: it measured 93 UTF-16 code
units, 93 code points, and 71 Han characters. The steer's `consumed` status
proves delivery and association with Copilot turn 2, not full provider
compliance with every instruction.

## Visible messages and durable turn rows

The App identities and message content were visible in Feishu. The turn indexes,
lengths, and completed/cancelled outcomes in this table come from the separate
read-only Discussion audit.

| Turn index | Visible App identity | Code points | Han characters | ≤60 Han | Result |
|---:|---|---:|---:|---|---|
| 0 | Claude | 99 | 72 | No | Completed visible content; violated the initial length limit |
| 1 | Codex | 58 | 37 | Yes | Completed visible content |
| 2 | Copilot | 93 | 71 | No | Completed after resume; violated both the initial and repeated length limits |
| 3 | Codex | 47 | 30 | Yes | Completed; corrected the overstrong NFS/cross-host claim |
| 4 | Copilot | 66 | 46 | Yes | Completed; accepted the Codex correction |
| 5 | Claude | — | — | — | In flight, then intentionally cancelled; no visible content |

Length adherence was therefore partial: three of five completed replies met the
initial ≤60-Han requirement, while Claude turn 0 (72 Han) and Copilot turn 2
(71 Han) did not. Copilot turn 2 also missed the repeated post-pause limit. The
provider messages addressed the requested WAL and snapshot points, but semantic
relevance and a `consumed` steer do not establish compliance with the separate
length rule.

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

- fresh root `pnpm test:run`: 23 test files passed, 1 skipped; 345 tests passed,
  3 opt-in live tests skipped; duration 10.27 s;
- current-revision opt-in real CLI suite: 3/3 passed (Claude 21,122 ms;
  Codex 27,585 ms; Copilot 46,109 ms; 94,817 ms test total; 95.79 s Vitest
  duration);
- the final recorded lint, typecheck, and build runs: passed;
- tracked-secret scan: passed for 5 configured keys without exposing a value;
  no stale tracked-file count is asserted; and
- historical research smoke: completed at round 3 with 18 reviews, 18
  cross-reviews, and important evidence coverage 2/2.

The post-interaction recovery suite additionally covers missing Claude direct
Session replacement, exact v2, scoped legacy,
and minimal v0 event replay; Hub-only start; tenant/chat and principal/text
scoping; failed-turn resume; receipt-first and event-first crash repair; bound
legacy-event replay without duplicate events; terminal consumed tombstones;
provider-preference reconciliation; summary inclusion of pending steers;
steer-arrival regeneration; bounded paid retries; and indexed startup and
`(topic_id, seq)` lookup. These are deterministic scenario results; they do not
retroactively turn the canonical UI observation into a new live interaction.

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
