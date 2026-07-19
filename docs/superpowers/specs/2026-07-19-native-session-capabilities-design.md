# Native Agent Session Capabilities Design

## Problem

MitisMine currently launches each provider CLI with a restricted command line and a narrowly curated child environment. The Feishu direct, Discussion, and Research paths therefore do not behave like the same provider launched locally: Codex ignores the user configuration, Claude cannot read or edit files, and Copilot only receives web tools. Local Skills, MCP servers, authentication, proxies, and tool-specific environment variables can also disappear at the child-process boundary.

The product contract is that Feishu is a channel into the user's local agents, not a second limited agent runtime. A provider Session must retain its external Session ID and full local capabilities across every turn, including autonomous file modification, while Feishu control-plane credentials remain unavailable to the provider process.

## Goals

- Make direct chat, visible group Discussion, and background Research use the provider's locally installed CLI capabilities.
- Preserve the provider's user configuration, model selection, Skills, plugins, MCP servers, network configuration, authentication, and writable workspace behavior.
- Grant non-interactive Claude and Copilot turns permission to modify files for the lifetime of the provider Session without per-action confirmation.
- Keep Topic and provider Session isolation, resume behavior, cancellation, progress updates, and Unicode recovery unchanged.
- Make the existing local `lumina-kusto` Skill and `kusto-tools` MCP server available to Codex and Copilot without committing the Skill or credentials to this public repository.
- Prevent Feishu, Lark, and MitisMine control-plane environment variables from reaching any provider child process or its descendants.

## Non-goals

- Building a standalone client or a remote execution sandbox.
- Copying every provider's proprietary configuration into this repository.
- Making all providers expose identical tool names or model behavior.
- Changing Topic, direct Session, Discussion, Research, approval-card, or Feishu command semantics.
- Adding per-file or per-command approvals inside an Agent Session.

## Chosen approach

The runner gains an explicit native environment policy, and all three adapters opt into it. The policy inherits the host process environment so locally authenticated CLIs and MCP subprocesses see the same proxy, cloud identity, and tool configuration as an interactive terminal. Before spawning, the runner removes every `FEISHU_*`, `LARK_*`, and `MITISMINE_*` value. This filtering is centralized and cannot be weakened by an adapter allow-list.

Each adapter then supplies only the flags required for non-interactive JSONL transport, working-directory selection, Session start/resume, and the user's Session-wide modification policy. Provider user configuration remains authoritative for models, Skills, plugins, MCP servers, network access, and provider-specific defaults.

This approach is preferred over duplicating local provider configuration in MitisMine because duplicated configuration drifts and can expose credentials. It is also preferred over a shared synthetic tool allow-list because that would continue to make the Feishu Session weaker than the local CLI.

## Adapter contracts

### Codex

Codex keeps `exec`, JSONL output, stdin prompt delivery, working directory, and `exec resume`. It no longer receives `--ignore-user-config`, `--strict-config`, `--skip-git-repo-check`, or MitisMine permission overrides. The local Codex configuration therefore controls model, approval policy, sandbox, MCP servers, Skills, plugins, and network access. On this host that means the existing `approval_policy = "never"` and writable workspace policy apply to every turn, including resumed turns.

MitisMine does not add `--dangerously-bypass-approvals-and-sandbox`; doing so would be broader than the user's normal local Codex policy. If the user changes the local Codex policy later, new and resumed MitisMine turns inherit that change.

### Claude Code

Claude keeps print mode, streaming JSON, partial messages, verbose events, working directory, and `--resume`. It uses `--permission-mode bypassPermissions` and `--tools=default`. The current allow-list and deny-list are removed. Claude continues to load the user's normal settings, Skills, plugins, hooks, MCP servers, model, and network configuration.

`bypassPermissions` is the explicit Session execution policy needed for autonomous non-interactive work. It is applied on every start and resume invocation, so modification permission remains stable for the entire external Session.

### GitHub Copilot CLI

Copilot keeps non-interactive prompt mode, streamed JSON, no-color output, no `ask_user`, generated Session IDs, and `--resume`. The `--available-tools=web_search,web_fetch` restriction is removed and `--allow-all` is added. Copilot therefore loads its locally configured Skills and MCP servers and can use shell, filesystem, network, and MCP tools without an interactive confirmation prompt.

