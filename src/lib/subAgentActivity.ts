// Live sub-agent activity captured from subgraph stream events.
//
// With `streamSubgraphs: true`, useStream's `onUpdateEvent(data, { namespace })`
// fires for sub-agent (subgraph) node outputs. `namespace` looks like
// ["tools:<id>"]; `data` is `{ <nodeName>: { messages: [...] } }`. We turn those
// node outputs into a flat list of steps to render inside the sub-agent block.
//
// This data is LIVE-ONLY: it isn't persisted to thread state, so it's gone after
// a page reload (the block falls back to its INPUT/OUTPUT). Async sub-agents that
// run as separate deployed graphs aren't subgraphs of this run and won't appear.

export type SubAgentStep =
  | {
      kind: "tool_call";
      id: string;
      name: string;
      args: Record<string, unknown>;
    }
  | { kind: "tool_result"; toolCallId: string; name: string; text: string }
  | { kind: "text"; text: string };

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text?: unknown }).text ?? "")
          : ""
      )
      .join("");
  }
  return "";
}

/** Parse one subgraph update payload into renderable steps (empty nodes skipped). */
export function extractSubAgentSteps(data: unknown): SubAgentStep[] {
  const steps: SubAgentStep[] = [];
  if (!data || typeof data !== "object") return steps;
  for (const node of Object.values(data as Record<string, unknown>)) {
    const msgs = (node as { messages?: unknown })?.messages;
    if (!Array.isArray(msgs)) continue;
    for (const raw of msgs) {
      const m = raw as {
        type?: string;
        content?: unknown;
        name?: string;
        tool_call_id?: string;
        tool_calls?: { id?: string; name?: string; args?: unknown }[];
      };
      if (m.type === "ai" && m.tool_calls && m.tool_calls.length > 0) {
        for (const tc of m.tool_calls) {
          steps.push({
            kind: "tool_call",
            id: tc.id ?? "",
            name: tc.name ?? "tool",
            args:
              tc.args && typeof tc.args === "object"
                ? (tc.args as Record<string, unknown>)
                : {},
          });
        }
      } else if (m.type === "ai") {
        const text = extractText(m.content).trim();
        if (text) steps.push({ kind: "text", text });
      } else if (m.type === "tool") {
        steps.push({
          kind: "tool_result",
          toolCallId: m.tool_call_id ?? "",
          name: m.name ?? "tool",
          text: extractText(m.content).trim(),
        });
      }
    }
  }
  return steps;
}

/** The last assistant text a sub-agent produced — used to bind it to a task block. */
export function lastTextOf(steps: SubAgentStep[]): string {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.kind === "text") return s.text;
  }
  return "";
}
