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
  case "large-line":
    process.stdout.write(`${JSON.stringify({ type: "delta", text: "x".repeat(256) })}\n`);
    break;
  case "hang":
    setInterval(() => {}, 1_000);
    break;
  default:
    process.exitCode = 2;
}
