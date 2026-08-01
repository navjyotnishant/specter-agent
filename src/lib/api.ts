import type {
  ApprovalRequest,
  AuthUser,
  Connector,
  DockerSandboxPolicy,
  HostRunnerLogs,
  HostRunnerMode,
  McpActionResult,
  McpListResult,
  MemoryEntry,
  ModelProvider,
  RepositoryDiscoveryResult,
  ParsedRepository,
  ClonedRepository,
  AgentModelsResult,
  TelegramConfig,
  RuntimeAdapterStatus,
  RuntimeHealth,
  RuntimeRun,
  RuntimeWorkspace,
  RunApproval,
  RunLog,
  RunMessage,
  RunStep,
  Skill,
  SystemHealth,
  Workflow,
  WorkflowGraph,
  WorkflowRun,
} from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });

  if (!response.ok) {
    const message = await response.text().then(formatErrorMessage).catch(() => "");
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function formatErrorMessage(message: string): string {
  if (!message) return "";

  try {
    const parsed = JSON.parse(message) as { detail?: unknown };
    if (typeof parsed.detail === "string") return parsed.detail;
    if (Array.isArray(parsed.detail)) {
      return parsed.detail
        .map((item) => {
          if (typeof item === "string") return item;
          if (item && typeof item === "object" && "msg" in item) return String(item.msg);
          return "";
        })
        .filter(Boolean)
        .join(" ");
    }
  } catch {
    return message;
  }

  return message;
}

export const api = {
  health: () => request<RuntimeHealth>("/health"),
  systemHealth: () => request<SystemHealth>("/health/system"),
  authStatus: () => request<{ needs_setup: boolean }>("/auth/status"),
  bootstrap: (email: string, password: string) =>
    request<{ user: AuthUser }>("/auth/bootstrap", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ user: AuthUser; token: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: (token: string) =>
    request<{ ok: boolean }>("/auth/logout", {
      method: "POST",
      headers: authHeaders(token),
    }),
  me: (token: string) => request<{ user: AuthUser }>("/auth/me", { headers: authHeaders(token) }),
  users: (token: string) => request<AuthUser[]>("/auth/users", { headers: authHeaders(token) }),
  createUser: (token: string, email: string, password: string, role: "admin" | "operator") =>
    request<AuthUser>("/auth/users", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ email, password, role }),
    }),
  deleteUser: (token: string, userId: string) =>
    request<{ deleted: boolean; user_id: string }>(`/auth/users/${userId}`, {
      method: "DELETE",
      headers: authHeaders(token),
    }),
  workflows: (token: string) => request<Workflow[]>("/workflows", { headers: authHeaders(token) }),
  workflow: (token: string, id: string) => request<Workflow>(`/workflows/${id}`, { headers: authHeaders(token) }),
  createWorkflow: (token: string, workflow: { name: string; description: string; graph: WorkflowGraph; workspace_path?: string }) =>
    request<Workflow>("/workflows", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(workflow),
    }),
  updateWorkflow: (token: string, id: string, workflow: { name: string; description: string; graph: WorkflowGraph; workspace_path?: string }) =>
    request<Workflow>(`/workflows/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify(workflow),
    }),
  deleteWorkflow: (token: string, id: string) =>
    request<{ deleted: boolean; workflow_id: string }>(`/workflows/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  planWorkflow: (token: string, payload: { objective: string; supervisor_node_id: string; runtime: string; agent: string; workspace_path: string; system_instructions?: string; current_plan?: Record<string, unknown> | null; feedback?: string }) =>
    request<WorkflowGraph>("/workflows/plan", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),
  tuneNode: (token: string, payload: { node_data: Record<string, unknown>; instruction: string; runtime: string; agent: string; workspace_path: string }) =>
    request<{ label: string; role: string; objective: string; systemInstructions: string }>("/workflows/plan/tune-node", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),
  publishTemplate: (token: string, id: string) =>
    request<Workflow>(`/workflows/${id}/publish-template`, { method: "PATCH", headers: authHeaders(token) }),
  unpublishTemplate: (token: string, id: string) =>
    request<Workflow>(`/workflows/${id}/unpublish-template`, { method: "PATCH", headers: authHeaders(token) }),
  modelProviders: (token: string) => request<ModelProvider[]>("/model-providers", { headers: authHeaders(token) }),
  createModelProvider: (token: string, provider: { name: string; provider_type: string; base_url?: string; is_configured: boolean }) =>
    request<ModelProvider>("/model-providers", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(provider),
    }),
  updateModelProvider: (token: string, id: string, provider: { name: string; provider_type: string; base_url?: string; is_configured: boolean }) =>
    request<ModelProvider>(`/model-providers/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify(provider),
    }),
  deleteModelProvider: (token: string, id: string) =>
    request<{ deleted: boolean; provider_id: string }>(`/model-providers/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  codexRuntimeStatus: (token: string) => request<RuntimeAdapterStatus>("/runtime-adapters/codex-cli/status", { headers: authHeaders(token) }),
  dockerSandboxRuntimeStatus: (token: string) => request<RuntimeAdapterStatus>("/runtime-adapters/docker-sandbox/status", { headers: authHeaders(token) }),
  directCliStatus: (token: string) => request<RuntimeAdapterStatus>("/runtime-adapters/direct-cli/status", { headers: authHeaders(token) }),
  startDockerSandboxDaemon: (token: string) =>
    request<{ ok: boolean; message: string }>("/runtime-adapters/docker-sandbox/daemon/start", { method: "POST", headers: authHeaders(token) }),
  dockerSandboxPolicy: (token: string) => request<DockerSandboxPolicy>("/runtime-adapters/docker-sandbox/policy", { headers: authHeaders(token) }),
  setDockerSandboxPolicy: (token: string, policy: "allow-all" | "balanced" | "deny-all") =>
    request<DockerSandboxPolicy>("/runtime-adapters/docker-sandbox/policy", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ policy }),
    }),
  hostRunnerMode: (token: string) => request<HostRunnerMode>("/runtime-adapters/host-runner/mode", { headers: authHeaders(token) }),
  setHostRunnerMode: (token: string, maintenance_enabled: boolean) =>
    request<HostRunnerMode>("/runtime-adapters/host-runner/mode", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ maintenance_enabled }),
    }),
  hostRunnerLogs: (token: string, since = 0, level?: string) =>
    request<HostRunnerLogs>(`/runtime-adapters/host-runner/logs?since=${since}${level ? `&level=${level}` : ""}`, { headers: authHeaders(token) }),
  runtimeWorkspaces: (token: string) => request<RuntimeWorkspace[]>("/runtime-adapters/workspaces", { headers: authHeaders(token) }),
  createRuntimeWorkspace: (token: string, workspace: { name: string; path: string }) =>
    request<RuntimeWorkspace>("/runtime-adapters/workspaces", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(workspace),
    }),
  deleteRuntimeWorkspace: (token: string, id: string) =>
    request<{ updated: boolean; workspace_id: string }>(`/runtime-adapters/workspaces/${id}`, {
      method: "DELETE",
      headers: authHeaders(token),
    }),
  discoverRepositories: (token: string, discovery: { root_path: string; max_depth: number; max_results: number }) =>
    request<RepositoryDiscoveryResult>("/runtime-adapters/repositories/discover", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(discovery),
    }),
  agentModels: (token: string, refresh = false) =>
    request<AgentModelsResult>(`/runtime-adapters/models${refresh ? "?refresh=true" : ""}`, {
      headers: authHeaders(token),
    }),
  telegramConfig: (token: string) =>
    request<TelegramConfig>("/runtime-adapters/telegram/config", { headers: authHeaders(token) }),
  deleteTelegramConfig: (token: string) =>
    request<{ ok: boolean; removed?: boolean; warning?: string }>("/runtime-adapters/telegram/config", {
      method: "DELETE",
      headers: authHeaders(token),
    }),
  saveTelegramConfig: (token: string, payload: { bot_token?: string; allowed_chat_ids: string[] }) =>
    request<TelegramConfig & { message?: string }>("/runtime-adapters/telegram/config", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),
  discoverTelegramChats: (token: string, bot_token: string) =>
    request<{ ok: boolean; chats?: { id: number; name: string }[]; message?: string }>(
      "/runtime-adapters/telegram/discover-chats",
      { method: "POST", headers: authHeaders(token), body: JSON.stringify({ bot_token, allowed_chat_ids: [] }) },
    ),
  parseRepository: (token: string, payload: { repo_path: string }) =>
    request<ParsedRepository>("/runtime-adapters/repositories/parse", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),
  cloneRepository: (token: string, payload: { repo_url: string }) =>
    request<ClonedRepository>("/runtime-adapters/repositories/clone", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(payload),
    }),
  codexRuntimeRuns: (token: string) => request<RuntimeRun[]>("/runtime-adapters/codex-cli/runs", { headers: authHeaders(token) }),
  createCodexRuntimeRun: (token: string, run: { workspace_id: string; prompt: string; mode: "read-only"; timeout_seconds: number; agent?: string; runtime?: "sandbox" | "direct" }) =>
    request<RuntimeRun>("/runtime-adapters/codex-cli/runs", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(run),
    }),
  installCodexRuntime: (token: string) =>
    request<{ ok: boolean; status: string; message?: string; manual_command?: string; runtime?: RuntimeAdapterStatus }>("/runtime-adapters/codex-cli/install", {
      method: "POST",
      headers: authHeaders(token),
    }),
  upgradeCodexRuntime: (token: string) =>
    request<{ ok: boolean; status: string; message?: string; manual_command?: string; runtime?: RuntimeAdapterStatus }>("/runtime-adapters/codex-cli/upgrade", {
      method: "POST",
      headers: authHeaders(token),
    }),
  hostRunnerVersion: (token: string) =>
    request<{ version: string }>("/runtime-adapters/host-runner/version", { headers: authHeaders(token) }),
  launchdStatus: (token: string) =>
    request<{ installed: boolean; running: boolean; plist_src: string; plist_dst: string; pid_line: string }>("/runtime-adapters/host-runner/launchd/status", {
      headers: authHeaders(token),
    }),
  launchdInstall: (token: string) =>
    request<{ ok: boolean; message: string }>("/runtime-adapters/host-runner/launchd/install", {
      method: "POST",
      headers: authHeaders(token),
    }),
  launchdUninstall: (token: string) =>
    request<{ ok: boolean; message: string }>("/runtime-adapters/host-runner/launchd/uninstall", {
      method: "POST",
      headers: authHeaders(token),
    }),
  launchdRestart: (token: string) =>
    request<{ ok: boolean; message: string }>("/runtime-adapters/host-runner/launchd/restart", {
      method: "POST",
      headers: authHeaders(token),
    }),
  skills: (token: string) => request<Skill[]>("/skills", { headers: authHeaders(token) }),
  createSkill: (
    token: string,
    skill: {
      name: string;
      description: string;
      prompt_template: string;
      compatible_agent_roles: string[];
      id?: string;
      upsert?: boolean;
      source_repo?: string;
    },
  ) =>
    request<Skill>("/skills", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(skill),
    }),
  updateSkill: (token: string, id: string, skill: { name: string; description: string; prompt_template: string; compatible_agent_roles: string[] }) =>
    request<Skill>(`/skills/${id}`, {
      method: "PATCH",
      headers: authHeaders(token),
      body: JSON.stringify(skill),
    }),
  deleteSkill: (token: string, id: string) =>
    request<{ deleted: boolean; skill_id: string }>(`/skills/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  startRun: (token: string, payload: { workflow_id: string; workspace_path: string; graph?: WorkflowGraph; run_input?: Record<string, string>; trigger_type?: string }) =>
    request<{ run_id: string; status: string; workflow_id: string }>("/workflow-runs", {
      method: "POST", headers: authHeaders(token), body: JSON.stringify(payload),
    }),
  listRuns: (token: string, workflow_id?: string) =>
    request<WorkflowRun[]>(`/workflow-runs${workflow_id ? `?workflow_id=${workflow_id}` : ""}`, { headers: authHeaders(token) }),
  getRun: (token: string, runId: string) =>
    request<WorkflowRun>(`/workflow-runs/${runId}`, { headers: authHeaders(token) }),
  getRunSteps: (token: string, runId: string) =>
    request<RunStep[]>(`/workflow-runs/${runId}/steps`, { headers: authHeaders(token) }),
  getRunLogs: (token: string, runId: string) =>
    request<RunLog[]>(`/workflow-runs/${runId}/logs`, { headers: authHeaders(token) }),
  getStepMessages: (token: string, runId: string, stepId: string) =>
    request<RunMessage[]>(`/workflow-runs/${runId}/steps/${stepId}/messages`, { headers: authHeaders(token) }),
  getRunApprovals: (token: string, runId: string) =>
    request<RunApproval[]>(`/workflow-runs/${runId}/approvals`, { headers: authHeaders(token) }),
  approveRun: (token: string, runId: string, approvalId: string, note?: string) =>
    request<{ approved: boolean }>(`/workflow-runs/${runId}/approve/${approvalId}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ note: note ?? "" }) }),
  rejectRun: (token: string, runId: string, approvalId: string, note?: string) =>
    request<{ rejected: boolean }>(`/workflow-runs/${runId}/reject/${approvalId}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ note: note ?? "" }) }),
  requestRevision: (token: string, runId: string, approvalId: string, note?: string) =>
    request<{ revision_requested: boolean }>(`/workflow-runs/${runId}/request-revision/${approvalId}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify({ note: note ?? "" }) }),
  cancelRun: (token: string, runId: string) =>
    request<{ cancelled: boolean }>(`/workflow-runs/${runId}/cancel`, { method: "POST", headers: authHeaders(token) }),
  mcpList: (token: string, client = "codex") => request<McpListResult>(`/runtime-adapters/mcp/list?client=${client}`, { headers: authHeaders(token) }),
  mcpAdd: (token: string, payload: { name: string; transport_type: string; url?: string; command?: string[]; env_vars?: Record<string, string> }, client = "codex") =>
    request<McpActionResult>(`/runtime-adapters/mcp/add?client=${client}`, { method: "POST", headers: authHeaders(token), body: JSON.stringify(payload) }),
  mcpRemove: (token: string, name: string, client = "codex") =>
    request<McpActionResult>(`/runtime-adapters/mcp/remove/${name}?client=${client}`, { method: "POST", headers: authHeaders(token) }),
  mcpLoginInstructions: (token: string, name: string, client = "codex") =>
    request<McpActionResult>(`/runtime-adapters/mcp/login/${name}?client=${client}`, { headers: authHeaders(token) }),
  connectors: (token: string) => request<Connector[]>("/connectors", { headers: authHeaders(token) }),
  createConnector: (token: string, connector: { name: string; connector_type: string; config: Record<string, unknown>; is_configured: boolean }) =>
    request<Connector>("/connectors", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(connector),
    }),
  deleteConnector: (token: string, id: string) =>
    request<{ deleted: boolean; connector_id: string }>(`/connectors/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  approvals: (token: string) => request<ApprovalRequest[]>("/approvals", { headers: authHeaders(token) }),
  runMemory: (runId: string) => request<MemoryEntry[]>(`/runs/${runId}/memory`),
  startSecurityReviewDemo: (objective: string) =>
    request<{ run_id: string; status: string }>("/runs/security-review-demo", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "security-review-team", objective }),
    }),
  resolveApproval: (token: string, id: string, action: "approve" | "reject" | "request-revision", comment: string) =>
    request<ApprovalRequest>(`/approvals/${id}/${action}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({ comment }),
    }),
};
