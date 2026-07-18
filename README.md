# MitisMine

MitisMine turns four Feishu bots into one persistent research workspace. A
question sent to the Hub is researched independently by Claude Code, Codex, and
GitHub Copilot CLI, cross-reviewed, resolved for at most three rounds, and
returned as an evidence-backed report. Each provider bot can also run multiple
named, durable Sessions inside the same Topic. In a Feishu group, the same four
bots can instead hold a visible, automatically advancing roundtable that a user
may steer at any time.

## Implemented

- Four Feishu Apps over SDK persistent connections: Hub, Claude, Codex, Copilot.
- Visible group Discussions: Hub moderates, each provider speaks through its own
  bot identity, natural human messages steer the next turn, and one control card
  provides pause, resume, summarize, and stop without extra slash commands.
- Shared Topic lifecycle, owner/editor/viewer authorization, global user cursor,
  bounded Context Packs, full immutable history, and cross-Run provider sessions.
- Three-provider fan-out, up to two isolated child sessions per provider,
  all-pairs review, dispute repair, signoff, rotating synthesis, and explicit
  unresolved status after round three.
- SQLite WAL checkpoints, durable inbox/effect keys, Outbox, approval state,
  Agent sessions, per-user/provider Session cursors, and local Worker leases
  with heartbeat and restart requeue.
- AbortSignal propagation, bounded/redacted JSONL, process-tree termination,
  repository-external Topic workspaces, and provider-specific tool restrictions.
- HMAC approval cards with principal/Topic/action binding, crash recovery, and
  idempotent trusted writes.

This release uses one control-plane process and one in-process local Worker. The
Worker executes through the same lease port intended for a later remote
transport; a remote listener and multi-control-plane leader election are not
included.

## Prerequisites

- Node.js 24+ and pnpm 11.9+
- Claude Code, Codex CLI, and GitHub Copilot CLI installed and persistently authenticated
- Four published Feishu custom Apps installed in the same tenant

Versions used for the final verification:

- Claude Code `2.1.212`
- Codex CLI `0.143.0`
- GitHub Copilot CLI `1.0.72-0`
- Node.js `24.12.0`; pnpm `11.9.0`

### Configure every Feishu App

For each of the four Apps:

1. Enable the **Bot** feature.
2. Add `im:message:send_as_bot`.
3. Add `im:message.p2p_msg:readonly`; for group use also add
   `im:message.group_at_msg:readonly`. For the recommended multi-bot mention
   flow also add `im:message.group_at_msg.include_bot:readonly`. Add
   `im:message:readonly` only if the tenant should deliver unmentioned group
   messages; MitisMine does not require that broader scope.
4. Under **Events & Callbacks**, select **persistent connection** and add event
   `im.message.receive_v1`. On Hub, also add callback `card.action.trigger`;
   adding it to provider Apps is optional.
5. Create and publish a version, obtain tenant-admin approval, then install the
   bot. Open a direct chat with each bot; in a group, add and @mention it.

The callback is required on Hub for approval and Discussion controls. It may be
registered on all Apps to keep their console configuration uniform, but current
provider Apps do not emit cards. Apart from that distinction, configure the four
Apps identically; only their App IDs, Secrets, display names, and roles differ.

## Install and run

```powershell
pnpm install --frozen-lockfile
Copy-Item .env.example .env.local
```

Before startup, replace every angle-bracket value. Generate a distinct approval
key and capture one real event from the same test user in every App:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

`MITISMINE_IDENTITY_PROBES_JSON` must contain exactly `hub`, `claude`, `codex`,
and `copilot`, with the real `tenantKey` plus exactly one `userId` or `unionId`
from each App's event. Startup rejects missing, placeholder, duplicate, or
mismatched observations. Before filling that variable, run the bootstrap probe
and send one message from the same user to each bot:

```powershell
pnpm identity:probe
```

Copy its single standard-output line into `.env.local`. The probe never prints
App Secrets; progress appears on standard error. See
[the operator guide](docs/operator-guide.md) for the full first-install and
existing-database procedures.

```powershell
pnpm build
pnpm start
```

Readiness:

```powershell
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:4317/ready
```

HTTP 200 requires SQLite, four connected Apps, verified identity observations,
and one healthy Worker.

## Commands and routing

### Group Discussion: recommended collaborative entry

