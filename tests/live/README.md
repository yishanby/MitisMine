# Live CLI smoke tests

The live suite uses the currently authenticated local Claude Code, Codex, and
GitHub Copilot CLIs. It is opt-in because it consumes provider quota and creates
persistent provider sessions.

PowerShell:

```powershell
$env:MITISMINE_LIVE_CLI = "1"
pnpm exec vitest run tests/live/cli-smoke.test.ts
Remove-Item Env:MITISMINE_LIVE_CLI
```

The test starts one read-only session per provider and resumes it once. Feishu
credentials are never passed to the child processes.
