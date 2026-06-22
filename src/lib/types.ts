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

export type RuntimeAdapterStatus = {
  runtime_id: string;
  display_name: string;
  status: "ready" | "missing" | "host_runner_unavailable" | "install_disabled" | string;
  available: boolean;
  installed: boolean;
  executable_path?: string | null;
  version?: string | null;
  current_version?: string | null;
  detected_installs?: Array<{ path: string; version: string; parsed_version?: string | null }>;
  latest_version?: string | null;
  outdated?: boolean | null;
  version_check_status?: "ok" | "unavailable" | string;
  version_check_message?: string;
  install_supported?: boolean;
  install_enabled?: boolean;
  upgrade_supported?: boolean;
  upgrade_enabled?: boolean;
  sign_in_required?: boolean;
  sandbox_runtime_available?: boolean;
  sbx_installed?: boolean;
  sbx_version?: string | null;
  sandbox_health_status?: "cli_available" | "missing" | "daemon_unavailable" | "version_check_failed" | string;
  codex_sandbox_ready?: boolean;
  auth_required?: boolean | null;
  install_guidance?: {
    macos?: string;
    windows?: string;
    docs_url?: string;
    product_url?: string;
  };
  recommended_runtime?: string;
  base_image?: string;
  runner_mode?: "safe" | "maintenance" | string;
  host_runner_url?: string;
  message: string;
  diagnostic?: string;
};

export type HostRunnerMode = {
  mode: "safe" | "maintenance" | string;
  maintenance_enabled: boolean;
  install_enabled: boolean;
  upgrade_enabled: boolean;
  message: string;
};

export type DockerSandboxPolicy = {
  ok: boolean;
  status: string;
  current_policy?: "allow-all" | "balanced" | "deny-all" | "custom" | string | null;
  policy?: "allow-all" | "balanced" | "deny-all" | string;
  available_policies?: string[];
  message: string;
  diagnostic?: string;
  raw?: string;
};

export type HostRunnerLogEntry = {
  seq: number;
  timestamp: string;
  level: "debug" | "info" | "warn" | "error" | string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type HostRunnerLogs = {
  logs: HostRunnerLogEntry[];
  count: number;
  latest_seq: number;
  total: number;
};

export type RuntimeWorkspace = {
  id: string;
  name: string;
  path: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type RuntimeRun = {
  id: string;
  runtime_id: string;
  workspace_id: string;
  workspace_path: string;
  prompt: string;
  mode: string;
  status: string;
  exit_code?: number | null;
  stdout: string;
  stderr: string;
  summary: string;
  error?: string | null;
  started_at: string;
  completed_at?: string | null;
  metadata: Record<string, unknown>;
};

export type DiscoveredRepository = {
  name: string;
  path: string;
  remote_url?: string | null;
  detected_stack: string[];
};

export type RepositoryDiscoveryResult = {
  ok: boolean;
  root_path?: string;
  repositories: DiscoveredRepository[];
  count?: number;
  max_depth?: number;
  max_results?: number;
  message?: string;
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

export type WorkflowRun = {
  id: string;
  workflow_id: string;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled" | string;
  trigger_type: string;
  graph?: { nodes: unknown[]; edges: unknown[] };
  created_at: string;
  completed_at: string | null;
};

export type RunStep = {
  id: string;
  node_id: string;
  node_type: string;
  agent_name: string;
  agent_role: string;
  status: "running" | "completed" | "failed" | "waiting_approval" | string;
  summary: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
};

export type RunLog = {
  id: string;
  level: "info" | "warn" | "error" | string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type RunMessage = {
  id: string;
  agent_run_id: string;
  sender_type: string;
  sender_name: string;
  content: string;
  created_at: string;
};

export type RunApproval = {
  id: string;
  status: "pending" | "approved" | "rejected" | "revision_requested" | "expired" | string;
  title: string;
  reason: string;
  context_summary: string;
  workflow_step_run_id: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
};

export type McpServer = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  auth_type: "none" | "token" | "oauth" | "unknown";
  transport_type: "stdio" | "streamable_http" | "unknown";
  token_env_var?: string;
  token_label?: string;
  url?: string;
  add_command_url?: string;
  docs_url?: string;
  configured: boolean;
  enabled: boolean;
  auth_status: "o_auth" | "authenticated" | "unauthenticated" | "unsupported" | "unknown" | null;
  live?: {
    name: string;
    enabled: boolean;
    transport: Record<string, unknown>;
    auth_status: string;
  } | null;
};

export type McpListResult = {
  ok: boolean;
  servers: McpServer[];
  message?: string;
};

export type McpActionResult = {
  ok: boolean;
  name?: string;
  message: string;
  requires_terminal?: boolean;
  command?: string;
};

export type WorkflowGraph = {
  nodes: unknown[];
  edges: unknown[];
};

export type Workflow = {
  id: string;
  name: string;
  description: string;
  graph: WorkflowGraph;
  is_template: boolean;
  created_at: string;
  updated_at: string;
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
