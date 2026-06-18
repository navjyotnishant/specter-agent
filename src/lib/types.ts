export type RuntimeHealth = {
  api: string;
  sqlite: string;
  journal_mode: string;
  db_path: string;
  scheduler: string;
  runtime: string;
};

export type AgentNodeConfig = {
  id: string;
  name: string;
  role: string;
  objective: string;
  systemInstructions: string;
  provider: string;
  model: string;
  skills: string[];
  tools: string[];
  memoryScope: "workflow" | "team" | "agent_private";
  maxIterations: number;
  requiresApproval: boolean;
  outputSchema: string;
  delegationStrategy?: "sequential_delegation" | "parallel_delegation_later" | "review_and_revise_later";
  aggregationStrategy?: string;
};

export type ApprovalRequest = {
  id: string;
  workflow_run_id: string;
  status: "pending" | "approved" | "rejected" | "revision_requested";
  title: string;
  reason: string;
  context_summary: string;
  requested_by_agent?: string;
  created_at: string;
};

export type MemoryEntry = {
  id: string;
  workflow_run_id: string;
  scope: "workflow" | "team" | "agent_private";
  key: string;
  value_text: string;
  sensitivity_label: string;
  created_by_agent?: string;
  created_at: string;
};
