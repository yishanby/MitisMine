import { resolvePrincipal } from "../../domain/src/topic.js";

export const APP_ROLES = ["hub", "claude", "codex", "copilot"] as const;
export type AppRole = (typeof APP_ROLES)[number];
export type ProviderAppRole = Exclude<AppRole, "hub">;

export interface AppRegistration {
  readonly role: AppRole;
  readonly appId: string;
  readonly appSecret: string;
}

export class FeishuAppRegistry {
  readonly #byRole: ReadonlyMap<AppRole, AppRegistration>;
  readonly #byAppId: ReadonlyMap<string, AppRole>;

  constructor(registrations: readonly AppRegistration[]) {
    if (registrations.length !== APP_ROLES.length) throw new Error("All four Feishu Apps are required");
    const byRole = new Map<AppRole, AppRegistration>();
    const byAppId = new Map<string, AppRole>();
    for (const registration of registrations) {
      if (!registration.appId || !registration.appSecret) throw new Error("Feishu credentials are required");
      if (byRole.has(registration.role)) throw new Error(`Duplicate Feishu App role: ${registration.role}`);
      if (byAppId.has(registration.appId)) throw new Error("Feishu App IDs must be unique");
      byRole.set(registration.role, registration);
      byAppId.set(registration.appId, registration.role);
    }
    for (const role of APP_ROLES) if (!byRole.has(role)) throw new Error(`Missing Feishu App role: ${role}`);
    this.#byRole = byRole;
    this.#byAppId = byAppId;
  }

  get(role: AppRole): AppRegistration {
    const registration = this.#byRole.get(role);
    if (registration === undefined) throw new Error(`Unknown Feishu App role: ${role}`);
    return registration;
  }

  roleForAppId(appId: string): AppRole | undefined {
    return this.#byAppId.get(appId);
  }
}

export function identityProbeRegistrationsFromEnv(
  env: Record<string, string | undefined>,
): AppRegistration[] {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required for identity bootstrap`);
    return value;
  };
  const registry = new FeishuAppRegistry([
    { role: "hub", appId: required("FEISHU_HUB_APP_ID"), appSecret: required("FEISHU_HUB_APP_SECRET") },
    { role: "claude", appId: required("FEISHU_CLAUDE_APP_ID"), appSecret: required("FEISHU_CLAUDE_APP_SECRET") },
    { role: "codex", appId: required("FEISHU_CODEX_APP_ID"), appSecret: required("FEISHU_CODEX_APP_SECRET") },
    { role: "copilot", appId: required("FEISHU_COPILOT_APP_ID"), appSecret: required("FEISHU_COPILOT_APP_SECRET") },
  ]);
  return APP_ROLES.map((role) => registry.get(role));
}

export interface IdentityProbe {
  readonly appRole: AppRole;
  readonly tenantKey: string;
  readonly userId?: string;
  readonly unionId?: string;
}

export interface IdentityProbeDocument {
  readonly observations: readonly IdentityProbe[];
}

export class IdentityProbeCollector {
  readonly #observations = new Map<AppRole, IdentityProbe>();

  observe(input: IdentityProbe): void {
    const observation: IdentityProbe = input.unionId === undefined
      ? {
          appRole: input.appRole,
          tenantKey: input.tenantKey,
          ...(input.userId === undefined ? {} : { userId: input.userId }),
        }
      : {
          appRole: input.appRole,
          tenantKey: input.tenantKey,
          unionId: input.unionId,
        };
    resolvePrincipal(observation);
    const previous = this.#observations.get(input.appRole);
    if (previous !== undefined) {
      if (JSON.stringify(previous) !== JSON.stringify(observation)) {
        throw new Error(`Identity probe changed for App role: ${input.appRole}`);
      }
      return;
    }
    this.#observations.set(input.appRole, observation);
  }

  get complete(): boolean {
    return APP_ROLES.every((role) => this.#observations.has(role));
  }

  get count(): number {
    return this.#observations.size;
  }

  document(): IdentityProbeDocument {
    if (!this.complete) throw new Error("Identity probe collection is incomplete");
    const observations = APP_ROLES.map((role) => this.#observations.get(role) as IdentityProbe);
    verifyCrossAppIdentity(observations);
    return { observations };
  }
}

export function verifyCrossAppIdentity(probes: readonly IdentityProbe[]): string {
  if (probes.length !== APP_ROLES.length || new Set(probes.map((probe) => probe.appRole)).size !== 4) {
    throw new Error("Identity verification requires all four App roles");
  }
  const principals = probes.map((probe) => resolvePrincipal(probe));
  if (new Set(principals).size !== 1) throw new Error("Cross-App identity mismatch");
  return principals[0] as string;
}
