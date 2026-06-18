import type { ApprovalRequest, MemoryEntry, RuntimeHealth } from "./types";

const API_BASE = import.meta.env.VITE_API_BASE_URL ?? "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...options?.headers },
    ...options,
  });

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<RuntimeHealth>("/health"),
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
