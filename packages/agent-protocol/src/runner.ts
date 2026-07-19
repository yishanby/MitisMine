import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { join } from "node:path";

import type { AgentErrorEvent, AgentEvent, RunJsonlOptions } from "./types.js";

const SENSITIVE_ENV = /SECRET|TOKEN|COOKIE|AUTHORIZATION|FEISHU|LARK|PASSWORD|PASSWD|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL/i;
const SENSITIVE_ASSIGNMENT = /\b([a-z0-9_.-]*(?:secret|token|cookie|authorization|password|passwd|api[_-]?key|private[_-]?key|credential)[a-z0-9_.-]*)\s*([:=])\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const CONTROL_PLANE_ENV = /^(?:FEISHU|LARK|MITISMINE)_/i;
const BASE_ENV = new Set([
  "PATH",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
]);

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_TERMINATION_GRACE_MS = 1_000;

function redactSensitive(message: string, knownValues: readonly string[] = []): string {
  let redacted = message;
  for (const value of [...knownValues].sort((left, right) => right.length - left.length)) {
    if (value.length < 4) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted.replace(
    SENSITIVE_ASSIGNMENT,
    (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`,
  );
}

function waitForClose(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("close", finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref();
    child.once("close", finish);
  });
}

async function terminateProcessTree(
  child: ChildProcessWithoutNullStreams,
  graceMs: number,
): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
    const taskkill = spawn(
      join(systemRoot, "System32", "taskkill.exe"),
      ["/PID", String(pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await Promise.race([
      new Promise<void>((resolve) => {
        taskkill.once("error", () => resolve());
        taskkill.once("close", () => resolve());
      }),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        timer.unref();
      }),
    ]);
    await waitForClose(child, graceMs);
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await waitForClose(child, graceMs);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await waitForClose(child, graceMs);
}

function lookup(
  key: string,
  supplied: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const suppliedKey = Object.keys(supplied).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  if (suppliedKey) return supplied[suppliedKey];
  const inheritedKey = Object.keys(process.env).find(
    (candidate) => candidate.toUpperCase() === key.toUpperCase(),
  );
  return inheritedKey ? process.env[inheritedKey] : undefined;
}

export function curateChildEnvironment(
  supplied: Readonly<Record<string, string | undefined>> = {},
  allowEnv: readonly string[] = [],
  providerAuthEnv: readonly string[] = [],
  policy: "curated" | "native" = "curated",
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  if (policy === "native") {
    for (const source of [process.env, supplied]) {
      for (const [key, value] of Object.entries(source)) {
        const existingKey = Object.keys(result).find(
          (candidate) => candidate.toUpperCase() === key.toUpperCase(),
        );
        if (existingKey !== undefined) delete result[existingKey];
        if (value !== undefined && !CONTROL_PLANE_ENV.test(key)) result[key] = value;
      }
    }
    return result;
  }
  const providerKeys = new Set(providerAuthEnv.map((key) => key.toUpperCase()));

  for (const key of BASE_ENV) {
    const value = lookup(key, supplied);
    if (value !== undefined && !SENSITIVE_ENV.test(key)) result[key] = value;
  }
  for (const key of allowEnv) {
    if (SENSITIVE_ENV.test(key) && !providerKeys.has(key.toUpperCase())) continue;
    const value = lookup(key, supplied);
    if (value !== undefined) result[key] = value;
  }
  for (const key of providerAuthEnv) {
    const value = lookup(key, supplied);
    if (value !== undefined) result[key] = value;
  }

  return result;
}

function errorEvent(
  code: AgentErrorEvent["code"],
  message: string,
  truncated?: boolean,
): AgentErrorEvent {
  return truncated === undefined
    ? { type: "error", code, message }
    : { type: "error", code, message, truncated };
}

export async function* runJsonl(options: RunJsonlOptions): AsyncGenerator<AgentEvent> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  const childEnvironment = curateChildEnvironment(
    options.env,
    options.allowEnv,
    options.providerAuthEnv,
    options.environmentPolicy,
  );
  const sensitiveValues = Object.entries(childEnvironment)
    .filter(([key]) => SENSITIVE_ENV.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
  const spawnOptions: SpawnOptionsWithoutStdio = {
    env: childEnvironment,
    detached: process.platform !== "win32",
    windowsHide: true,
  };
  if (options.cwd !== undefined) spawnOptions.cwd = options.cwd;

  const child: ChildProcessWithoutNullStreams = spawn(
    options.command,
    [...(options.args ?? [])],
    spawnOptions,
  );
  if (options.stdin === undefined) child.stdin.end();
  else child.stdin.end(options.stdin, "utf8");
  const queue: AgentEvent[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let stdout = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderr = Buffer.alloc(0);
  let stderrBytes = 0;
  let termination: "cancelled" | "timeout" | "output_too_large" | undefined;

  const emit = (event: AgentEvent): void => {
    queue.push(event);
    wake?.();
    wake = undefined;
  };
  const finish = (): void => {
    if (done) return;
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    done = true;
    wake?.();
    wake = undefined;
  };
  const terminate = (reason: NonNullable<typeof termination>): void => {
    if (termination !== undefined) return;
    termination = reason;
    const messages = {
      cancelled: "Agent process cancelled",
      timeout: `Agent process timed out after ${timeoutMs}ms`,
      output_too_large: `Agent stdout exceeded ${maxStdoutBytes} bytes`,
    } as const;
    emit(errorEvent(reason, messages[reason]));
    void terminateProcessTree(child, terminationGraceMs).finally(finish);
  };
  const processLine = (line: Buffer): void => {
    const normalized = line.at(-1) === 13 ? line.subarray(0, -1) : line;
    if (normalized.length === 0) return;
    if (normalized.length > maxLineBytes) {
      emit(errorEvent("line_too_large", `Agent JSONL line exceeded ${maxLineBytes} bytes`));
      return;
    }
    try {
      const parsed: unknown = JSON.parse(normalized.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || !("type" in parsed) || typeof parsed.type !== "string") {
        throw new TypeError("JSONL event must be an object with a string type");
      }
      const event = parsed as AgentEvent;
      emit(
        event.type === "error" && typeof event.message === "string"
          ? { ...event, message: redactSensitive(event.message, sensitiveValues) }
          : event,
      );
    } catch {
      emit(errorEvent("malformed_jsonl", "Agent emitted malformed JSONL"));
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (termination !== undefined) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      terminate("output_too_large");
      return;
    }
    stdout = Buffer.concat([stdout, chunk]);
    let newline = stdout.indexOf(10);
    while (newline >= 0) {
      processLine(stdout.subarray(0, newline));
      stdout = stdout.subarray(newline + 1);
      newline = stdout.indexOf(10);
    }
    if (stdout.length > maxLineBytes) {
      emit(errorEvent("line_too_large", `Agent JSONL line exceeded ${maxLineBytes} bytes`));
      stdout = Buffer.alloc(0);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    const remaining = Math.max(0, maxStderrBytes - stderr.length);
    if (remaining > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, remaining)]);
  });

  const timeout = setTimeout(() => terminate("timeout"), timeoutMs);
  timeout.unref();
  const abort = (): void => terminate("cancelled");
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });

  child.once("error", () => {
    if (termination === undefined) emit(errorEvent("process_error", "Agent process could not be started"));
  });
  child.once("close", (code) => {
    if (done) return;
    if (stdout.length > 0 && termination === undefined) processLine(stdout);
    if (termination === undefined && code !== 0) {
      emit(errorEvent("process_exit", `Agent process exited with code ${code ?? "unknown"}`));
    }
    if (stderrBytes > 0) {
      emit(
        errorEvent(
          "process_stderr",
          redactSensitive(stderr.toString("utf8"), sensitiveValues),
          stderrBytes > maxStderrBytes,
        ),
      );
    }
    if (termination === undefined) finish();
  });

  while (!done || queue.length > 0) {
    if (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      continue;
    }
    const event = queue.shift();
    if (event !== undefined) yield event;
  }
}
