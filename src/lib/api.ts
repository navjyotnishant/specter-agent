import type { ApprovalRequest, AuthUser, Connector, MemoryEntry, ModelProvider, RuntimeHealth, Skill } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

function authHeaders(token?: string): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<RuntimeHealth>("/health"),
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
  modelProviders: (token: string) => request<ModelProvider[]>("/model-providers", { headers: authHeaders(token) }),
  createModelProvider: (token: string, provider: { name: string; provider_type: string; base_url?: string; is_configured: boolean }) =>
    request<ModelProvider>("/model-providers", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(provider),
    }),
  deleteModelProvider: (token: string, id: string) =>
    request<{ deleted: boolean; provider_id: string }>(`/model-providers/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  skills: (token: string) => request<Skill[]>("/skills", { headers: authHeaders(token) }),
  createSkill: (token: string, skill: { name: string; description: string; prompt_template: string; compatible_agent_roles: string[] }) =>
    request<Skill>("/skills", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(skill),
    }),
  deleteSkill: (token: string, id: string) =>
    request<{ deleted: boolean; skill_id: string }>(`/skills/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  connectors: (token: string) => request<Connector[]>("/connectors", { headers: authHeaders(token) }),
  createConnector: (token: string, connector: { name: string; connector_type: string; config: Record<string, unknown>; is_configured: boolean }) =>
    request<Connector>("/connectors", {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(connector),
    }),
  deleteConnector: (token: string, id: string) =>
    request<{ deleted: boolean; connector_id: string }>(`/connectors/${id}`, { method: "DELETE", headers: authHeaders(token) }),
  approvals: () => request<ApprovalRequest[]>("/approvals"),
  runMemory: (runId: string) => request<MemoryEntry[]>(`/runs/${runId}/memory`),
  startSecurityReviewDemo: (objective: string) =>
    request<{ run_id: string; status: string }>("/runs/security-review-demo", {
      method: "POST",
      body: JSON.stringify({ workflow_id: "security-review-team", objective }),
    }),
  resolveApproval: (id: string, action: "approve" | "reject" | "request-revision", comment: string) =>
    request<ApprovalRequest>(`/approvals/${id}/${action}`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    }),
};
