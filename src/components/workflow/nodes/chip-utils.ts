// Shared display helpers for workflow node cards.

const AGENT_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude",
  cursor: "Cursor",
};

// "Codex · auto", "Claude · haiku" — from the node's configured agent + model.
export function agentModelChip(data: Record<string, unknown>): string {
  const agentKey = String(data.sandboxAgent ?? "codex");
  const agent = AGENT_NAMES[agentKey] ?? agentKey;
  const model = String(data.model ?? "").trim() || "auto";
  return `${agent} · ${model}`;
}
