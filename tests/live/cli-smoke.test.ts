import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAdapters } from "../../packages/agent-adapters/src/index.js";
import { runJsonl } from "../../packages/agent-protocol/src/runner.js";

const live = process.env.MITISMINE_LIVE_CLI === "1";

function finalText(events: readonly { readonly type: string; readonly [key: string]: unknown }[]): string {
  const final = [...events].reverse().find(
    (event) => event.type === "final" && typeof event.text === "string",
  );
  return final !== undefined && typeof final.text === "string" ? final.text : "";
}

describe.skipIf(!live)("installed CLI adapters", () => {
  const adapters = createAdapters(runJsonl);

  it.each(["claude", "codex", "copilot"] as const)(
    "%s starts and resumes a real session",
    async (provider) => {
      const cwd = mkdtempSync(join(tmpdir(), `mitismine-live-${provider}-`));
      const task = {
        topicId: `live-${provider}`,
        runId: `live-${provider}-${Date.now()}`,
        cwd,
        prompt: "Reply with exactly LIVE_OK and no other text. Do not use tools.",
        timeoutMs: 180_000,
      };
      try {
        const first = await adapters[provider].start(task);
        const second = await adapters[provider].resume({
          ...task,
          prompt: "Reply with exactly RESUME_OK and no other text. Do not use tools.",
          externalSessionId: first.externalSessionId,
        });

        expect(first.externalSessionId.length).toBeGreaterThan(8);
        expect(second.externalSessionId).toBe(first.externalSessionId);
        const firstText = finalText(first.events);
        const secondText = finalText(second.events);
        const shape = JSON.stringify(
          first.events.map((event) => ({
            type: event.type,
            code: event.code,
            message: event.message,
            keys: Object.keys(event),
            dataKeys:
              typeof event.data === "object" && event.data !== null
                ? Object.keys(event.data)
                : [],
          })),
        );
        expect(firstText, shape).toContain("LIVE_OK");
        expect(secondText).toContain("RESUME_OK");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
