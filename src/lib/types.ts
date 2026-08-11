export type RuntimeHealth = {
  api: string;
  sqlite: string;
  journal_mode: string;
  db_path: string;
  scheduler: string;
  runtime: string;
};

export type SystemMetricStatus = "healthy" | "warning" | "critical" | "unavailable" | string;

export type SystemHealth = {
  sampled_at: string;
  load: {
    status: SystemMetricStatus;
    load_1: number | null;
    load_5: number | null;
    load_15: number | null;
    cpu_count: number | null;
    pressure_percent: number | null;
    message: string;
  };
  memory: {
    status: SystemMetricStatus;
    total_bytes: number | null;
    used_bytes: number | null;
    available_bytes: number | null;
    used_percent: number | null;
    message: string;
  };
  disk: {
    status: SystemMetricStatus;
    path: string;
    total_bytes: number | null;
    used_bytes: number | null;
    free_bytes: number | null;
    used_percent: number | null;
    message: string;
  };
};

export type AuthUser = {
  id: string;
  email: string;
  role: "admin" | "operator";
  created_at: string;
  /** Stamped on each successful login. Null for an account that has not signed
   *  in since this was added — genuinely unknown rather than never. */
  last_seen_at?: string | null;
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
  agent_status?: Array<{
    key: string;
    display_name: string;
    installed: boolean;
    authenticated: boolean;
    version?: string | null;
    executable_path?: string | null;
    auth_note: string;
    /** The exact command that authenticates this agent, e.g. `sbx secret set -g
     *  openai`. The host runner has always produced this; it was absent from
     *  this type, so the UI showed the prose note instead of the command. */
    auth_command?: string | null;
    /** Set when the agent's provider is refusing calls for quota reasons. The
     *  host runner does not detect this yet — no 429 handling, no quota probe —
     *  so it is currently never populated. The UI renders the state when it
     *  appears rather than waiting for a second change. */
    rate_limited?: boolean | null;
    rate_limit_resets_at?: string | null;
    docs_url?: string;
  }>;
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

export type AgentModel = {
  slug: string;
  display_name: string;
  family: string;
  description?: string;
  efforts?: string[];
  default_effort?: string;
};

export type AgentModelSet = {
  agent: string;
  source: string;
  models: AgentModel[];
  count: number;
  error: string;
  families: string[];
  cached: boolean;
};

export type AgentModelsResult = {
  ok: boolean;
  agents: Record<string, AgentModelSet>;
  ttl_seconds?: number;
};

export type TelegramConfig = {
  ok: boolean;
  configured: boolean;
  bot_token_set: boolean;
  bot_token_hint: string;
  allowed_chat_ids: number[];
  backend_url: string;
  workspace_path: string;
  api_token_set: boolean;
  path: string;
  message?: string;
};

export type ParsedRef = {
  key: string;
  kind: "agent" | "skill";
};

export type ParsedSkill = {
  key: string;
  name: string;
  description: string;
  body: string;
  class?: string;
  subclass?: string;
  version?: string;
  author?: string;
  source_path: string;
  spawns: ParsedRef[];
  /** Whether the skill blocks on a human decision before acting. */
  approval?: { required: boolean; reason: string; signals: string[] };
  /** Execution order read out of the skill's prose. */
  pipeline?: {
    /** Ordered agent keys: a runs, then b, then c. */
    chains: string[][];
    /** The skill describes running branches in parallel. */
    parallel: boolean;
    /** Those parallel branches reconverge (converge / aggregate). */
    fan_in: boolean;
    /** Agents that must run last (publish, post, promote). */
    terminal?: string[];
    sequential_keys: string[];
  };
  error?: string;
};

export type ParsedAgent = {
  key: string;
  name: string;
  description: string;
  body: string;
  color?: string;
  author?: string;
  source_path: string;
  spawned_by: string[];
  error?: string;
};

export type CompatCheck = {
  id: string;
  level: "error" | "warn" | "info";
  ok: boolean;
  message: string;
  files: string[];
};

export type RepositoryCompat = {
  score: number;
  verdict: "compatible" | "partial" | "incompatible";
  shape: string;
  shape_confidence: string;
  counts: {
    skills: number;
    agents: number;
    refs: number;
    orphan_agents: number;
    dangling_refs: number;
    leaf_skills: number;
    importable: number;
    excluded: number;
  };
  checks: CompatCheck[];
};

export type ParsedRepository = {
  ok: boolean;
  shape: string;
  repo?: { name: string; path: string; remote_url?: string | null };
  skills?: ParsedSkill[];
  agents?: ParsedAgent[];
  warnings?: string[];
  compat?: RepositoryCompat;
  message?: string;
};

export type ClonedRepository = {
  ok: boolean;
  path?: string;
  /** Repo root, when `path` was scoped to a subdirectory from a /tree/ URL. */
  repo_root?: string;
  /** Subdirectory the scan was scoped to, or "" for the whole repo. */
  subpath?: string;
  name?: string;
  repo_url?: string;
  action?: string;
  message?: string;
};

export type Skill = {
  id: string;
  name: string;
  description: string;
  prompt_template: string;
  compatible_agent_roles: string;
  source_repo?: string;
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

export type RunStats = {
  window_hours: number;
  total: number;
  failed: number;
  completed: number;
  active: number;
  waiting_approval: number;
  /** Oldest run still in flight, so "3 running" can say whether one is stuck. */
  oldest_active_started_at: string | null;
  median_duration_seconds: number;
  previous_median_duration_seconds: number;
  /** Null when there is no prior window to compare against — distinct from a
   *  delta of zero, which would claim durations are unchanged. */
  median_delta_seconds: number | null;
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
  workspace_path?: string;
  graph: WorkflowGraph;
  is_template: boolean;
  created_at: string;
  updated_at: string;
};

export type AgentNodeConfig = {
  id: string;
  label: string;
  role: string;
  objective: string;
  systemInstructions: string;
  model: string;
  selectedSkills: string[];
  selectedTools: string[];
  memoryScope: "workflow" | "team" | "agent_private";
  maxIterations: number;
  delegationStrategy?: "sequential_delegation" | "parallel_delegation" | "review_and_revise_later";
  runtime?: "sandbox" | "direct";
  sandboxAgent?: string;
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
  expires_at?: string | null;
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

/** What stands between an agent and the machine. Mirrors internal/isolation. */
export type WardenLayer = {
  name: string;
  held: boolean;
  detail: string;
  /** What is still exposed when a layer does not hold. */
  gap?: string;
};

export type WardenStatus = {
  active: boolean;
  mechanism: string;
  reason?: string;
  layers: WardenLayer[];
};
