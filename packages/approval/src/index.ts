import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { z } from "zod";

export type ApprovalRisk = "low" | "medium" | "high";
export type ApprovalStatus = "pending" | "executing" | "completed" | "failed" | "expired";

export interface ApprovalAction {
  readonly topicId: string;
  readonly kind: string;
  readonly target: string;
  readonly risk: ApprovalRisk;
  readonly parameters: unknown;
}

export interface StoredApprovalRequest {
  readonly id: string;
  readonly topicId: string;
  readonly requesterPrincipalId: string;
  readonly approverPrincipalId: string;
  readonly action: ApprovalAction;
  readonly actionHash: string;
  readonly idempotencyKey: string;
  readonly expiresAt: string;
  readonly status: ApprovalStatus;
  readonly result?: unknown;
  readonly error?: string;
}

export interface ApprovalRequestWithToken {
  readonly request: StoredApprovalRequest;
  readonly token: string;
}

export interface ApprovalStore {
  create(request: StoredApprovalRequest): void;
  get(id: string): StoredApprovalRequest | undefined;
  beginExecution(id: string): boolean;
  complete(id: string, result: unknown): void;
  fail(id: string, message: string): void;
  expire(id: string): void;
}

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #requests = new Map<string, StoredApprovalRequest>();

  create(request: StoredApprovalRequest): void {
    if (this.#requests.has(request.id)) throw new Error(`Approval already exists: ${request.id}`);
    this.#requests.set(request.id, structuredClone(request));
  }

  get(id: string): StoredApprovalRequest | undefined {
    const request = this.#requests.get(id);
    return request === undefined ? undefined : structuredClone(request);
  }

  beginExecution(id: string): boolean {
    const request = this.#required(id);
    if (request.status !== "pending") return false;
    this.#requests.set(id, { ...request, status: "executing" });
    return true;
  }

  complete(id: string, result: unknown): void {
    const request = this.#required(id);
    if (request.status !== "executing") throw new Error("Approval is not executing");
    this.#requests.set(id, { ...request, status: "completed", result: structuredClone(result) });
  }

  fail(id: string, message: string): void {
    const request = this.#required(id);
    this.#requests.set(id, { ...request, status: "failed", error: message });
  }

  expire(id: string): void {
    const request = this.#required(id);
    if (request.status === "pending") this.#requests.set(id, { ...request, status: "expired" });
  }

  #required(id: string): StoredApprovalRequest {
    const request = this.#requests.get(id);
    if (request === undefined) throw new Error(`Approval not found: ${id}`);
    return request;
  }
}

interface ApprovalEngineOptions {
  readonly signingSecret: string | Uint8Array;
  readonly store: ApprovalStore;
  readonly executor: (action: ApprovalAction, idempotencyKey: string) => Promise<unknown>;
  readonly now?: () => Date;
  readonly defaultTtlMs?: number;
  readonly idFactory?: () => string;
}

interface RequestOptions {
  readonly approverPrincipalId?: string;
  readonly ttlMs?: number;
}

const tokenPayloadSchema = z.object({
  requestId: z.string().uuid(),
  topicId: z.string().min(1),
  principalId: z.string().min(1),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime({ offset: true }),
});
type TokenPayload = z.output<typeof tokenPayloadSchema>;

export class ApprovalEngine {
  readonly #secret: string | Uint8Array;
  readonly #store: ApprovalStore;
  readonly #executor: ApprovalEngineOptions["executor"];
  readonly #now: () => Date;
  readonly #defaultTtlMs: number;
  readonly #idFactory: () => string;

