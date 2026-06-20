import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Clock,
  FolderOpen,
  History,
  Loader2,
  OctagonAlert,
  Play,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { WorkflowRun, Workflow, RuntimeWorkspace } from "@/lib/types";

// ── helpers ───────────────────────────────────────────────────────────────────
function parseUTC(s: string) {
  return new Date(s.endsWith("Z") || s.includes("+") ? s : s + "Z");
}
function fmtRelative(s: string) {
  const diff = Math.floor((Date.now() - parseUTC(s).getTime()) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return parseUTC(s).toLocaleDateString();
}
function fmtDuration(run: WorkflowRun) {
  if (!run.completed_at) return null;
  const s = Math.floor((parseUTC(run.completed_at).getTime() - parseUTC(run.created_at).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
function fmtTime(s: string) {
  return parseUTC(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── status config ─────────────────────────────────────────────────────────────
const STATUS: Record<string, { color: string; bg: string; border: string; label: string; dot: string }> = {
  queued:           { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", label: "Queued",    dot: "#9ca3af" },
  running:          { color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", label: "Running",   dot: "#2563eb" },
  completed:        { color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", label: "Done",      dot: "#059669" },
  failed:           { color: "#dc2626", bg: "#fef2f2", border: "#fecaca", label: "Failed",    dot: "#dc2626" },
  waiting_approval: { color: "#d97706", bg: "#fffbeb", border: "#fde68a", label: "Approval",  dot: "#d97706" },
  cancelled:        { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", label: "Cancelled", dot: "#9ca3af" },
};
function sc(s: string) { return STATUS[s] ?? STATUS.queued; }

function StatusBadge({ status }: { status: string }) {
  const s = sc(status);
  const Icon =
    status === "running"          ? Loader2 :
    status === "completed"        ? CheckCircle2 :
    status === "failed"           ? AlertTriangle :
    status === "waiting_approval" ? OctagonAlert :
    status === "cancelled"        ? XCircle :
    Clock;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 700, letterSpacing: "0.04em",
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      padding: "3px 9px", borderRadius: 6, whiteSpace: "nowrap",
    }}>
      <Icon style={{ width: 11, height: 11, flexShrink: 0, animation: status === "running" ? "spin 1s linear infinite" : "none" }} />
      {s.label}
    </span>
  );
}

// ── run modal ─────────────────────────────────────────────────────────────────
function RunModal({ token, onClose, onRun, isPending }: {
  token: string; onClose: () => void; isPending: boolean;
  onRun: (workflowId: string, workspacePath: string) => void;
}) {
  const workflowsQuery = useQuery({ queryKey: ["workflows"], queryFn: () => api.workflows(token) });
  const workspacesQuery = useQuery({ queryKey: ["workspaces"], queryFn: () => api.runtimeWorkspaces(token) });
  const workflows: Workflow[] = workflowsQuery.data ?? [];
  const workspaces: RuntimeWorkspace[] = workspacesQuery.data ?? [];

  const [selWf, setSelWf] = useState("");
  const [selWs, setSelWs] = useState("");

  const effectiveWf = selWf || workflows[0]?.id || "";
  const effectiveWs = selWs || workspaces.find((w) => w.is_active)?.path || workspaces[0]?.path || "";
  const canRun = !!effectiveWf && !!effectiveWs && !isPending;

  const SEL: React.CSSProperties = {
    width: "100%", padding: "8px 10px", borderRadius: 7,
    border: "1px solid #e2e8f0", fontSize: 13, color: "#0f172a",
    background: "white", outline: "none",
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,23,42,0.3)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "white", borderRadius: 14, padding: 24, width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            <p style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", margin: 0 }}>Run workflow</p>
            <p style={{ fontSize: 12, color: "#94a3b8", margin: "2px 0 0" }}>Pick a workflow and workspace to execute</p>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 7, padding: 7, cursor: "pointer", display: "flex" }}>
            <X style={{ width: 13, height: 13, color: "#64748b" }} />
          </button>
        </div>

        <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>Workflow</label>
        {workflowsQuery.isLoading
          ? <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 14 }}>Loading…</p>
          : <select style={{ ...SEL, marginBottom: 14 }} value={effectiveWf} onChange={(e) => setSelWf(e.target.value)}>
              {workflows.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
        }

        <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>
          <FolderOpen style={{ width: 10, height: 10, display: "inline", marginRight: 3 }} />Workspace
        </label>
        {workspacesQuery.isLoading
          ? <p style={{ fontSize: 12, color: "#94a3b8", marginBottom: 18 }}>Loading…</p>
          : workspaces.length > 0
          ? <select style={{ ...SEL, marginBottom: 18 }} value={effectiveWs} onChange={(e) => setSelWs(e.target.value)}>
              {workspaces.map((w) => <option key={w.id} value={w.path}>{w.name} — {w.path}</option>)}
            </select>
          : <p style={{ fontSize: 12, color: "#dc2626", padding: "8px 10px", background: "#fef2f2", borderRadius: 7, border: "1px solid #fecaca", marginBottom: 18 }}>No workspaces configured.</p>
        }

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 600, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", color: "#374151" }}>
            Cancel
          </button>
          <button disabled={!canRun} onClick={() => onRun(effectiveWf, effectiveWs)} style={{
            flex: 2, padding: "9px 0", fontSize: 13, fontWeight: 700,
            background: canRun ? "#4f46e5" : "#e2e8f0", color: canRun ? "white" : "#94a3b8",
            border: "none", borderRadius: 8, cursor: canRun ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          }}>
            {isPending ? <Loader2 style={{ width: 13, height: 13, animation: "spin 1s linear infinite" }} /> : <Play style={{ width: 13, height: 13 }} />}
            Run now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── filter pill ───────────────────────────────────────────────────────────────
function FilterPill({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      padding: "5px 14px", borderRadius: 999, fontSize: 12, fontWeight: 600, border: "1px solid",
      borderColor: active ? "#4f46e5" : "#e2e8f0",
      background: active ? "#4f46e5" : "white",
      color: active ? "white" : "#64748b",
      cursor: "pointer", transition: "all 0.15s",
    }}>
      {label}
    </button>
  );
}

// ── run row ───────────────────────────────────────────────────────────────────
function RunRow({ run, workflowName, onClick }: { run: WorkflowRun; workflowName: string; onClick: () => void }) {
  const dur = fmtDuration(run);
  const isRunning = run.status === "running";

  return (
    <tr
      onClick={onClick}
      style={{ cursor: "pointer", borderBottom: "1px solid #f1f5f9", transition: "background 0.1s" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      {/* run id */}
      <td style={{ padding: "11px 16px", whiteSpace: "nowrap" }}>
        <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, fontWeight: 700, color: "#4f46e5" }}>
          {run.id.slice(0, 8)}
        </span>
      </td>

      {/* workflow */}
      <td style={{ padding: "11px 8px", maxWidth: 200 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#0f172a" }}>{workflowName}</span>
        <br />
        <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>{run.workflow_id}</span>
      </td>

      {/* status */}
      <td style={{ padding: "11px 8px", whiteSpace: "nowrap" }}>
        <StatusBadge status={run.status} />
      </td>

      {/* started */}
      <td style={{ padding: "11px 8px", whiteSpace: "nowrap" }}>
        <span style={{ fontSize: 12, color: "#374151" }}>{fmtTime(run.created_at)}</span>
        <br />
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{fmtRelative(run.created_at)}</span>
      </td>

      {/* duration */}
      <td style={{ padding: "11px 8px", whiteSpace: "nowrap" }}>
        {dur
          ? <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, color: "#374151" }}>{dur}</span>
          : isRunning
          ? <span style={{ fontSize: 12, color: "#2563eb", fontWeight: 600, animation: "pulse 1.5s infinite" }}>Live</span>
          : <span style={{ fontSize: 12, color: "#d1d5db" }}>—</span>
        }
      </td>

      {/* trigger */}
      <td style={{ padding: "11px 8px" }}>
        <span style={{ fontSize: 11, color: "#94a3b8", textTransform: "capitalize" }}>{run.trigger_type}</span>
      </td>

      {/* chevron */}
      <td style={{ padding: "11px 16px 11px 0", textAlign: "right" }}>
        <ChevronRight style={{ width: 14, height: 14, color: "#d1d5db" }} />
      </td>
    </tr>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────
export default function Runs() {
  const token = getStoredToken() ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<"all" | "running" | "completed" | "failed">("all");
  const [showModal, setShowModal] = useState(false);

  const runsQuery = useQuery({
    queryKey: ["all-runs"],
    queryFn: () => api.listRuns(token),
    refetchInterval: 5000,
  });
  const workflowsQuery = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows(token),
  });

  const runMutation = useMutation({
    mutationFn: ({ workflowId, workspacePath }: { workflowId: string; workspacePath: string }) =>
      api.startRun(token, { workflow_id: workflowId, workspace_path: workspacePath }),
    onSuccess: (data) => {
      setShowModal(false);
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      navigate(`/workflows/${data.workflow_id}/run/${data.run_id}`);
    },
  });

  const runs = runsQuery.data ?? [];
  const workflowMap: Record<string, string> = {};
  for (const w of workflowsQuery.data ?? []) workflowMap[w.id] = w.name;

  const counts = {
    all: runs.length,
    running: runs.filter((r) => ["running", "waiting_approval", "queued"].includes(r.status)).length,
    completed: runs.filter((r) => r.status === "completed").length,
    failed: runs.filter((r) => r.status === "failed").length,
  };
  const filtered = filter === "all" ? runs
    : filter === "running" ? runs.filter((r) => ["running", "waiting_approval", "queued"].includes(r.status))
    : runs.filter((r) => r.status === filter);

  return (
    <div className="space-y-5">

      {/* ── header card ── */}
      <Card className="overflow-hidden rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-7">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-100">
                <History className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-black tracking-tight text-slate-950">Workflow runs</h2>
                  <Badge className="rounded-full bg-indigo-100 px-3 py-1 text-indigo-800 hover:bg-indigo-100 text-xs">
                    MVP workspace
                  </Badge>
                </div>
                <p className="mt-0.5 text-sm text-slate-500">
                  Live execution history with agent logs, approvals, and memory events.
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowModal(true)}
              disabled={runMutation.isPending}
              style={{
                display: "flex", alignItems: "center", gap: 7,
                padding: "9px 20px", borderRadius: 999,
                background: "#4f46e5", color: "white", border: "none",
                cursor: "pointer", fontSize: 13, fontWeight: 700,
                boxShadow: "0 2px 10px #4f46e530", whiteSpace: "nowrap",
                opacity: runMutation.isPending ? 0.7 : 1,
              }}
            >
              {runMutation.isPending
                ? <Loader2 style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} />
                : <Play style={{ width: 14, height: 14 }} />}
              Run workflow
            </button>
          </div>

          {/* filter pills */}
          <div className="mt-5 flex items-center gap-2">
            <FilterPill label={`All (${counts.all})`}        active={filter === "all"}       onClick={() => setFilter("all")} />
            <FilterPill label={`Active (${counts.running})`} active={filter === "running"}   onClick={() => setFilter("running")} />
            <FilterPill label={`Done (${counts.completed})`} active={filter === "completed"} onClick={() => setFilter("completed")} />
            <FilterPill label={`Failed (${counts.failed})`}  active={filter === "failed"}    onClick={() => setFilter("failed")} />
            {runMutation.isError && (
              <span style={{ fontSize: 12, color: "#dc2626", marginLeft: 8 }}>Failed to start — check workspace.</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── runs table ── */}
      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white shadow-sm">
        {runsQuery.isLoading && (
          <div className="flex items-center justify-center gap-3 py-16 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading runs…</span>
          </div>
        )}

        {!runsQuery.isLoading && filtered.length === 0 && (
          <div className="p-12 text-center">
            <div className="mb-3 h-1.5 w-12 rounded-full bg-cyan-300 mx-auto" />
            <p className="font-bold text-slate-800">No runs yet</p>
            <p className="mt-1 text-sm text-slate-500">Click <strong>Run workflow</strong> above to start the first execution.</p>
          </div>
        )}

        {filtered.length > 0 && (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #f1f5f9", background: "#fafafa" }}>
                  {["Run ID", "Workflow", "Status", "Started", "Duration", "Trigger", ""].map((h) => (
                    <th key={h} style={{
                      padding: h === "Run ID" ? "9px 16px" : h === "" ? "9px 16px 9px 0" : "9px 8px",
                      fontSize: 10, fontWeight: 700, color: "#94a3b8",
                      textTransform: "uppercase", letterSpacing: "0.08em",
                      textAlign: h === "" ? "right" : "left", whiteSpace: "nowrap",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    workflowName={workflowMap[run.workflow_id] ?? run.workflow_id}
                    onClick={() => navigate(`/workflows/${run.workflow_id}/run/${run.id}`)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {showModal && (
        <RunModal
          token={token}
          onClose={() => setShowModal(false)}
          isPending={runMutation.isPending}
          onRun={(workflowId, workspacePath) => runMutation.mutate({ workflowId, workspacePath })}
        />
      )}

      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
      `}</style>
    </div>
  );
}
