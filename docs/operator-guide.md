# MitisMine operator guide

## 1. Topology

One control plane owns four Feishu persistent connections, HTTP health routes,
the durable inbox/Outbox, Orchestrator, Approval Engine, and a local Worker. The
Worker uses SQLite-backed leases and heartbeats for every provider call.

| Role | App ID | Behavior |
|---|---|---|
| Hub | `cli_aad0b5b7aeb89cc4` | Topic management and full research |
| Claude | `cli_aad0b5ed06f8dd23` | Claude direct continuation |
| Codex | `cli_aad0b6053e78dd01` | Codex direct continuation |
| Copilot | `cli_aad0b65c14f8dd24` | Copilot direct continuation |

Never put App Secrets, approval keys, provider credentials, or Cookies in
source control, prompts, logs, screenshots, or this guide.

## 2. Feishu console setup

Repeat for all four Apps:

1. Enable **Bot**.
2. Grant `im:message:send_as_bot`, `im:message.p2p_msg:readonly`, and, for
   groups, `im:message.group_at_msg:readonly`. Add
   `im:message.group_at_msg.include_bot:readonly` if messages may mention other
   bots. `im:message:readonly` is also present in the verified deployment.
3. Select **Events & Callbacks → persistent connection**.
4. Add event **Message received v2.0** (`im.message.receive_v1`).
5. Add callback **Card callback communication** (`card.action.trigger`).
6. Publish a version, have the tenant admin approve/install it, and add the bot
   to its direct/group chats.

All four App IDs must be unique. Approval cards cannot work without the callback.

## 3. Configuration and identity preflight

Copy `.env.example` to `.env.local` for local operation and replace every
placeholder. `MITISMINE_DB_PATH` and `MITISMINE_DATA_DIR` are independent.
`MITISMINE_AGENT_WORKSPACE_ROOT` is optional and defaults to
`~/.mitismine/agent-workspaces`; configuration rejects a path inside the repo.

Generate `MITISMINE_APPROVAL_KEY` separately from App Secrets:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

For a fresh install, leave the example observation value in place and run the
bootstrap collector. It loads only the four App IDs/Secrets from `.env.local`,
opens four temporary persistent connections, and does not start the control
plane or open its database:

```powershell
pnpm identity:probe
```

Send one message from the same Feishu account to Hub, Claude, Codex, and Copilot.
Progress is written to standard error. The sole standard-output line is
`MITISMINE_IDENTITY_PROBES_JSON=<json>`; paste that entire line into
`.env.local`. The collector prefers the cross-App `union_id`, validates that all
four observations resolve to one principal, closes every temporary socket, and
never prints a Secret.

For an already-populated database, the following fallback reconstructs
observations from persisted message events. Run it with the same `.env.local`
path semantics as the service; it emits identifiers, never Secrets:

```powershell
@'
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(process.env.MITISMINE_DB_PATH ?? "data/mitismine.db", { readOnly:true });
const rows = db.prepare(`SELECT json_extract(e.payload_json,'$.appRole') appRole,
 e.actor_principal_id principal, t.tenant_key tenantKey, MAX(e.seq) seq
 FROM topic_events e JOIN topics t ON t.id=e.topic_id
 WHERE e.type IN ('message.added','agent.direct.message')
 GROUP BY appRole,principal,tenantKey ORDER BY appRole,seq DESC`).all();
const roles = ["hub","claude","codex","copilot"];
const observations = roles.map(appRole => {
  const r = rows.find(x => x.appRole === appRole); if (!r) throw new Error(`missing ${appRole}`);
  const user = `${r.tenantKey}:user:`, union = `${r.tenantKey}:union:`;
  if (r.principal.startsWith(user)) return {appRole,tenantKey:r.tenantKey,userId:r.principal.slice(user.length)};
  if (r.principal.startsWith(union)) return {appRole,tenantKey:r.tenantKey,unionId:r.principal.slice(union.length)};
  throw new Error(`invalid principal for ${appRole}`);
});
console.log(JSON.stringify({observations})); db.close();
'@ | node --env-file=.env.local --input-type=module
```

