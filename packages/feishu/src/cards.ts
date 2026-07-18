export interface FeishuCard {
  readonly schema: "2.0";
  readonly config: { readonly update_multi: boolean };
  readonly header: { readonly title: { readonly tag: "plain_text"; readonly content: string } };
  readonly body: { readonly elements: readonly unknown[] };
}

export function textCard(title: string, content: string): FeishuCard {
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: { tag: "plain_text", content: title } },
    body: { elements: [{ tag: "markdown", content }] },
  };
}

export function approvalCard(input: {
  readonly title: string;
  readonly preview: string;
  readonly risk: string;
  readonly token: string;
}): FeishuCard {
  return {
    ...textCard(input.title, `${input.preview}\n\n风险：${input.risk}`),
    body: {
      elements: [
        { tag: "markdown", content: `${input.preview}\n\n风险：${input.risk}` },
        {
          tag: "button",
          text: { tag: "plain_text", content: "批准" },
          type: "primary",
          value: { action: "approve", token: input.token },
          behaviors: [{ type: "callback", value: { action: "approve", token: input.token } }],
        },
        {
          tag: "button",
          text: { tag: "plain_text", content: "拒绝" },
          type: "default",
          value: { action: "reject", token: input.token },
          behaviors: [{ type: "callback", value: { action: "reject", token: input.token } }],
        },
      ],
    },
  };
}

export interface DiscussionCardView {
  readonly discussionId: string;
  readonly topicTitle: string;
  readonly question: string;
  readonly state: "active" | "paused" | "summarizing" | "completed" | "stopped" | "failed";
  readonly round: number;
  readonly maxRounds: number;
  readonly currentProvider?: "claude" | "codex" | "copilot";
  readonly pendingSteers: number;
  readonly openQuestion?: string;
  readonly version: number;
}

export function discussionCard(view: DiscussionCardView): FeishuCard {
  const provider = view.currentProvider === undefined
    ? "等待调度"
    : providerLabel(view.currentProvider);
  const content = [
    `**Topic**：${view.topicTitle}`,
    `**问题**：${view.question}`,
    `**状态**：${discussionStateLabel(view.state)}`,
    `**当前/下一位**：${provider}`,
    `**轮次**：${view.round} / ${view.maxRounds}`,
    `**待处理 steer**：${view.pendingSteers}`,
    ...(view.openQuestion === undefined ? [] : [`**未解决问题**：${view.openQuestion}`]),
  ].join("\n");
  const controls = discussionControls(view);
  return {
    ...textCard(`自动讨论 · ${discussionStateLabel(view.state)}`, content),
    body: {
      elements: [
        { tag: "markdown", content },
        ...controls,
      ],
    },
  };
}

function discussionControls(view: DiscussionCardView): unknown[] {
  if (["completed", "stopped", "failed"].includes(view.state)) return [];
  const controls: unknown[] = [];
  if (view.state === "active") {
    controls.push(discussionButton("暂停", "discussion.pause", view));
  } else if (view.state === "paused") {
    controls.push(discussionButton("继续", "discussion.resume", view));
  }
  if (view.state === "active" || view.state === "paused") {
    controls.push(discussionButton("立即总结", "discussion.summarize", view));
  }
  controls.push(discussionButton("停止", "discussion.stop", view));
  return controls;
}

function discussionButton(
  text: string,
  action: "discussion.pause" | "discussion.resume" | "discussion.summarize" | "discussion.stop",
  view: DiscussionCardView,
): unknown {
  const value = { action, discussionId: view.discussionId, version: view.version };
  return {
    tag: "button",
    text: { tag: "plain_text", content: text },
    type: action === "discussion.stop" ? "danger" : "default",
    value,
    behaviors: [{ type: "callback", value }],
  };
}

function providerLabel(provider: "claude" | "codex" | "copilot"): string {
  return provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "Copilot";
}

function discussionStateLabel(state: DiscussionCardView["state"]): string {
  const labels: Record<DiscussionCardView["state"], string> = {
    active: "讨论中",
    paused: "已暂停",
    summarizing: "总结中",
    completed: "已完成",
    stopped: "已停止",
    failed: "失败",
  };
  return labels[state];
}
