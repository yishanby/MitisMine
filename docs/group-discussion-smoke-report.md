# Visible group Discussion smoke report

Date: 2026-07-18 (Asia/Shanghai)

Audited code revision: `0b89aa6`

Scope: one real Feishu group Discussion using the persistent four-App service

This is the canonical successful visible-group acceptance run. The earlier
Discussion `01KXSCB2AX0GSY6YNT98S8GN61` is retained only as historical
failure-isolation evidence; its old Codex provider error is not a current result.

## Environment and non-secret identities

| Item | Recorded value |
|---|---|
| Service readiness | HTTP 200; ready=true; store=true; apps=`hub,claude,codex,copilot`; workers=1 |
| Persistent service PID | `63444` |
| Group | `MitisMine Visible Discussion Live Smoke 2026-07-18` |
| Chat | `oc_87039460e2874be6fbf1f007baa0d848` |
| Discussion | `01KXSM5XNX4STNQTPR245H86TY` |
| Control message | `om_x100b6a9b682cb8acdedd8608d972fba` |
| Question | `请三位各用一句话说明 SQLite WAL 的一个适用条件并互相校验；有分歧就指出。` |
| Final durable state | completed; round=3; turn_index=7; version=23 |
| Completed visible turns | 7 |

No App Secret, access token, cookie, authorization header, CLI credential, or
user credential is included here.

## Exact interaction sequence

1. A human sent the question to Hub in the four-bot group. Hub created
   Discussion `01KXSM5XNX4STNQTPR245H86TY` and control message
   `om_x100b6a9b682cb8acdedd8608d972fba`.
2. Five provider turns completed visibly: Claude 0, Codex 1, Copilot 2, Codex 3,
   and Copilot 4.
3. The human clicked **暂停**. The durable record reached `paused` at round 2,
   turn index 5, version 14; the current speaker slot was retained.
4. While paused, the human sent the natural steer:

   ```text
   steer：请重点校正“读只能看到上次 checkpoint”的说法；SQLite WAL 的读事务应看到开始时的数据库快照。
   ```

   The steer was stored as pending rather than lost or executed while paused.
5. The human clicked **继续**. Resume consumed the pending steer in Claude's
   completed turn 5. Claude corrected the checkpoint/visibility statement:
   a WAL read transaction sees the database snapshot established when that
   transaction starts, not merely the state of the last checkpoint.
6. Copilot completed turn 6 and explicitly accepted Claude's correction. This
   made the correction visible as cross-provider validation rather than a Hub-only
   synthesis claim.
7. Claude began the next slot at turn index 7. The human clicked **立即总结**;
   that in-flight turn was intentionally cancelled rather than counted complete.
8. Durable state moved from active to `summarizing` at version 22 and then to
   `completed` at version 23. Hub rendered the completed control card and posted
   the final summary as a separate message, which is the expected product flow.

## Visible identity evidence

| Turn index | Visible App identity | Result |
|---:|---|---|
| 0 | Claude | Completed content |
| 1 | Codex | Completed content |
| 2 | Copilot | Completed content |
| 3 | Codex | Completed content |
| 4 | Copilot | Completed content |
| 5 | Claude | Completed content; consumed steer and issued correction |
| 6 | Copilot | Completed content; explicitly accepted correction |
| 7 | Claude | In flight, then intentionally cancelled by immediate summary |

All three provider identities therefore produced current, real, visible content:
Claude twice, Codex twice, and Copilot three times. The Hub identity supplied the
control card and final synthesis; provider turns were not relabeled as Hub text.

## Durable control and same-card evidence

- Pause was durable at round 2/turn index 5/version 14.
- The steer was durably pending while paused and was consumed only after resume.
- Immediate summary was durable as `summarizing` at version 22 and `completed`
  at version 23.
- The create result established control message
  `om_x100b6a9b682cb8acdedd8608d972fba`.
- Every sent or superseded control-card update through version 23 targeted that
  exact message ID. No second control message replaced it.
- The completed card was visibly rendered. The Hub summary used a separate
  message by design and therefore does not violate the one-control-card invariant.

## Steer correction and cross-validation evidence

The steer targeted a concrete technical disagreement, not only tone or topic.
Claude's turn 5 corrected Copilot's earlier checkpoint/visibility claim by
distinguishing checkpoint progress from the snapshot visible to a read
transaction. Copilot's turn 6 explicitly accepted the correction. The final Hub
summary retained the resolved distinction and also presented consensus, risks,
mitigations, and quantified evidence gaps. This sequence demonstrates all of:

- natural steer persistence while paused;
- consumption by the resumed speaker;
- a visible correction from one provider;
- explicit acknowledgement from another provider; and
- decision-ready synthesis after the disagreement was resolved.

## Verification context

The same final verification window also recorded:

- deterministic tests: 22 files passed, 1 skipped; 207 tests passed, 3 live skipped;
- opt-in real CLI suite: 3/3 passed (Claude 14,283 ms; Codex 27,676 ms;
  Copilot 31,747 ms; 73,708 ms test total; 74.61 s Vitest duration);
- fresh typecheck and build: passed;
- tracked-secret scan: passed for 5 configured keys across 82 tracked files; and
- historical research smoke: completed at round 3 with 18 reviews, 18
  cross-reviews, and important evidence coverage 2/2.

## Remaining evidence gaps

The result is intentionally scoped and does not prove more than the recorded run:

- It covers one tenant, one group, one question, and seven completed turns; it is
  not a load, soak, cross-tenant, or multi-control-plane HA test.
- Immediate summary ended the run before natural nine-turn exhaustion. Automated
  tests cover round boundaries, including turn indexes 3 and 9.
- Pause, resume, and immediate summary were exercised. The destructive **停止**
  control was not exercised in this canonical success run and remains covered by
  automated cancellation and authorization tests.
- The persistent service remained running; restart recovery was verified in
  separate live and automated evidence, not during this exact Discussion.
- The smoke validates visible provider exchange and the observed WAL correction.
  It is not an independent benchmark of every technical statement in every turn.

These gaps do not qualify the demonstrated 3/3 visible-content, durable-control,
same-card, steer-consumption, cross-validation, or immediate-summary outcomes.
