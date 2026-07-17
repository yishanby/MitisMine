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