Set the one-line output as `MITISMINE_IDENTITY_PROBES_JSON`. Startup validates
the document before its first external side effect and refuses missing roles,
duplicates, placeholders, or principals that do not match.

### Production Secret Manager injection

`pnpm start` deliberately reads `.env.local`. In production, let the service
manager/Secret Manager inject environment variables into the process and run
the built artifact directly:

```powershell
node dist/apps/control-plane/src/main.js
```

For Windows PowerShell, install and register a SecretManagement vault once under
the dedicated service account. The example uses Microsoft's local SecretStore;
replace it with the organization's vault module when appropriate:

```powershell
Install-Module Microsoft.PowerShell.SecretManagement -Scope CurrentUser
Install-Module Microsoft.PowerShell.SecretStore -Scope CurrentUser
Import-Module Microsoft.PowerShell.SecretManagement
Register-SecretVault -Name MitisMineVault `
  -ModuleName Microsoft.PowerShell.SecretStore -DefaultVault

# Run once; Read-Host masks every value and keeps it out of shell history.
foreach ($name in @(
  'FEISHU_HUB_APP_SECRET','FEISHU_CLAUDE_APP_SECRET',
  'FEISHU_CODEX_APP_SECRET','FEISHU_COPILOT_APP_SECRET',
  'MITISMINE_APPROVAL_KEY','MITISMINE_IDENTITY_PROBES_JSON'
)) {
  Set-Secret -Vault MitisMineVault -Name $name `
    -Secret (Read-Host "Enter $name" -AsSecureString)
}
```

After `pnpm build`, save the following as the service wrapper and adjust the
three absolute directories. It maps every required variable, restores any
previous process values in `finally`, and never places Secret values in command
arguments or shell history:

```powershell
$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.SecretManagement
$vault = 'MitisMineVault'
$repo = 'D:\Services\MitisMine'
$names = @(
  'MITISMINE_DB_PATH','MITISMINE_DATA_DIR','MITISMINE_AGENT_WORKSPACE_ROOT',
  'MITISMINE_HTTP_HOST','MITISMINE_HTTP_PORT','MITISMINE_APPROVAL_KEY',
  'MITISMINE_IDENTITY_PROBES_JSON','FEISHU_HUB_APP_ID','FEISHU_HUB_APP_SECRET',
  'FEISHU_CLAUDE_APP_ID','FEISHU_CLAUDE_APP_SECRET','FEISHU_CODEX_APP_ID',
  'FEISHU_CODEX_APP_SECRET','FEISHU_COPILOT_APP_ID','FEISHU_COPILOT_APP_SECRET'
)
$previous = @{}
foreach ($name in $names) {
  $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
  $env:MITISMINE_DB_PATH = 'D:\MitisMine\state\mitismine.db'
  $env:MITISMINE_DATA_DIR = 'D:\MitisMine\data'
  $env:MITISMINE_AGENT_WORKSPACE_ROOT = 'D:\MitisMine\agent-workspaces'
  $env:MITISMINE_HTTP_HOST = '127.0.0.1'
  $env:MITISMINE_HTTP_PORT = '4317'
  $env:FEISHU_HUB_APP_ID = 'cli_aad0b5b7aeb89cc4'
  $env:FEISHU_CLAUDE_APP_ID = 'cli_aad0b5ed06f8dd23'
  $env:FEISHU_CODEX_APP_ID = 'cli_aad0b6053e78dd01'
  $env:FEISHU_COPILOT_APP_ID = 'cli_aad0b65c14f8dd24'
  foreach ($name in @(
    'FEISHU_HUB_APP_SECRET','FEISHU_CLAUDE_APP_SECRET',
    'FEISHU_CODEX_APP_SECRET','FEISHU_COPILOT_APP_SECRET',
    'MITISMINE_APPROVAL_KEY','MITISMINE_IDENTITY_PROBES_JSON'
  )) {
    [Environment]::SetEnvironmentVariable(
      $name, (Get-Secret -Vault $vault -Name $name -AsPlainText), 'Process'
    )
  }
  Push-Location $repo
  try { node dist/apps/control-plane/src/main.js } finally { Pop-Location }
} finally {
  foreach ($name in $names) {
    if ($null -eq $previous[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
  }
}
```

Provider API/OAuth token variables are intentionally not forwarded;
authenticate Claude, Codex, and Copilot persistently under the dedicated service
account.

## 4. Startup and health

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Startup validates config/identity, opens WAL storage, requeues expired leases,
registers the local Worker, starts Outbox/recovery, then lets the four App
sockets accept events. Failed non-terminal resumes are logged and retried;
an active Run is coalesced with recovery instead of duplicated. Any
`listen()`/connection-readiness failure unwinds sockets and stores. `/health`
means the process is alive;
`/ready` returns 200 only when storage, four Apps, and a Worker are healthy.

## 5. Operation

Full research phases are:

```text
independent_research -> subtask_research -> normalize_evidence
-> cross_review <-> resolve_disputes -> synthesize -> signoff -> completed
```

Provider calls use deterministic task IDs, a 30-second lease, and 10-second
heartbeats. Expired leases become queued; checkpoint resume leases the same task
ID again. Each provider proposes at most two isolated child sessions and all
active calls share a concurrency limit of six. Round three completes with
`unresolved=true` rather than hiding disagreement.

Use `/status`, `/report`, and `/stop`. A stop aborts queued/active calls, kills
their process trees, requeues their leases, and persists `cancelled` with
terminal-state precedence.

### Standalone Agent Sessions

In the Claude, Codex, or Copilot App, ordinary text goes to that provider's
current Session. Each Topic may contain multiple Sessions per provider:

```text
/session new <title>
/session list
/session use <short-ID-or-unique-title>
/session resume <short-ID-or-unique-title>
/session show
/session rename <title>
/session archive
```

The external CLI Session is created lazily on the first ordinary message and
resumed thereafter. With no selection, that message creates `main`. The current
selection is saved per user, Topic, and provider; switching Topics or Apps does
not overwrite the other cursors. Shared Topic notes remain in every Context
Pack, but direct conversation events from other Sessions are filtered out.
Calls in one Session are serialized; different Sessions can execute in
parallel. Titles are case-insensitively unique within a Topic/provider.

Owners and editors may perform all operations. Viewers may list, show, and
select Sessions for inspection, but cannot create, rename, archive, or invoke
an Agent. Session commands sent to Hub return guidance instead of mutating data.

## 6. Approvals

`/action write <relative-path> <content>` creates a medium-risk approval whose
token binds the request, Topic, approver, action hash, and expiration. Status is
changed to `executing` before the trusted write and `completed` afterward.

On startup, an orphaned `executing` row is restored to `pending`. If the process
died after writing but before saving completion, the trusted executor replays
the same idempotency key: identical content is accepted without rewriting;
different content fails. Concurrent clicks see executing/unavailable; later
clicks return the stored completed result. Targets are restricted to
`MITISMINE_DATA_DIR/approved-actions/`; absolute paths and `..` escapes fail.

Back up and restore the original `MITISMINE_APPROVAL_KEY`. Replacing it
invalidates pending approval tokens.

## 7. Shutdown

Send SIGINT/SIGTERM (Ctrl+C on Windows). The service stops accepting work,
awaits the current Outbox flush, closes Feishu sockets, then closes SQLite.
Runner cancellation has a bounded grace period and terminates the process tree.

## 8. Backup and restore

Offline backup is the safest procedure:

1. Stop the service cleanly.
2. Resolve and copy the exact file configured by `MITISMINE_DB_PATH`, including
   its `-wal` and `-shm` siblings if present.
3. Separately copy the complete `MITISMINE_DATA_DIR`, including
   `approved-actions/`; do not assume the database is inside this directory.
4. Back up configuration metadata and the Secret Manager references/versions
   for App Secrets and `MITISMINE_APPROVAL_KEY` without exporting them to Git.
5. Restore all items from one consistent snapshot, start, check `/ready`, then
   run `scripts/live-smoke.ts`.

For online database backup, use SQLite's backup API or `VACUUM INTO`; copying
only the main `.db` while WAL is active is invalid. Pause trusted actions and
snapshot `MITISMINE_DATA_DIR` in the same maintenance window, otherwise the DB
approval result and non-database target files may describe different moments.

## 9. Recovery and troubleshooting

- Duplicate/retried Feishu events use a durable inbox plus deterministic Topic,
  message, Run, history, and Outbox effect keys.
- Service restart resets inbox `processing` to `pending`, approval `executing`
  to `pending`, interrupted direct Sessions from `running` to `active`, and
  expired Worker leases to `queued`.
- Legacy `agent_sessions` rows with role `direct` are migrated idempotently to
  a `main` direct Session while retaining the external Session ID and watermark.
- Provider failure gets one report-repair attempt; two providers may complete a
  degraded Run, while fewer than two pauses it.
- Outbox retries with exponential backoff to 60 seconds and sends a stable
  Feishu UUID, so API replay is idempotent.
- `/ready` 503: inspect `store`, four `apps`, and `workers`; verify App
  ID/Secret pairing, persistent-connection settings, and published versions.
- Codex 401: run `codex login status` under the service account and reauthenticate;
  MitisMine will not fall back to raw token injection.
- Missing cards: inspect `outbox_messages`, send permission, callback
  registration, and the destination chat ID.

## 10. Reproduce live verification

Terminal A (blocks while the service runs):

```powershell
pnpm build
pnpm start
```

In Feishu, use these exact inputs when creating fresh audit evidence:

1. In Hub, send `/topic new Live smoke`.
2. In Hub, send `/research Verify RFC 2606 reserved DNS names using RFC Editor, IETF, and IANA primary sources.` and wait for the final report.
3. In each provider App, send `/session new RFC evidence`, followed by
   `Continue this Topic and summarize your strongest RFC 2606 evidence.`. This
   creates three independent external Sessions.
4. In Claude, additionally create `/session new Counterarguments`, send one
   ordinary message, switch back with `/session use RFC evidence`, and verify
   `/session show` reports the first Session.
5. Stop Terminal A with Ctrl+C, start it again with `pnpm start`, wait for
   `/ready` HTTP 200, then send `Resume this Topic after restart.` once to each
   provider App. This proves the selected Sessions and external IDs resume.
6. In Hub, send `/status` and `/report`.
7. In Hub, send `/action write smoke/approved.txt approved-by-feishu`. Verify
   the file did not appear before approval, click **Approve**, then click the
   same approval button again to exercise idempotency.

The title must be exactly `Live smoke`; the research question must contain
`RFC 2606`; and the approved relative path/content must be exactly
`smoke/approved.txt` / `approved-by-feishu`, because the audit checks those
values. The audit script itself sends no message and clicks no card:

```powershell
pnpm smoke:live
```

Real CLI start+resume is a separate quota-consuming command:

```powershell
$env:MITISMINE_LIVE_CLI="1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

## 11. Secret and repository audit

This scan uses Node's dotenv parser, so quoted values, `#` inside quotes, and
trailing comments are decoded correctly. It recognizes common Secret names
including `SECRET`, `TOKEN`, `PASSWORD`/`PASSWD`, `COOKIE`, `CREDENTIAL`,
`KEY`/`API_KEY`/`PRIVATE_KEY`, and `AUTHORIZATION`; compares both the staged Git
index and working tree; and prints only key/file metadata, never values:

```powershell
pnpm scan:secrets
git check-ignore .env.local
git ls-files .env.local
pnpm exec vitest run tests/unit/secret-isolation.test.ts tests/contract/runner.test.ts
```

Expected: scan clean, `.env.local` is ignored, `git ls-files` prints nothing,
and tests pass.

## 12. Known first-version boundaries

- The normalized `claims`, `evidence`, and `critiques` tables are reserved;
  current durable report/ledger content is checkpoint JSON. Context Packs carry
  Topic metadata/history/watermark but not a separate Artifact index.
- Direct provider calls are read-only; Session metadata, cursor, external ID,
  and event effects are durable. A crash during an external CLI turn may still
  require the user to resend that final message because provider-side commit
  state cannot be atomically committed with SQLite.
- The Worker transport is local only. Remote Workers, leader election, and
  multi-control-plane high availability are not shipped.
- Provider CLIs use the service OS account's persistent credential stores; use
  a dedicated restricted account or container for stronger hostile-workload isolation.
