export type FeishuCommand =
  | { readonly kind: "topic.new"; readonly title: string }
  | { readonly kind: "topic.list" }
  | { readonly kind: "topic.use"; readonly topicPrefix: string }
  | { readonly kind: "topic.show" }
  | { readonly kind: "topic.share"; readonly principalId: string; readonly role: "editor" | "viewer" }
  | { readonly kind: "topic.archive" }
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "research"; readonly question: string }
  | { readonly kind: "status" }
  | { readonly kind: "stop" }
  | { readonly kind: "report" }
  | { readonly kind: "action.write"; readonly path: string; readonly content: string }
  | { readonly kind: "message"; readonly text: string };

export function parseCommand(input: string): FeishuCommand {
  const text = input.trim();
  let match = /^\/topic\s+new\s+(.+)$/i.exec(text);
  if (match) return { kind: "topic.new", title: required(match[1], "Topic title") };
  if (/^\/topic\s+list$/i.test(text)) return { kind: "topic.list" };
  match = /^\/topic\s+use\s+(\S+)$/i.exec(text);
  if (match) return { kind: "topic.use", topicPrefix: required(match[1], "Topic ID") };
  if (/^\/topic\s+show$/i.test(text)) return { kind: "topic.show" };
  match = /^\/topic\s+share\s+(\S+)\s+(editor|viewer)$/i.exec(text);
  if (match) {
    return {
      kind: "topic.share",
      principalId: required(match[1], "principal"),
      role: required(match[2], "role").toLowerCase() as "editor" | "viewer",
    };
  }
  if (/^\/topic\s+archive$/i.test(text)) return { kind: "topic.archive" };
  match = /^\/note\s+(.+)$/is.exec(text);
  if (match) return { kind: "note", text: required(match[1], "note") };
  match = /^\/research\s+(.+)$/is.exec(text);
  if (match) return { kind: "research", question: required(match[1], "question") };
  if (/^\/status$/i.test(text)) return { kind: "status" };
  if (/^\/stop$/i.test(text)) return { kind: "stop" };
  if (/^\/report$/i.test(text)) return { kind: "report" };
  match = /^\/action\s+write\s+(\S+)\s+(.+)$/is.exec(text);
  if (match) {
    return {
      kind: "action.write",
      path: required(match[1], "write path"),
      content: required(match[2], "write content"),
    };
  }
  if (text.startsWith("/")) throw new Error(`Unknown command: ${text}`);
  return { kind: "message", text: required(text, "message") };
}

function required(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}
