# Native Agent Session Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Feishu direct, Discussion, and Research provider Session run with the same local CLI configuration and modification capabilities as the user's terminal while isolating all control-plane environment variables.

**Architecture:** Add an opt-in native child-environment policy to the JSONL runner and make all three provider adapters select it. Remove provider-specific tool restrictions, use each CLI's supported non-interactive modification policy, and install the existing local Kusto Skill/MCP into Codex and Copilot user profiles without adding capability content or credentials to Git.

**Tech Stack:** TypeScript, Node child processes, Vitest, Codex CLI, Claude Code, GitHub Copilot CLI, user-level Skill and MCP configuration

---

### Task 1: Inherit the native environment behind a control-plane deny boundary

**Files:**
- Modify: `packages/agent-protocol/src/types.ts`
- Modify: `packages/agent-protocol/src/runner.ts`
- Test: `tests/contract/runner.test.ts`
- Test: `tests/unit/secret-isolation.test.ts`

- [ ] **Step 1: Write failing native-inheritance tests**

Add a runner contract test that temporarily sets representative `HTTPS_PROXY`, `AZURE_CONFIG_DIR`, `ANTHROPIC_API_KEY`, and `KUSTO_DEFAULT_CLUSTER` values, calls `curateChildEnvironment` in native mode, and asserts all four remain. Add mixed-case `FEISHU_*`, `LARK_*`, and `MITISMINE_*` values and assert none remain. Keep the existing curated-mode assertions unchanged.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm exec vitest run tests/contract/runner.test.ts tests/unit/secret-isolation.test.ts`

Expected: FAIL because `RunJsonlOptions` and `curateChildEnvironment` do not support a native policy and provider/tool environment values are dropped.

- [ ] **Step 3: Implement the minimal environment policy**

Add this option to `RunJsonlOptions`:

```ts
readonly environmentPolicy?: "curated" | "native";
```

Teach `curateChildEnvironment` to accept the same policy with `"curated"` as the default. In native mode merge `process.env` and supplied overrides, then remove keys matching this case-insensitive boundary:

```ts
const CONTROL_PLANE_ENV = /^(?:FEISHU|LARK|MITISMINE)_/i;
```

Make `runJsonl` pass `options.environmentPolicy` into the helper. Preserve the existing sensitive-value collection so inherited provider/tool secrets are redacted from stderr and structured errors.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run: `pnpm exec vitest run tests/contract/runner.test.ts tests/unit/secret-isolation.test.ts`

Expected: both files pass, curated mode stays backward compatible, native mode preserves local capability variables, and all control-plane prefixes are absent.

### Task 2: Make every provider adapter native and Session-writable

**Files:**
- Modify: `packages/agent-adapters/src/claude.ts`
- Modify: `packages/agent-adapters/src/codex.ts`
- Modify: `packages/agent-adapters/src/copilot.ts`
- Test: `tests/contract/adapters.test.ts`

- [ ] **Step 1: Replace the read-only adapter contract with failing native assertions**

Update the command contract test to require:

```ts
expect(claude.args).toEqual(expect.arrayContaining([
  "--permission-mode", "bypassPermissions", "--tools=default",
]));
expect(codex.args).not.toEqual(expect.arrayContaining([
  "--ignore-user-config", "--strict-config",
]));
expect(copilot.args).toContain("--allow-all");
```

Assert Claude has no `--allowedTools` or `--disallowedTools`, Copilot has no `--available-tools`, and every captured call has `environmentPolicy: "native"`. Exercise start and resume so the Session policy is stable on both invocations.

- [ ] **Step 2: Run the adapter contract and verify RED**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: FAIL because the existing adapters deliberately restrict local configuration and tools.

- [ ] **Step 3: Implement the minimal provider argument changes**

For Claude, replace the current permission/tool block with:

```ts
"--permission-mode",
"bypassPermissions",
"--tools=default",
```

For Codex, remove `PERMISSION_ARGS` and keep only `exec`, JSONL/color transport, `--skip-git-repo-check` for non-repository Topic workspaces, resume, stdin, and working-directory behavior. For Copilot, remove `--available-tools=web_search,web_fetch` and add `--allow-all`. Set `environmentPolicy: "native"` in every adapter's `RunJsonlOptions`.

- [ ] **Step 4: Run the adapter contract and verify GREEN**

Run: `pnpm exec vitest run tests/contract/adapters.test.ts`

Expected: all start/resume, progress, cancellation-facing, and Unicode-recovery adapter contracts pass.

### Task 3: Verify shared mode wiring remains intact

**Files:**
- Verify: `apps/control-plane/src/main.ts`
- Test: `tests/integration/service.test.ts`
- Test: `tests/integration/orchestrator.test.ts`
- Test: `tests/integration/discussion.test.ts`

- [ ] **Step 1: Inspect the composition root**

Confirm the one registry returned by `createAdapters(runJsonl)` is passed unchanged to `ChannelDispatcher`, `ResearchOrchestrator`, and `DiscussionCoordinator`. Do not add mode-specific adapters or permission options.

- [ ] **Step 2: Run all three mode integration suites**

Run: `pnpm exec vitest run tests/integration/service.test.ts tests/integration/orchestrator.test.ts tests/integration/discussion.test.ts`

Expected: direct, Research, and Discussion tests pass with their existing working-directory, external Session resume, progress, steering, and cancellation behavior.

### Task 4: Install the local Kusto capability for Codex and Copilot

**Files:**
- Local-only source: `%USERPROFILE%\.claude\skills\lumina-kusto`
- Local-only targets: `%USERPROFILE%\.agents\skills\lumina-kusto`, Copilot user Skill registry
- Local-only configuration: Codex and Copilot user MCP configuration

- [ ] **Step 1: Link/register the existing Skill without copying it into Git**

On Windows, copy the Skill to Codex's documented personal root, normalize its entry filename to uppercase `SKILL.md`, then register the existing Claude source directory with Copilot:

```powershell
Copy-Item "$HOME\.claude\skills\lumina-kusto" "$HOME\.agents\skills\lumina-kusto" -Recurse
Move-Item "$HOME\.agents\skills\lumina-kusto\skill.md" "$HOME\.agents\skills\lumina-kusto\skill.rename.tmp"
Move-Item "$HOME\.agents\skills\lumina-kusto\skill.rename.tmp" "$HOME\.agents\skills\lumina-kusto\SKILL.md"
copilot skill add "$HOME\.claude\skills\lumina-kusto"
```

If either target is already correctly registered, leave it in place and verify it rather than recreating it.

- [ ] **Step 2: Register the existing `kusto-tools` MCP server for both CLIs**

Read the existing Claude user MCP object locally, pass its command, arguments, and environment directly to each provider's supported user-level `mcp add` command, and do not print or persist those values in the repository. Preload a local script that suppresses ordinary server console output so stdout remains a valid MCP protocol stream. Set Codex `mcp_servers.kusto-tools.default_tools_approval_mode = "approve"` for non-interactive calls. Use `codex mcp list` and `copilot mcp list` to verify an enabled `kusto-tools` entry.

- [ ] **Step 3: Prove the public worktree contains no capability content or credential**

Run: `git status --short` and `pnpm scan:secrets`

Expected: no `.claude`, `.codex`, `.copilot`, Skill content, MCP config, connection string, token, or credential is staged or untracked in the repository.

### Task 5: Run full automated verification and commit the application

**Files:**
- Modify: `docs/completion-audit.md`
- Modify: `docs/live-smoke-report.md`

- [ ] **Step 1: Run repository verification**

Run each command independently and require exit code zero:

```powershell
pnpm test:run
pnpm lint
pnpm typecheck
pnpm build
pnpm scan:secrets
pnpm exec vitest run tests/unit/source-integrity.test.ts
git diff --check
```

- [ ] **Step 2: Commit application and test changes**

Stage only runner, adapter, and test files. Inspect `git diff --cached --check` and the staged diff, then commit with `feat: inherit native agent session capabilities`.

- [ ] **Step 3: Run live start/resume and writable-workspace smoke**

Set `$env:MITISMINE_LIVE_CLI = "1"`, run `pnpm exec vitest run tests/live/cli-smoke.test.ts`, and remove that process-local variable afterward. In disposable directories outside the repository, ask each provider to create a provider-specific marker on the first turn and update it on resume. Verify file contents on disk and remove only those disposable directories after recording evidence.

- [ ] **Step 4: Run live Kusto capability smoke**

Start one new CLI invocation per provider with a prompt that requires discovery and use of `lumina-kusto`/`kusto-tools`, asks for a harmless metadata or bounded query, and forbids printing configuration or credentials. Verify each invocation emits a successful final result and no control-plane variable is visible.

- [ ] **Step 5: Update and commit acceptance evidence**

Record command versions, immutable application SHA, automated test counts, start/resume Session evidence, file-modification evidence, Kusto capability discovery, and secret-isolation results in the two audit documents. Do not record Session IDs, queries containing sensitive data, connection strings, tokens, or raw provider configuration. Commit as `docs: record native session capability verification`.

### Task 6: Push and switch the running service

**Files:**
- Runtime build: `dist/`
- Runtime environment: existing untracked `.env.local`

- [ ] **Step 1: Push the branch**

Run: `git push origin feat/visible-group-discussion`

Expected: the remote branch advances to the acceptance-evidence commit without creating a pull request.

- [ ] **Step 2: Gracefully stop the old service and start the verified build**

Confirm the old PID still belongs to this worktree's MitisMine Node service, send a graceful termination, wait for it to exit, and start `pnpm start` from this worktree in a hidden persistent process/session using the existing `.env.local`. Do not release the new process.

- [ ] **Step 3: Verify the live readiness contract**

Request `http://127.0.0.1:4317/ready` and require a healthy store, four connected Apps, and one Worker. Read the new process output once for startup/provider errors and leave it running for user testing.
