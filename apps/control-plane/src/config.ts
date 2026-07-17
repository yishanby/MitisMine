import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { APP_ROLES } from "../../../packages/feishu/src/registry.js";

const nonEmpty = z.string().trim().min(1);
const knownApprovalKeyDefaults = new Set([
  "development-only-approval-key-change-me",
  "<generate-a-random-32-byte-secret>",
]);
const approvalKey = z.string()
  .trim()
  .min(32, "MITISMINE_APPROVAL_KEY must contain at least 32 characters")
  .refine(
    (value) => !knownApprovalKeyDefaults.has(value)
      && !/[<>]/.test(value)
      && !/(?:example|placeholder|template)/i.test(value),
    "MITISMINE_APPROVAL_KEY must not be an example, placeholder, or template value",
  );
const identityObservationValue = nonEmpty.refine(
  (value) => !/[<>]/.test(value)
    && !/(?:example|placeholder|template|observed|change-me)/i.test(value),
  "Identity observation must be a real value captured from a Feishu App event",
);
const identityObservationSchema = z.object({
  appRole: z.enum(APP_ROLES),
  tenantKey: identityObservationValue,
  userId: identityObservationValue.optional(),
  unionId: identityObservationValue.optional(),
}).strict().superRefine((observation, context) => {
  if ((observation.userId === undefined) === (observation.unionId === undefined)) {
    context.addIssue({
      code: "custom",
      message: "Identity observation requires exactly one of userId or unionId",
    });
  }
}).transform((observation) => observation.userId === undefined
  ? {
      appRole: observation.appRole,
      tenantKey: observation.tenantKey,
      unionId: observation.unionId as string,
    }
  : {
      appRole: observation.appRole,
      tenantKey: observation.tenantKey,
      userId: observation.userId,
    }
);
const identityProbesDocumentSchema = z.object({
  observations: z.array(identityObservationSchema),
}).strict().superRefine(({ observations }, context) => {
  if (
    observations.length !== APP_ROLES.length
    || new Set(observations.map(({ appRole }) => appRole)).size !== APP_ROLES.length
    || APP_ROLES.some((role) => !observations.some(({ appRole }) => appRole === role))
  ) {
    context.addIssue({
      code: "custom",
      path: ["observations"],
      message: "Identity observations must contain all four App roles exactly once",
    });
  }
});
const identityProbesJson = nonEmpty.transform((value, context): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    context.addIssue({
      code: "custom",
      message: "MITISMINE_IDENTITY_PROBES_JSON must be valid JSON",
    });
    return z.NEVER;
  }
}).pipe(identityProbesDocumentSchema);
const defaultAgentWorkspaceRoot = resolve(homedir(), ".mitismine", "agent-workspaces");

const configSchema = z.object({
  MITISMINE_DB_PATH: nonEmpty.default("data/mitismine.db"),
  MITISMINE_DATA_DIR: nonEmpty.default("data"),
  MITISMINE_AGENT_WORKSPACE_ROOT: nonEmpty.default(defaultAgentWorkspaceRoot).transform(
    (value) => resolve(value),
  ),
  MITISMINE_HTTP_HOST: nonEmpty.default("127.0.0.1"),
  MITISMINE_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  MITISMINE_APPROVAL_KEY: approvalKey,
  MITISMINE_IDENTITY_PROBES_JSON: identityProbesJson,
  FEISHU_HUB_APP_ID: nonEmpty,
  FEISHU_HUB_APP_SECRET: nonEmpty,
  FEISHU_CLAUDE_APP_ID: nonEmpty,
  FEISHU_CLAUDE_APP_SECRET: nonEmpty,
  FEISHU_CODEX_APP_ID: nonEmpty,
  FEISHU_CODEX_APP_SECRET: nonEmpty,
  FEISHU_COPILOT_APP_ID: nonEmpty,
  FEISHU_COPILOT_APP_SECRET: nonEmpty,
}).superRefine((config, context) => {
  const appIds = [
    config.FEISHU_HUB_APP_ID,
    config.FEISHU_CLAUDE_APP_ID,
    config.FEISHU_CODEX_APP_ID,
    config.FEISHU_COPILOT_APP_ID,
  ];
  if (new Set(appIds).size !== appIds.length) {
    context.addIssue({
      code: "custom",
      path: ["FEISHU_HUB_APP_ID"],
      message: "Feishu App IDs must be unique",
    });
  }
  const pathFromRepository = relative(process.cwd(), config.MITISMINE_AGENT_WORKSPACE_ROOT);
  const isInsideRepository = pathFromRepository === "" || (
    !isAbsolute(pathFromRepository)
    && pathFromRepository !== ".."
    && !pathFromRepository.startsWith(`..${sep}`)
  );
  if (isInsideRepository) {
    context.addIssue({
      code: "custom",
      path: ["MITISMINE_AGENT_WORKSPACE_ROOT"],
      message: "Agent workspace root must be outside the repository",
    });
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env);
}