The existing `--secret-env-vars` defense remains, although the runner removes the listed control-plane variables before Copilot starts.

## Environment and credential boundary

`RunJsonlOptions` receives an explicit native-environment setting. The existing curated policy remains the default for tests and any future untrusted child process. Native mode performs these steps:

1. Start with the host `process.env` and apply explicitly supplied overrides.
2. Remove all variables whose names begin with `FEISHU_`, `LARK_`, or `MITISMINE_`, case-insensitively.
3. Pass the remaining environment to the provider CLI. This includes provider authentication, Azure identity, proxy settings, configuration roots, and MCP/tool variables.
4. Treat values of sensitive-looking variables as redaction inputs for structured error and stderr messages.

The deny boundary is prefix-based instead of enumerating four current App Secrets. New Feishu Apps or MitisMine credentials are therefore isolated automatically. Provider and tool credentials are intentionally preserved because reproducing local capabilities requires them.

## Local capability synchronization

The existing Claude installation remains the local source for `lumina-kusto` and `kusto-tools`:

- Codex receives a user-level directory link from its Skill directory to the existing Claude Skill directory.
- Copilot registers that existing Skill directory through its supported `copilot skill add` command.
- Codex and Copilot receive user-level `kusto-tools` MCP registrations pointing at the already installed local server command and the same local MCP configuration values.

No Skill file, MCP credential, connection string, or generated provider configuration is added to Git. The repository may document verification commands, but the installation itself stays in the user's profile. Because every MitisMine turn launches a fresh CLI process before resuming the external Session, the newly installed capabilities are loaded on the next turn; Topic records and external Session IDs do not need replacement.

## Mode and Session behavior

There is one adapter registry shared by all orchestration paths:

- direct messages call the selected provider adapter and persist the provider's external Session ID per Topic and named direct Session;
- Research calls the same adapters for independent, follow-up, dispute, and sign-off turns;
- Discussion calls the same adapters for visible rotating turns and persists each provider's external Session ID.

No mode-specific restricted adapter is introduced. The working directory remains the absolute per-Topic workspace selected by the control plane, and all modifications made during a Session persist there for later resumed turns. Cancellation still terminates the provider process tree, not the persisted external Session.

## Error handling and observability

- JSONL parsing, output bounds, timeout, cancellation, and process-tree termination remain in the runner.
- Provider stderr and structured error messages continue to redact inherited sensitive values.
- Direct progress callbacks and the Feishu status card continue to receive normalized events while tool inputs and hidden reasoning remain excluded.
- Claude Unicode corruption still triggers at most one rewrite in the same external Session.
- Capability installation failures are reported per provider and do not result in credentials being written to repository files.

## Testing and acceptance

Automated contract tests must prove:

- Codex does not receive local-config or permission-restriction flags.
- Claude receives default tools and Session-wide bypass permission, with no allow/deny tool lists.
- Copilot receives `--allow-all` and no available-tool restriction.
- all adapters request native environment inheritance for both start and resume;
- native inheritance preserves representative proxy, provider-auth, and tool variables while removing mixed-case Feishu, Lark, and MitisMine variables;
- direct, Research, and Discussion paths continue to use the same adapter registry and writable working directory.

Repository verification includes focused tests, the full test suite, lint, typecheck, build, secret scan, Unicode scan, and `git diff --check`.

Live acceptance uses each installed CLI to:

1. start a Session and resume the same Session;
2. create or modify a disposable file in its assigned workspace and verify the change on disk;
3. discover and invoke the installed `lumina-kusto`/`kusto-tools` capability without exposing configuration values;
4. confirm that no Feishu, Lark, or MitisMine control-plane variable is visible to the agent.

## Rollout

The existing service remains running during implementation and verification. After the application commit and live CLI acceptance, MitisMine is rebuilt, the old process is stopped gracefully, and the new build is started with the existing local environment file. `/ready` must report four Apps, one Worker, and a healthy store. The new service process remains running for user testing.
