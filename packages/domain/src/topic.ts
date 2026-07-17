import { ulid } from "ulid";

import type { FeishuIdentity, Topic, TopicMember } from "./model.js";

export function resolvePrincipal(identity: FeishuIdentity): string {
  const tenantKey = identity.tenantKey.trim();
  if (!tenantKey) {
    throw new Error("tenant key missing");
  }
  if (identity.userId?.trim()) {
    return `${tenantKey}:user:${identity.userId.trim()}`;
  }
  if (identity.unionId?.trim()) {
    return `${tenantKey}:union:${identity.unionId.trim()}`;
  }
  throw new Error("stable Feishu identity missing");
}

export function createTopic(
  title: string,
  ownerPrincipalId: string,
  options: { readonly id?: string; readonly now?: string } = {},
): Topic {
  const normalizedTitle = title.trim();
  if (!normalizedTitle) {
    throw new Error("Topic title is required");
  }
  if (normalizedTitle.length > 200) {
    throw new Error("Topic title must be 200 characters or fewer");
  }
  if (!ownerPrincipalId.trim()) {
    throw new Error("Topic owner is required");
  }

  const now = options.now ?? new Date().toISOString();
  const [tenantKey] = ownerPrincipalId.split(":", 1);
  if (!tenantKey) {
    throw new Error("Topic owner principal is invalid");
  }

  return {
    id: options.id ?? ulid(),
    tenantKey,
    title: normalizedTitle,
    ownerPrincipalId,
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastEventSeq: 0,
  };
}

export function canEditTopic(
  topic: Topic,
  principalId: string,
  members: readonly TopicMember[],
): boolean {
  if (principalId === topic.ownerPrincipalId) {
    return true;
  }
  return members.some(
    (member) => member.principalId === principalId && member.role === "editor",
  );
}

export function archiveTopic(
  topic: Topic,
  principalId: string,
  members: readonly TopicMember[],
  now = new Date().toISOString(),
): Topic {
  if (!canEditTopic(topic, principalId, members)) {
    throw new Error("principal is not allowed to archive this Topic");
  }
  if (topic.status !== "active") {
    throw new Error("only an active Topic can be archived");
  }
  return { ...topic, status: "archived", updatedAt: now };
}