Add all four bots to one Feishu group, then send `@Hub <问题>`. Hub creates or
restores the group's Topic and starts one visible Discussion. Claude, Codex,
and Copilot speak in sequence through their own bot identities; the first
speaker rotates each round. The Discussion ends early on consensus or is
summarized after at most three rounds.

While it is active, any human message delivered to the bots is a soft steer for
the next speaker—no command is required. Mentioning a provider bot prioritizes
that provider without giving it a duplicate turn. Use the single Hub control
card for **暂停**, **继续**, **立即总结**, or **停止**. The same card message is
updated in place. Pause cancels the current Agent turn and resume retries that
speaker slot; summarize cancels the current turn and produces a final Hub
summary; stop cancels without producing a summary. One group runs at most one
active Discussion; after it reaches a terminal state, the next question starts
another Discussion in the same Topic.

The reliable Feishu path is to @mention Hub for a new question or steer. If the
tenant's event permissions also deliver unmentioned group messages, those are
handled identically. Bot-authored messages are discarded before inbox and
identity processing, so the four Apps cannot trigger a feedback loop.

### Direct-chat commands

Topic/read/control commands are handled by the Hub App in direct chat. Ordinary
Hub text and `/research` run the full evidence workflow. Ordinary text sent to a
provider App continues that provider's selected Session in the current Topic.

| Command | App | Purpose |
|---|---|---|
| `/topic new <title>` | Hub | Create and select a Topic |
| `/topic list` | Hub | List accessible Topics |
| `/topic use <prefix>` | Any | Select the one accessible Topic whose ID has that unambiguous prefix |
| `/topic show` | Any | Show current Topic and watermark |
| `/topic share @user <editor\|viewer>` | Hub | Share using a Feishu @mention |
| `/topic archive` | Hub | Archive without deleting history |
| `/note <text>` | Hub | Add Context Pack history without starting agents |
| `/research <question>` | Hub | Run the complete three-provider workflow |
| `/status`, `/report` | Any | Read latest Run/report |
| `/stop` | Hub | Cancel the active Run and process trees |
| `/action write <relative-path> <content>` | Hub | Create an approval card for a trusted write |
| `/session new <title>` | Provider | Create and select a named Session |
| `/session list` | Provider | List this Agent's Sessions in the current Topic |
| `/session use <ID-or-title>` | Provider | Select and implicitly resume a Session |
| `/session resume <ID-or-title>` | Provider | Alias of `/session use` |
| `/session show` | Provider | Show the current Session and recovery state |
| `/session rename <title>` | Provider | Rename the current Session |
| `/session archive` | Provider | Archive the current Session and select a fallback |

`/topic use` has no fixed prefix length; zero or multiple matches are rejected.
For automation, `/topic share` also accepts the canonical
`tenant:user:<user_id>` or `tenant:union:<union_id>`, but an @mention is safer.
Viewers may read Topic/report state but cannot mutate, start/stop Runs, or
request actions. They may list/show/select an existing Session but cannot create,
rename, archive, or send a provider message.

A provider message with no selected Session lazily creates `main`. Session
cursors are independent per user, Topic, and provider, so switching Topics or
Agent Apps restores the relevant last selection. Shared Topic notes remain
visible, while direct messages and replies from other Sessions are excluded.
Turns in one Session run in order; different Sessions may run concurrently.
Research, visible Discussions, and direct Sessions share one global provider
concurrency budget of six.

## Verify

```powershell
pnpm lint
pnpm typecheck
pnpm test --run
pnpm build
```

Real CLI start+resume tests consume provider quota:

```powershell
$env:MITISMINE_LIVE_CLI = "1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

With the service running in another terminal, audit the recorded four-App flow.
This command loads `.env.local` and honors independent DB/Data paths:

```powershell
pnpm smoke:live
pnpm scan:secrets
```

The script audits existing live data; it does not send Feishu messages or click
approval cards.

## Security boundary

Feishu App Secrets stay in the control plane. Children receive neither Feishu
Secrets nor raw provider API/OAuth token environment variables. Claude and
Copilot use explicit research-tool lists; Codex uses its current workspace
permission profile with `.env` reads denied. Topic workspaces are outside the
repository, stderr is redacted, and cancellation kills process trees.

Provider CLIs still run under the service OS account and use that account's
persisted login. Treat the host account as trusted and isolate it at the OS or
container layer for hostile workloads. See [operator-guide.md](docs/operator-guide.md)
for Secret Manager startup, backup/recovery, and known boundaries, and
[completion-audit.md](docs/completion-audit.md) for acceptance evidence.
