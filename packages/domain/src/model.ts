export type TopicStatus = "active" | "archived";
export type TopicMemberRole = "editor" | "viewer";

export interface Topic {
  readonly id: string;
  readonly tenantKey: string;
  readonly title: string;
  readonly ownerPrincipalId: string;
  readonly status: TopicStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastEventSeq: number;
}

export interface TopicMember {
  readonly principalId: string;
  readonly role: TopicMemberRole;
}

export interface FeishuIdentity {
  readonly tenantKey: string;
  readonly userId?: string;
  readonly unionId?: string;
}
