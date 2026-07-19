import { createClaudeAdapter } from "./claude.js";
import { createCodexAdapter } from "./codex.js";
import { createCopilotAdapter } from "./copilot.js";
import type { AgentAdapter, AgentRunner, ProviderName } from "./types.js";

export {
  assertValidProviderText,
  ProviderInvocationError,
  ProviderOutputUnicodeError,
} from "./types.js";

export type {
  AdapterResult,
  AgentAdapter,
  AgentRunner,
  AgentTask,
  ProviderName,
  ProviderErrorCode,
  ResumeAgentTask,
} from "./types.js";

export type AdapterRegistry = Readonly<Record<ProviderName, AgentAdapter>>;

export function createAdapters(runner: AgentRunner): AdapterRegistry {
  return {
    claude: createClaudeAdapter(runner),
    codex: createCodexAdapter(runner),
    copilot: createCopilotAdapter(runner),
  };
}
