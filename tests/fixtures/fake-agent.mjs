import { spawn } from "node:child_process";

const mode = process.argv[2];

switch (mode) {
  case "env":
    process.stdout.write(`${JSON.stringify({
      type: "final",
      safe: process.env.SAFE,
      providerAuth: process.env.ANTHROPIC_API_KEY,
      leaked: Object.keys(process.env).some((key) =>
        /SECRET|TOKEN|COOKIE|AUTHORIZATION|FEISHU|LARK/i.test(key),
      ),
    })}\n`);
    break;
  case "stream":
    process.stdout.write(`${JSON.stringify({ type: "delta", text: "one" })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "final", text: "done" })}\n`);
    break;
  case "malformed":
    process.stdout.write("not-json\n");
    break;
  case "stderr":
    process.stderr.write("x".repeat(Number(process.argv[3] ?? 128)));
    process.stdout.write(`${JSON.stringify({ type: "final" })}\n`);
    break;
  case "stderr-sensitive":
    process.stderr.write("API_TOKEN=synthetic-sensitive-value Authorization: Bearer synthetic-bearer");
    process.stdout.write(`${JSON.stringify({ type: "final" })}\n`);
    break;
  case "error-sensitive":
    process.stdout.write(`${JSON.stringify({
      type: "error",
      code: "provider_error",
      message: "API_TOKEN=synthetic-sensitive-value",
    })}\n`);
    break;
  case "large-line":
    process.stdout.write(`${JSON.stringify({ type: "delta", text: "x".repeat(256) })}\n`);
    break;
  case "hang":
    setInterval(() => {}, 1_000);
    break;
  case "spawn-tree": {
    const descendant = spawn(process.execPath, [import.meta.filename, "ignore-termination"], {
      detached: process.platform === "win32",
      stdio: "ignore",
      windowsHide: true,
    });
    if (process.platform === "win32") descendant.unref();
    process.stdout.write(`${JSON.stringify({ type: "descendant", pid: descendant.pid })}\n`);
    setInterval(() => {}, 1_000);
    break;
  }
  case "ignore-termination":
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    setInterval(() => {}, 1_000);
    break;
  default:
    process.exitCode = 2;
}
