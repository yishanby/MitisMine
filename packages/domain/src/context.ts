export interface ContextEvent {
  readonly seq: number;
  readonly type: string;
  readonly text: string;
  readonly relevance: number;
  readonly pinned: boolean;
}

export interface ContextEvidence {
  readonly id: string;
  readonly url: string;
  readonly quote: string;
}

export interface ContextPackInput {
  readonly maxChars: number;
  readonly summary: string;
  readonly events: readonly ContextEvent[];
  readonly evidence: readonly ContextEvidence[];
  readonly watermark: number;
}

export interface ContextPack {
  readonly watermark: number;
  readonly summary: string;
  readonly events: readonly ContextEvent[];
  readonly evidence: readonly ContextEvidence[];
  readonly serialized: string;
}

export function compileContext(input: ContextPackInput): ContextPack {
  if (!Number.isInteger(input.maxChars) || input.maxChars < 256) {
    throw new Error("Context maxChars must be an integer of at least 256");
  }

  const evidence = input.evidence.map((item) => ({ ...item }));
  let summary = input.summary;
  let base = serialize(input.watermark, summary, evidence, []);
  if (base.length > input.maxChars) {
    summary = truncate(summary, 1_000);
    for (const item of evidence) {
      item.quote = truncate(item.quote, 512);
    }
    base = serialize(input.watermark, summary, evidence, []);
  }
  if (base.length > input.maxChars) {
    summary = truncate(summary, 256);
    for (const item of evidence) {
      item.quote = "";
    }
    base = serialize(input.watermark, summary, evidence, []);
  }
  if (base.length > input.maxChars) {
    throw new Error("Context limit is too small for required evidence identifiers");
  }

  const ordered = [...input.events].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.relevance - left.relevance ||
      right.seq - left.seq,
  );
  const selected: ContextEvent[] = [];
  let serialized = base;
  for (const event of ordered) {
    const candidate = [...selected, event];
    const candidateSerialized = serialize(input.watermark, summary, evidence, candidate);
    if (candidateSerialized.length <= input.maxChars) {
      selected.push(event);
      serialized = candidateSerialized;
    }
  }

  return {
    watermark: input.watermark,
    summary,
    events: selected,
    evidence,
    serialized,
  };
}

function serialize(
  watermark: number,
  summary: string,
  evidence: readonly ContextEvidence[],
  events: readonly ContextEvent[],
): string {
  return JSON.stringify({ watermark, summary, evidence, events });
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}
