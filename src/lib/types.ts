export type RuntimeHealth = {
  api: string;
  sqlite: string;
  journal_mode: string;
  db_path: string;
  scheduler: string;
  runtime: string;
};

export type AuthUser = {
  id: string;
  email: string;
  role: "admin" | "operator";
  created_at: string;
};

export type ModelProvider = {
  id: string;
  name: string;
  provider_type: "ollama" | "openai-compatible" | "anthropic-compatible" | string;
  base_url?: string | null;
  is_configured: number | boolean;
  created_at: string;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
  prompt_template: string;
  compatible_agent_roles: string;
  created_at: string;
};

export type Connector = {
  id: string;
  name: string;
  connector_type: "local-codebase" | "mcp" | "github" | "jira" | "command-runner" | string;
  config_json: string;
  is_configured: number | boolean;
  created_at: string;
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
