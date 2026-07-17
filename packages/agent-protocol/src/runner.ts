import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";

import type { AgentErrorEvent, AgentEvent, RunJsonlOptions } from "./types.js";

const SENSITIVE_ENV = /SECRET|TOKEN|COOKIE|AUTHORIZATION|FEISHU|LARK/i;
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
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
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
  const spawnOptions: SpawnOptionsWithoutStdio = {
    env: curateChildEnvironment(options.env, options.allowEnv, options.providerAuthEnv),
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
  const terminate = (reason: NonNullable<typeof termination>): void => {
    if (termination !== undefined) return;
    termination = reason;
    const messages = {
      cancelled: "Agent process cancelled",
      timeout: `Agent process timed out after ${timeoutMs}ms`,
      output_too_large: `Agent stdout exceeded ${maxStdoutBytes} bytes`,
    } as const;
    emit(errorEvent(reason, messages[reason]));
    child.kill();
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
      emit(parsed as AgentEvent);
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
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    if (stdout.length > 0 && termination === undefined) processLine(stdout);
    if (termination === undefined && code !== 0) {
      emit(errorEvent("process_exit", `Agent process exited with code ${code ?? "unknown"}`));
    }
    if (stderrBytes > 0) {
      emit(
        errorEvent(
          "process_stderr",
          stderr.toString("utf8"),
          stderrBytes > maxStderrBytes,
        ),
      );
    }
    done = true;
    wake?.();
    wake = undefined;
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