  constructor(options: ApprovalEngineOptions) {
    if (typeof options.signingSecret === "string" && options.signingSecret.length < 32) {
      throw new Error("Approval signing secret must contain at least 32 characters");
    }
    if (options.signingSecret instanceof Uint8Array && options.signingSecret.byteLength < 32) {
      throw new Error("Approval signing secret must contain at least 32 bytes");
    }
    this.#secret = options.signingSecret;
    this.#store = options.store;
    this.#executor = options.executor;
    this.#now = options.now ?? (() => new Date());
    this.#defaultTtlMs = options.defaultTtlMs ?? 10 * 60 * 1_000;
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  request(
    action: ApprovalAction,
    requesterPrincipalId: string,
    options: RequestOptions = {},
  ): ApprovalRequestWithToken {
    const id = this.#idFactory();
    const approverPrincipalId = options.approverPrincipalId ?? requesterPrincipalId;
    const ttlMs = options.ttlMs ?? this.#defaultTtlMs;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Approval TTL must be positive");
    const expiresAt = new Date(this.#now().getTime() + ttlMs).toISOString();
    const actionHash = sha256(canonicalJson(action));
    const idempotencyKey = sha256(`${id}\n${actionHash}`);
    const request: StoredApprovalRequest = {
      id,
      topicId: action.topicId,
      requesterPrincipalId,
      approverPrincipalId,
      action: structuredClone(action),
      actionHash,
      idempotencyKey,
      expiresAt,
      status: "pending",
    };
    this.#store.create(request);
    const token = this.#sign({
      requestId: id,
      topicId: action.topicId,
      principalId: approverPrincipalId,
      actionHash,
      expiresAt,
    });
    return { request, token };
  }

  async approve(token: string, principalId: string): Promise<unknown> {
    const payload = this.#verify(token);
    const request = this.#store.get(payload.requestId);
    if (request === undefined) throw new Error("Approval request not found");
    if (payload.principalId !== principalId || request.approverPrincipalId !== principalId) {
      throw new Error("Approval principal does not match token");
    }
    if (
      payload.topicId !== request.topicId ||
      payload.actionHash !== request.actionHash ||
      payload.expiresAt !== request.expiresAt ||
      sha256(canonicalJson(request.action)) !== request.actionHash
    ) {
      throw new Error("Approval token binding is invalid");
    }
    if (this.#now().getTime() >= Date.parse(request.expiresAt)) {
      this.#store.expire(request.id);
      throw new Error("Approval request expired");
    }
    if (request.status === "completed") return structuredClone(request.result);
    if (request.status === "failed") throw new Error(request.error ?? "Approval execution failed");
    if (!this.#store.beginExecution(request.id)) {
      const current = this.#store.get(request.id);
      if (current?.status === "completed") return structuredClone(current.result);
      throw new Error("Approval action is already executing or unavailable");
    }
    try {
      const result = await this.#executor(request.action, request.idempotencyKey);
      this.#store.complete(request.id, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Approval execution failed";
      this.#store.fail(request.id, message);
      throw error;
    }
  }

  principalForToken(token: string): string {
    return this.#verify(token).principalId;
  }

  #sign(payload: TokenPayload): string {
    const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${encoded}.${this.#signature(encoded)}`;
  }

  #verify(token: string): TokenPayload {
    const [encoded, signature, extra] = token.split(".");
    if (encoded === undefined || signature === undefined || extra !== undefined) {
      throw new Error("Approval token is malformed");
    }
    const expected = this.#signature(encoded);
    const actualBuffer = Buffer.from(signature, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    if (
      actualBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
      throw new Error("Approval token signature is invalid");
    }
    try {
      return tokenPayloadSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown,
      );
    } catch {
      throw new Error("Approval token payload is invalid");
    }
  }

  #signature(encoded: string): string {
    return createHmac("sha256", this.#secret).update(encoded).digest("base64url");
  }
}

export class TrustedActionExecutor {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
  }

  async execute(action: ApprovalAction, idempotencyKey: string): Promise<unknown> {
    if (action.kind !== "write_file") throw new Error(`Unsupported approved action: ${action.kind}`);
    const target = resolve(this.#root, action.target);
    if (target !== this.#root && !target.startsWith(`${this.#root}\\`) && !target.startsWith(`${this.#root}/`)) {
      throw new Error("Approved action target is outside the trusted root");
    }
    if (
      typeof action.parameters !== "object" ||
      action.parameters === null ||
      !("content" in action.parameters) ||
      typeof action.parameters.content !== "string"
    ) {
      throw new Error("write_file action requires string content");
    }
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, action.parameters.content, "utf8");
    else if (readFileSync(target, "utf8") !== action.parameters.content) {
      throw new Error("Approved target already exists with different content");
    }
    return { written: true, path: target, idempotencyKey };
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
