export interface AgentDataEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AgentErrorEvent extends AgentDataEvent {
  readonly type: "error";
  readonly code:
    | "cancelled"
    | "line_too_large"
    | "malformed_jsonl"
    | "output_too_large"
    | "process_error"
    | "process_exit"
    | "process_stderr"
    | "timeout";
  readonly message: string;
  readonly truncated?: boolean;
}

export type AgentEvent = AgentDataEvent | AgentErrorEvent;

export interface RunJsonlOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string;
  readonly allowEnv?: readonly string[];
  readonly providerAuthEnv?: readonly string[];
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly maxLineBytes?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly terminationGraceMs?: number;
}
