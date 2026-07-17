import { z } from "zod";

const nonEmpty = z.string().trim().min(1);

const configSchema = z.object({
  MITISMINE_DB_PATH: nonEmpty.default("data/mitismine.db"),
  MITISMINE_DATA_DIR: nonEmpty.default("data"),
  MITISMINE_HTTP_HOST: nonEmpty.default("127.0.0.1"),
  MITISMINE_HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(4317),
  MITISMINE_APPROVAL_KEY: nonEmpty.default("development-only-approval-key-change-me"),
  FEISHU_HUB_APP_ID: nonEmpty,
  FEISHU_HUB_APP_SECRET: nonEmpty,
  FEISHU_CLAUDE_APP_ID: nonEmpty,
  FEISHU_CLAUDE_APP_SECRET: nonEmpty,
  FEISHU_CODEX_APP_ID: nonEmpty,
  FEISHU_CODEX_APP_SECRET: nonEmpty,
  FEISHU_COPILOT_APP_ID: nonEmpty,
  FEISHU_COPILOT_APP_SECRET: nonEmpty,
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: Record<string, string | undefined>): Config {
  return configSchema.parse(env);
}
