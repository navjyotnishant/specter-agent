import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  Copy,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Loader2,
  OctagonAlert,
  Play,
  Plus,
  Trash2,
  Workflow as WorkflowIcon,
  X,
  XCircle,
} from "lucide-react";
import { ReactFlow, Background, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { SupervisorAgentNode } from "@/components/workflow/nodes/SupervisorAgentNode";
import { SpecialistAgentNode } from "@/components/workflow/nodes/SpecialistAgentNode";
import { HumanApprovalNode } from "@/components/workflow/nodes/HumanApprovalNode";
import { MemoryNode } from "@/components/workflow/nodes/MemoryNode";
import { ImportRepoDialog } from "@/components/workflow/ImportRepoDialog";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import { toast } from "@/hooks/use-toast";
import { buildImportGraph, type ImportSelection } from "@/lib/repo-import";
import type { ParsedRepository, Workflow, WorkflowRun, RuntimeWorkspace } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

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
function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ── status ────────────────────────────────────────────────────────────────────
const STATUS: Record<string, { color: string; bg: string; border: string; label: string }> = {
  queued:           { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", label: "Queued" },
  running:          { color: "#2563eb", bg: "#eff6ff", border: "#bfdbfe", label: "Running" },
  completed:        { color: "#059669", bg: "#ecfdf5", border: "#a7f3d0", label: "Done" },
  failed:           { color: "#dc2626", bg: "#fef2f2", border: "#fecaca", label: "Failed" },
  waiting_approval: { color: "#d97706", bg: "#fffbeb", border: "#fde68a", label: "Approval" },
  cancelled:        { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", label: "Cancelled" },
  revision_requested: { color: "#6b7280", bg: "#f9fafb", border: "#e5e7eb", label: "Revised" },
};
function sc(s: string) { return STATUS[s] ?? STATUS.queued; }

function StatusBadge({ status }: { status: string }) {
  const s = sc(status);
  const Icon =
    status === "running"          ? Loader2 :
    status === "completed"        ? CheckCircle2 :
    status === "failed"           ? AlertTriangle :
    status === "waiting_approval" ? OctagonAlert :
    status === "cancelled"        ? XCircle : Clock;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      fontSize: 10, fontWeight: 700, letterSpacing: "0.04em",
      color: s.color, background: s.bg, border: `1px solid ${s.border}`,
      padding: "2px 8px", borderRadius: 5, whiteSpace: "nowrap",
    }}>
      <Icon style={{ width: 10, height: 10, flexShrink: 0, animation: status === "running" ? "wf-spin 1s linear infinite" : "none" }} />
      {s.label}
    </span>
  );
}

// ── use-template modal (copy with required name) ──────────────────────────────
function UseTemplateModal({ workflow, token, onClose, onCreate }: {
  workflow: Workflow; token: string;
  onClose: () => void;
  onCreate: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(`${workflow.name} (copy)`);
  const [description, setDescription] = useState(workflow.description);
  const canSubmit = name.trim().length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,23,42,0.3)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "white", borderRadius: 14, padding: 24, width: 420, boxShadow: "0 20px 60px rgba(0,0,0,0.15)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 18 }}>
          <div>
            <p style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", margin: 0 }}>Use template</p>
            <p style={{ fontSize: 12, color: "#94a3b8", margin: "3px 0 0" }}>Creates a new editable workflow from <strong>{workflow.name}</strong></p>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 7, padding: 7, cursor: "pointer", display: "flex" }}>
            <X style={{ width: 13, height: 13, color: "#64748b" }} />
          </button>
        </div>

        <div style={{ marginBottom: 14 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>
            New workflow name <span style={{ color: "#dc2626" }}>*</span>
          </label>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Required"
            style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: `1.5px solid ${name.trim() ? "#e2e8f0" : "#fca5a5"}`, fontSize: 13, color: "#0f172a", outline: "none", boxSizing: "border-box" }}
          />
          {!name.trim() && <p style={{ fontSize: 11, color: "#dc2626", margin: "4px 0 0" }}>Name is required</p>}
        </div>

        <div style={{ marginBottom: 20 }}>
          <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            style={{ width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #e2e8f0", fontSize: 13, color: "#0f172a", outline: "none", resize: "vertical", boxSizing: "border-box" }}
          />
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 600, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", color: "#374151" }}>
            Cancel
          </button>
          <button disabled={!canSubmit} onClick={() => canSubmit && onCreate(name.trim(), description)} style={{
            flex: 2, padding: "9px 0", fontSize: 13, fontWeight: 700,
            background: canSubmit ? "#4f46e5" : "#e2e8f0", color: canSubmit ? "white" : "#94a3b8",
            border: "none", borderRadius: 8, cursor: canSubmit ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
          }}>
            <Copy style={{ width: 13, height: 13 }} />
            Create & open builder
          </button>
        </div>
      </div>
    </div>
  );
}

const MINI_NODE_TYPES = {
  supervisorAgent: SupervisorAgentNode,
  specialistAgent: SpecialistAgentNode,
  humanApproval: HumanApprovalNode,
  memory: MemoryNode,
};

// ── run modal ─────────────────────────────────────────────────────────────────
function RunModal({ token, workflowId, workflowName, workflow, onClose, onRun, isPending }: {
  token: string; workflowId: string; workflowName: string; workflow: Workflow;
  onClose: () => void; isPending: boolean;
  onRun: (workspacePath: string) => void;
}) {
  const workspacesQuery = useQuery({ queryKey: ["workspaces"], queryFn: () => api.runtimeWorkspaces(token) });
  const workspaces: RuntimeWorkspace[] = workspacesQuery.data ?? [];
  const [changing, setChanging] = useState(false);
  const [copiedCommand, setCopiedCommand] = useState(false);

  // Resolve preferred workspace: builder's localStorage selection → active → first
  const preferredId = (() => { try { return localStorage.getItem(`specter_workspace_${workflowId}`) ?? ""; } catch { return ""; } })();
  const preferred = workspaces.find((w) => w.id === preferredId)
    ?? workspaces.find((w) => w.is_active)
    ?? workspaces[0];

  const [selWsId, setSelWsId] = useState<string>("");
  const effectiveWs = workspaces.find((w) => w.id === (selWsId || preferred?.id)) ?? preferred;
  const canRun = !!effectiveWs && !isPending;
  const gatePath =
    (import.meta.env.VITE_SPECTER_GATE_PATH as string | undefined)
    ?? "/Users/navjyotnishant/Desktop/github/navjyotnishant/specter-agent/scripts/specter-agent";
  const terminalCommand = effectiveWs
    ? [
        `cd ${shellQuote(effectiveWs.path)}`,
        [
          shellQuote(gatePath),
          shellQuote(workflow.id),
          "--workspace",
          ".",
          "--json",
        ].join(" "),
      ].join(" && ")
    : "";

  const copyTerminalCommand = async () => {
    if (!terminalCommand) return;
    await navigator.clipboard.writeText(terminalCommand);
    setCopiedCommand(true);
    window.setTimeout(() => setCopiedCommand(false), 1600);
  };

  const truncatePath = (p: string) => {
    const home = p.replace(/^\/Users\/[^/]+/, "~");
    return home.length > 42 ? "…" + home.slice(-40) : home;
  };

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,23,42,0.3)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ background: "white", borderRadius: 16, padding: 24, width: 560, maxWidth: "calc(100vw - 32px)", boxShadow: "0 24px 64px rgba(0,0,0,0.14)" }} onClick={(e) => e.stopPropagation()}>

        {/* header */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: "#eff0fe", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Play style={{ width: 16, height: 16, color: "#4f46e5" }} />
            </div>
            <div>
              <p style={{ fontSize: 15, fontWeight: 800, color: "#0f172a", margin: 0 }}>Run workflow</p>
              <p style={{ fontSize: 12, color: "#94a3b8", margin: "2px 0 0" }}>{workflowName}</p>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 8, padding: 8, cursor: "pointer", display: "flex" }}>
            <X style={{ width: 13, height: 13, color: "#64748b" }} />
          </button>
        </div>

        {/* workspace section */}
        <p style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 8px" }}>Approved repository</p>

        {workspacesQuery.isLoading ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderRadius: 10, border: "1px solid #e2e8f0", marginBottom: 20 }}>
            <Loader2 style={{ width: 14, height: 14, color: "#94a3b8", animation: "wf-spin 1s linear infinite" }} />
            <span style={{ fontSize: 13, color: "#94a3b8" }}>Loading workspaces…</span>
          </div>
        ) : !effectiveWs ? (
          <div style={{ padding: "14px 16px", borderRadius: 10, background: "#fef2f2", border: "1px solid #fecaca", marginBottom: 20 }}>
            <p style={{ fontSize: 12, color: "#dc2626", margin: 0, fontWeight: 600 }}>No workspace configured</p>
            <p style={{ fontSize: 11, color: "#f87171", margin: "3px 0 0" }}>Add a workspace in Settings → Runtime before running.</p>
          </div>
        ) : changing ? (
          <div style={{ marginBottom: 20 }}>
            <select
              autoFocus
              value={effectiveWs.id}
              onChange={(e) => { setSelWsId(e.target.value); setChanging(false); }}
              style={{ width: "100%", padding: "10px 12px", borderRadius: 10, border: "1.5px solid #4f46e5", fontSize: 13, color: "#0f172a", background: "white", outline: "none" }}
            >
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name} — {truncatePath(w.path)}</option>)}
            </select>
            <p style={{ fontSize: 11, color: "#94a3b8", margin: "5px 0 0" }}>Select a workspace then click Run</p>
          </div>
        ) : (
          <div style={{
            display: "flex", alignItems: "center", gap: 12,
            padding: "12px 14px", borderRadius: 10,
            background: "#f8fafc", border: "1.5px solid #e2e8f0",
            marginBottom: 20,
          }}>
            <div style={{ width: 34, height: 34, borderRadius: 8, background: "#f1f5f9", border: "1px solid #e2e8f0", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <FolderOpen style={{ width: 15, height: 15, color: "#64748b" }} />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", margin: 0 }}>{effectiveWs.name}</p>
              <p style={{ fontSize: 11, color: "#64748b", margin: "2px 0 0", fontFamily: "ui-monospace, monospace", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {truncatePath(effectiveWs.path)}
              </p>
            </div>
            {workspaces.length > 1 && (
              <button onClick={() => setChanging(true)} style={{ fontSize: 11, fontWeight: 600, color: "#4f46e5", background: "none", border: "none", cursor: "pointer", flexShrink: 0, padding: "4px 8px", borderRadius: 6 }}>
                Change
              </button>
            )}
          </div>
        )}

        {/* mini workflow canvas */}
        {(workflow.graph?.nodes ?? []).length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <p style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 8px" }}>
              Workflow · {(workflow.graph.nodes ?? []).length} nodes
            </p>
            <div style={{ height: 200, borderRadius: 10, border: "1px solid #e2e8f0", overflow: "hidden", background: "#fafafa" }}>
              <ReactFlowProvider>
                <ReactFlow
                  nodes={workflow.graph.nodes as never[]}
                  edges={workflow.graph.edges as never[]}
                  nodeTypes={MINI_NODE_TYPES}
                  fitView
                  fitViewOptions={{ padding: 0.15 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  panOnDrag={false}
                  zoomOnScroll={false}
                  zoomOnPinch={false}
                  zoomOnDoubleClick={false}
                  preventScrolling={false}
                  proOptions={{ hideAttribution: true }}
                >
                  <Background color="#e2e8f0" gap={20} size={1} />
                </ReactFlow>
              </ReactFlowProvider>
            </div>
          </div>
        )}

        {effectiveWs && (
          <div style={{ marginBottom: 18 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
              <p style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
                Workflow gate command
              </p>
              <button
                onClick={copyTerminalCommand}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "5px 9px", borderRadius: 7,
                  border: "1px solid #c7d2fe", background: copiedCommand ? "#ecfdf5" : "#f0f4ff",
                  color: copiedCommand ? "#047857" : "#4f46e5",
                  fontSize: 11, fontWeight: 700, cursor: "pointer",
                }}
              >
                {copiedCommand ? <CheckCircle2 style={{ width: 11, height: 11 }} /> : <Copy style={{ width: 11, height: 11 }} />}
                {copiedCommand ? "Copied" : "Copy"}
              </button>
            </div>
            <pre style={{
              margin: 0,
              padding: "12px 14px",
              borderRadius: 10,
              border: "1px solid #e2e8f0",
              background: "#0f172a",
              color: "#e2e8f0",
              fontSize: 11,
              lineHeight: 1.6,
              overflowX: "auto",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            }}>
              {terminalCommand}
            </pre>
            <p style={{ fontSize: 10, color: "#94a3b8", margin: "6px 0 0" }}>
              Shows color-coded progress in terminal; final JSON remains machine-readable for automation.
            </p>
          </div>
        )}

        {/* actions */}
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onClose} style={{ flex: 1, padding: "10px 0", fontSize: 13, fontWeight: 600, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10, cursor: "pointer", color: "#374151" }}>
            Cancel
          </button>
          <button disabled={!canRun} onClick={() => effectiveWs && onRun(effectiveWs.path)} style={{
            flex: 2, padding: "10px 0", fontSize: 13, fontWeight: 700,
            background: canRun ? "#4f46e5" : "#e2e8f0", color: canRun ? "white" : "#94a3b8",
            border: "none", borderRadius: 10, cursor: canRun ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 7,
            boxShadow: canRun ? "0 2px 10px #4f46e530" : "none",
          }}>
            {isPending ? <Loader2 style={{ width: 13, height: 13, animation: "wf-spin 1s linear infinite" }} /> : <Play style={{ width: 13, height: 13 }} />}
            Run now
          </button>
        </div>
      </div>
    </div>
  );
}

// ── run history row ───────────────────────────────────────────────────────────
function RunHistoryRow({ run, onClick }: { run: WorkflowRun; onClick: () => void }) {
  const dur = fmtDuration(run);
  return (
    <tr
      onClick={onClick}
      style={{ cursor: "pointer", borderBottom: "1px solid #f8fafc" }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "#f0f4ff")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <td style={{ padding: "8px 12px", fontFamily: "ui-monospace, monospace", fontSize: 11, fontWeight: 700, color: "#4f46e5" }}>
        {run.id.slice(0, 8)}
      </td>
      <td style={{ padding: "8px 8px" }}><StatusBadge status={run.status} /></td>
      <td style={{ padding: "8px 8px", fontSize: 11, color: "#374151" }}>{fmtRelative(run.created_at)}</td>
      <td style={{ padding: "8px 8px", fontFamily: "ui-monospace, monospace", fontSize: 11, color: "#6b7280" }}>
        {dur ?? (run.status === "running" ? <span style={{ color: "#2563eb", fontWeight: 600 }}>Live</span> : "—")}
      </td>
      <td style={{ padding: "8px 12px 8px 0", textAlign: "right" }}>
        <ChevronRight style={{ width: 12, height: 12, color: "#d1d5db" }} />
      </td>
    </tr>
  );
}

// ── workflow row ──────────────────────────────────────────────────────────────
// colSpan matches table: templates=3, custom workflows=4 (no "Type" col in separate sections)
function WorkflowRow({ workflow, token, canUseBackend, onDelete, isDeleting, onCopyTemplate, onPublish, isPublishing, onUnpublish, isUnpublishing }: {
  workflow: Workflow; token: string; canUseBackend: boolean;
  onDelete: (id: string) => void; isDeleting: boolean;
  onCopyTemplate: (workflow: Workflow, name: string, description: string) => void;
  onPublish: (id: string) => void; isPublishing: boolean;
  onUnpublish: (id: string) => void; isUnpublishing: boolean;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [runModal, setRunModal] = useState(false);
  const [templateModal, setTemplateModal] = useState(false);

  // Always fetch runs (not gated on expand) so Last Run column shows correct data
  const runsQuery = useQuery({
    queryKey: ["runs", workflow.id],
    queryFn: () => api.listRuns(token, workflow.id),
    enabled: canUseBackend,
    refetchInterval: 8000,
  });

  const runMutation = useMutation({
    mutationFn: (workspacePath: string) =>
      api.startRun(token, { workflow_id: workflow.id, workspace_path: workspacePath }),
    onSuccess: (data) => {
      setRunModal(false);
      queryClient.invalidateQueries({ queryKey: ["runs", workflow.id] });
      queryClient.invalidateQueries({ queryKey: ["all-runs"] });
      navigate(`/workflows/${data.workflow_id}/run/${data.run_id}`, { state: { from: "/workflows" } });
    },
  });

  const runs: WorkflowRun[] = runsQuery.data ?? [];
  const lastRun = runs[0];
  const activeRun = runs.find((r) => ["running", "queued", "waiting_approval"].includes(r.status));
  const nodeCount = workflow.graph?.nodes?.length ?? 0;
  const isTemplate = !!workflow.is_template;

  return (
    <>
      {/* ── main row — full row clickable to expand ── */}
      <tr
        onClick={() => setExpanded((v) => !v)}
        style={{
          borderBottom: expanded ? "none" : "1px solid #f1f5f9",
          background: expanded ? "#f8fafc" : "white",
          cursor: "pointer",
          transition: "background 0.1s",
        }}
        onMouseEnter={(e) => { if (!expanded) e.currentTarget.style.background = "#fafafa"; }}
        onMouseLeave={(e) => { if (!expanded) e.currentTarget.style.background = "white"; }}
      >
        {/* chevron + name */}
        <td style={{ padding: "13px 16px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ color: "#94a3b8", flexShrink: 0, display: "flex" }}>
              {expanded
                ? <ChevronDown style={{ width: 14, height: 14 }} />
                : <ChevronRight style={{ width: 14, height: 14 }} />}
            </span>
            <div style={{
              width: 32, height: 32, borderRadius: 8, flexShrink: 0,
              background: activeRun ? "#eff6ff" : "#f1f5f9",
              border: `1px solid ${activeRun ? "#bfdbfe" : "#e2e8f0"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {activeRun
                ? <Loader2 style={{ width: 14, height: 14, color: "#2563eb", animation: "wf-spin 1s linear infinite" }} />
                : <WorkflowIcon style={{ width: 14, height: 14, color: "#94a3b8" }} />
              }
            </div>
            <div style={{ minWidth: 0 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: "#0f172a", margin: 0 }}>{workflow.name}</p>
              {workflow.description && (
                <p style={{ fontSize: 11, color: "#94a3b8", margin: "1px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 380 }}>
                  {workflow.description}
                </p>
              )}
            </div>
          </div>
        </td>

        {/* nodes */}
        <td style={{ padding: "13px 8px", fontSize: 12, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
          {nodeCount} nodes
        </td>

        {/* last run — only for custom workflows, not templates */}
        {!isTemplate && (
          <td style={{ padding: "13px 8px" }}>
            {runsQuery.isLoading
              ? <Loader2 style={{ width: 11, height: 11, color: "#d1d5db", animation: "wf-spin 1s linear infinite" }} />
              : activeRun
              ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#2563eb", display: "block", animation: "wf-pulse 1s infinite" }} />
                  <StatusBadge status={activeRun.status} />
                </div>
              : lastRun
              ? <div>
                  <StatusBadge status={lastRun.status} />
                  <p style={{ fontSize: 10, color: "#94a3b8", margin: "3px 0 0" }}>{fmtRelative(lastRun.created_at)}</p>
                </div>
              : <span style={{ fontSize: 11, color: "#d1d5db" }}>Never run</span>
            }
          </td>
        )}

        {/* actions — stop row click propagation */}
        <td style={{ padding: "13px 16px 13px 8px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: "flex-end" }}>

            {isTemplate ? (
              /* Template: "Use template" button only — no Run */
              <button
                disabled={!canUseBackend}
                onClick={() => setTemplateModal(true)}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "6px 14px", borderRadius: 7,
                  background: "#f0f4ff", color: "#4f46e5",
                  border: "1px solid #c7d2fe", cursor: canUseBackend ? "pointer" : "not-allowed",
                  fontSize: 12, fontWeight: 700,
                  opacity: !canUseBackend ? 0.5 : 1,
                }}
              >
                <Copy style={{ width: 11, height: 11 }} />
                Use template
              </button>
            ) : (
              /* Custom: Run button — disabled while a run is active */
              (() => {
                const isRunActive = !!activeRun || runMutation.isPending;
                const disabled = !canUseBackend || isRunActive;
                return (
                  <button
                    disabled={disabled}
                    onClick={() => !disabled && setRunModal(true)}
                    title={activeRun ? `Run in progress — ${activeRun.status}` : undefined}
                    style={{
                      display: "flex", alignItems: "center", gap: 5,
                      padding: "6px 14px", borderRadius: 7,
                      background: disabled ? "#e2e8f0" : "#4f46e5",
                      color: disabled ? "#94a3b8" : "white",
                      border: "none",
                      cursor: disabled ? "not-allowed" : "pointer",
                      fontSize: 12, fontWeight: 700,
                    }}
                  >
                    {runMutation.isPending
                      ? <Loader2 style={{ width: 11, height: 11, animation: "wf-spin 1s linear infinite" }} />
                      : activeRun
                      ? <Loader2 style={{ width: 11, height: 11, animation: "wf-spin 1s linear infinite" }} />
                      : <Play style={{ width: 11, height: 11 }} />}
                    {activeRun ? activeRun.status === "waiting_approval" ? "Awaiting approval" : "Running…" : "Run"}
                  </button>
                );
              })()
            )}

            {/* Edit — disabled while running */}
            <button
              disabled={!!activeRun}
              onClick={() => !activeRun && navigate(`/workflows/${workflow.id}/builder`)}
              title={activeRun ? "Cannot edit while a run is active" : undefined}
              style={{
                display: "flex", alignItems: "center", gap: 5,
                padding: "6px 12px", borderRadius: 7,
                background: "white", color: activeRun ? "#94a3b8" : "#374151",
                border: "1px solid #e2e8f0", cursor: activeRun ? "not-allowed" : "pointer",
                fontSize: 12, fontWeight: 600,
                opacity: activeRun ? 0.5 : 1,
              }}
            >
              <Code2 style={{ width: 11, height: 11 }} />
              Edit
            </button>

            {/* Publish as template — custom only, disabled while running */}
            {!isTemplate && (
              <button
                disabled={!canUseBackend || isPublishing || !!activeRun}
                onClick={() => !activeRun && onPublish(workflow.id)}
                title={activeRun ? "Cannot publish while a run is active" : "Publish as template so the team can use it as a starting point"}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "6px 12px", borderRadius: 7,
                  background: isPublishing ? "#fef3c7" : "#fffbeb",
                  color: "#92400e",
                  border: "1px solid #fde68a",
                  cursor: (!canUseBackend || isPublishing || !!activeRun) ? "not-allowed" : "pointer",
                  fontSize: 12, fontWeight: 700,
                  opacity: (isPublishing || !!activeRun) ? 0.5 : 1,
                }}
              >
                {isPublishing
                  ? <Loader2 style={{ width: 11, height: 11, animation: "wf-spin 1s linear infinite" }} />
                  : <Copy style={{ width: 11, height: 11 }} />}
                Publish as template
              </button>
            )}

            {/* Unpublish — template only */}
            {isTemplate && (
              <button
                disabled={!canUseBackend || isUnpublishing}
                onClick={() => onUnpublish(workflow.id)}
                title="Remove from templates — workflow moves back to My Workflows"
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "6px 10px", borderRadius: 7,
                  background: "white", color: "#6b7280",
                  border: "1px solid #e2e8f0", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  opacity: isUnpublishing ? 0.5 : 1,
                }}
              >
                {isUnpublishing
                  ? <Loader2 style={{ width: 11, height: 11, animation: "wf-spin 1s linear infinite" }} />
                  : <X style={{ width: 11, height: 11 }} />}
                Unpublish
              </button>
            )}

            {/* Delete — custom only */}
            {!isTemplate && (
              <button
                disabled={!canUseBackend || isDeleting}
                onClick={() => onDelete(workflow.id)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 30, height: 30, borderRadius: 7,
                  background: "white", color: "#dc2626",
                  border: "1px solid #fecaca", cursor: "pointer",
                  opacity: isDeleting ? 0.5 : 1,
                }}
              >
                <Trash2 style={{ width: 11, height: 11 }} />
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* ── expanded detail ── */}
      {expanded && (
        <tr style={{ borderBottom: "1px solid #f1f5f9" }}>
          <td colSpan={isTemplate ? 3 : 4} style={{ padding: "0 0 12px 60px", background: isTemplate ? "#fffdf7" : "#f8fafc" }}>
            <div style={{ borderLeft: `2px solid ${isTemplate ? "#fde68a" : "#e2e8f0"}`, marginLeft: 4, paddingLeft: 16 }}>

              {isTemplate ? (
                /* Templates: show description + use-template CTA */
                <div style={{ padding: "12px 0 8px" }}>
                  <p style={{ fontSize: 11, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 7, padding: "7px 12px", margin: "0 0 10px", display: "inline-block" }}>
                    Templates cannot be run directly. Click <strong>Use template</strong> to create an editable copy.
                  </p>
                  {workflow.description && (
                    <p style={{ fontSize: 12, color: "#6b7280", margin: 0 }}>{workflow.description}</p>
                  )}
                </div>
              ) : (
                /* Custom workflows: run history */
                <>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", margin: "10px 0 8px" }}>
                    Run history · {runs.length} runs
                  </p>

                  {runsQuery.isLoading && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "#94a3b8", padding: "6px 0 10px" }}>
                      <Loader2 style={{ width: 12, height: 12, animation: "wf-spin 1s linear infinite" }} /> Loading…
                    </div>
                  )}

                  {!runsQuery.isLoading && runs.length === 0 && (
                    <p style={{ fontSize: 12, color: "#cbd5e1", fontStyle: "italic", padding: "4px 0 8px" }}>No runs yet.</p>
                  )}

                  {runs.length > 0 && (
                    <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 600 }}>
                      <thead>
                        <tr>
                          {["Run ID", "Status", "Started", "Duration", ""].map((h) => (
                            <th key={h} style={{
                              padding: "4px 8px 4px " + (h === "Run ID" ? "12px" : "8px"),
                              fontSize: 9, fontWeight: 700, color: "#cbd5e1",
                              textTransform: "uppercase", letterSpacing: "0.08em",
                              textAlign: h === "" ? "right" : "left",
                            }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {runs.slice(0, 10).map((run) => (
                          <RunHistoryRow
                            key={run.id}
                            run={run}
                            onClick={() => navigate(`/workflows/${workflow.id}/run/${run.id}`, { state: { from: "/workflows" } })}
                          />
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </div>
          </td>
        </tr>
      )}

      {/* modals */}
      {runModal && (
        <RunModal
          token={token}
          workflowId={workflow.id}
          workflowName={workflow.name}
          workflow={workflow}
          onClose={() => setRunModal(false)}
          isPending={runMutation.isPending}
          onRun={(ws) => runMutation.mutate(ws)}
        />
      )}
      {templateModal && (
        <UseTemplateModal
          workflow={workflow}
          token={token}
          onClose={() => setTemplateModal(false)}
          onCreate={(name, description) => {
            setTemplateModal(false);
            onCopyTemplate(workflow, name, description);
          }}
        />
      )}
    </>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────
const emptyGraph = { nodes: [], edges: [] };

export default function Workflows() {
  const navigate = useNavigate();
  const token = getStoredToken() ?? "";
  const canUseBackend = Boolean(token);
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [newMenuOpen, setNewMenuOpen] = useState(false);
  const [newMenuAnchor, setNewMenuAnchor] = useState<{ bottom: number; right: number } | null>(null);
  const newMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [importOpen, setImportOpen] = useState(false);

  const skillsQuery = useQuery({
    queryKey: ["skills"],
    queryFn: () => api.skills(token),
    enabled: canUseBackend,
    retry: false,
  });

  const { data = [], isLoading } = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows(token),
    enabled: canUseBackend,
    retry: false,
  });

  const workflows = data;

  const create = useMutation({
    mutationFn: (payload: { name: string; description: string; graph: typeof emptyGraph }) =>
      api.createWorkflow(token, payload),
    onSuccess: (newWf) => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      navigate(`/workflows/${newWf.id}/builder`);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to create workflow"),
  });

  const handleNewWorkflow = () => {
    setNewMenuOpen(false);
    navigate("/workflows/new/builder");
  };

  // ── import a repo as a brand-new workflow ─────────────────────────────────
  // Creates the skills rows first (so node.data.selectedSkills resolves at run
  // time), then creates the workflow and opens it in the builder.
  /** Write the selected skills into the skill library. Shared by both import paths. */
  const importSkills = async (
    parsed: ParsedRepository,
    selection: ImportSelection,
    skillIdFor: (key: string) => string,
  ) => {
    const repoPath = parsed.repo?.path ?? "";
    const picked = (parsed.skills ?? []).filter((s) => !s.error && selection.skills.has(s.key));

    await Promise.all(
      picked.map((skill) =>
        api.createSkill(token, {
          id: skillIdFor(skill.key),
          name: skill.name || skill.key,
          description: skill.description,
          prompt_template: skill.body,
          compatible_agent_roles: [],
          source_repo: repoPath,
          upsert: true,
        }),
      ),
    );
    queryClient.invalidateQueries({ queryKey: ["skills"] });
    return picked.length;
  };

  /** Skills-only: populate the library, build no workflow. */
  const handleImportSkillsOnly = async (
    parsed: ParsedRepository,
    selection: ImportSelection,
    skillIdFor: (key: string) => string,
  ) => {
    const count = await importSkills(parsed, selection, skillIdFor);
    setImportOpen(false);
    toast({
      title: `Imported ${count} skill${count === 1 ? "" : "s"}`,
      description: "They're in your skill library and can be attached to any node from the inspector.",
    });
  };

  const handleImport = async (
    parsed: ParsedRepository,
    selection: ImportSelection,
    skillIdFor: (key: string) => string,
  ) => {
    const repoPath = parsed.repo?.path ?? "";
    await importSkills(parsed, selection, skillIdFor);

    const graph = buildImportGraph(parsed, selection, skillIdFor);

    // Name the workflow after the orchestrator that drives it -- "tech-blog" says
    // far more than the repo name, especially when importing one skill from a repo
    // of many. The root is the supervisor nothing else points at; with several
    // (or none) fall back to the repo, which is the only honest summary.
    const targets = new Set(graph.edges.map((e) => e.target));
    const roots = graph.nodes.filter(
      (n) => n.type === "supervisorAgent" && !targets.has(n.id),
    );
    const root = roots.length === 1 ? roots[0] : null;
    const rootData = (root?.data ?? {}) as { label?: string; objective?: string };

    const created = await api.createWorkflow(token, {
      name: rootData.label || parsed.repo?.name || "Imported workflow",
      description:
        rootData.objective?.trim() ||
        `Imported from ${repoPath || parsed.repo?.name || "a repository"}`,
      graph,
    });
    queryClient.invalidateQueries({ queryKey: ["workflows"] });
    setImportOpen(false);
    navigate(`/workflows/${created.id}/builder`);
  };

  // Deleting is irreversible, so it always routes through a confirm dialog.
  const [pendingDelete, setPendingDelete] = useState<Workflow | null>(null);
  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(token, id),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      const name = workflows.find((w) => w.id === id)?.name;
      toast({ title: `Deleted ${name ? `"${name}"` : "workflow"}` });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to delete workflow"),
  });

  const publish = useMutation({
    mutationFn: (id: string) => api.publishTemplate(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const unpublish = useMutation({
    mutationFn: (id: string) => api.unpublishTemplate(token, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const handleCopyTemplate = (source: Workflow, newName: string, newDescription: string) => {
    create.mutate({
      name: newName,
      description: newDescription,
      graph: (source.graph as typeof emptyGraph) ?? emptyGraph,
    });
  };

  const [activeTab, setActiveTab] = useState<"workflows" | "templates">("workflows");
  const myWorkflows = workflows.filter((w) => !w.is_template);
  const templates = workflows.filter((w) => w.is_template);

  return (
    <div className="space-y-5">

      {/* ── header ── */}
      <Card className="overflow-hidden rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-7">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600 text-white shadow-lg shadow-indigo-100">
                <GitBranch className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-3">
                  <h2 className="text-2xl font-black tracking-tight text-slate-950">Workflows</h2>
                  <Badge className="rounded-full bg-indigo-100 px-3 py-1 text-indigo-800 hover:bg-indigo-100 text-xs">
                    Workflow operations
                  </Badge>
                </div>
                <p className="mt-0.5 text-sm text-slate-500">
                  Click a row to expand run history. Use templates to create editable copies.
                </p>
              </div>
            </div>
            <div style={{ position: "relative" }}>
              <button
                ref={newMenuButtonRef}
                onClick={() => {
                  const rect = newMenuButtonRef.current?.getBoundingClientRect();
                  if (rect) {
                    setNewMenuAnchor({ bottom: rect.bottom, right: window.innerWidth - rect.right });
                  }
                  setNewMenuOpen((v) => !v);
                }}
                style={{
                  display: "flex", alignItems: "center", gap: 7,
                  padding: "9px 18px", borderRadius: 999,
                  background: "#4f46e5", color: "white", border: "none",
                  cursor: "pointer", fontSize: 13, fontWeight: 700,
                  boxShadow: "0 2px 10px #4f46e530",
                }}
              >
                <Plus style={{ width: 13, height: 13 }} />
                New workflow
                <ChevronDown style={{ width: 12, height: 12, opacity: 0.8 }} />
              </button>
              {/* Portaled to <body>: the enclosing Card sets overflow-hidden, which
                  would otherwise clip this menu to the card's bounds. */}
              {newMenuOpen && newMenuAnchor && createPortal(
                <>
                  <div
                    onClick={() => setNewMenuOpen(false)}
                    style={{ position: "fixed", inset: 0, zIndex: 40 }}
                  />
                  <div style={{
                    position: "fixed", top: newMenuAnchor.bottom + 6, right: newMenuAnchor.right, zIndex: 50,
                    background: "white", border: "1px solid #e2e8f0", borderRadius: 10,
                    boxShadow: "0 8px 30px rgba(0,0,0,0.12)", minWidth: 280, overflow: "hidden",
                  }}>
                    <button onClick={handleNewWorkflow} style={newMenuItem}>
                      <Plus style={{ width: 13, height: 13, color: "#4f46e5", flexShrink: 0, marginTop: 2 }} />
                      <span>
                        <span style={{ display: "block", fontWeight: 700, fontSize: 12, color: "#0f172a" }}>Blank workflow</span>
                        <span style={{ display: "block", fontSize: 10.5, color: "#94a3b8", marginTop: 1 }}>
                          Start from an empty canvas
                        </span>
                      </span>
                    </button>
                    <button
                      onClick={() => { setNewMenuOpen(false); setImportOpen(true); }}
                      disabled={!canUseBackend}
                      style={{ ...newMenuItem, borderTop: "1px solid #f1f5f9", opacity: canUseBackend ? 1 : 0.45 }}
                    >
                      <FolderGit2 style={{ width: 13, height: 13, color: "#4f46e5", flexShrink: 0, marginTop: 2 }} />
                      <span>
                        <span style={{ display: "block", fontWeight: 700, fontSize: 12, color: "#0f172a" }}>Import from repository</span>
                        <span style={{ display: "block", fontSize: 10.5, color: "#94a3b8", marginTop: 1 }}>
                          Build a workflow from a repo's skills and agents
                        </span>
                      </span>
                    </button>
                  </div>
                </>,
                document.body,
              )}
            </div>
          </div>
          {error && <Alert variant="destructive" className="mt-3 rounded-xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      {/* ── tabbed table card ── */}
      <Card className="overflow-hidden rounded-2xl border-white/80 bg-white shadow-sm">

        {/* tab bar */}
        <div style={{ display: "flex", alignItems: "center", borderBottom: "1px solid #f1f5f9", background: "#fafafa", padding: "0 20px" }}>
          {(["workflows", "templates"] as const).map((tab) => {
            const active = activeTab === tab;
            const count = tab === "workflows" ? myWorkflows.length : templates.length;
            const label = tab === "workflows" ? "My Workflows" : "Templates";
            const Icon = tab === "workflows" ? WorkflowIcon : Copy;
            return (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "12px 4px", marginRight: 24,
                  fontSize: 12, fontWeight: active ? 800 : 600,
                  color: active ? "#0f172a" : "#94a3b8",
                  background: "none", border: "none", cursor: "pointer",
                  borderBottom: active ? "2px solid #4f46e5" : "2px solid transparent",
                  transition: "color 0.1s, border-color 0.1s",
                }}
              >
                <Icon style={{ width: 13, height: 13 }} />
                {label}
                <span style={{
                  fontSize: 10, fontWeight: 700, borderRadius: 20, padding: "1px 7px",
                  background: active ? "#eff0fe" : "#f1f5f9",
                  color: active ? "#4f46e5" : "#94a3b8",
                }}>
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── My Workflows tab ── */}
        {activeTab === "workflows" && (
          <>
            {isLoading && canUseBackend && (
              <div className="flex items-center justify-center gap-3 py-12 text-slate-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm">Loading…</span>
              </div>
            )}
            {(!isLoading || !canUseBackend) && myWorkflows.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #f8fafc", background: "#fafafa" }}>
                      {["Workflow", "Nodes", "Last run", ""].map((h, i) => (
                        <th key={h} style={{
                          padding: "8px " + (i === 0 ? "16px" : i === 3 ? "16px 16px 8px 8px" : "8px"),
                          fontSize: 10, fontWeight: 700, color: "#94a3b8",
                          textTransform: "uppercase", letterSpacing: "0.08em",
                          textAlign: i === 3 ? "right" : "left", whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {myWorkflows.map((workflow) => (
                      <WorkflowRow
                        key={workflow.id}
                        workflow={workflow}
                        token={token}
                        canUseBackend={canUseBackend}
                        onDelete={(id) => setPendingDelete(workflows.find((w) => w.id === id) ?? null)}
                        isDeleting={remove.isPending}
                        onCopyTemplate={handleCopyTemplate}
                        onPublish={(id) => publish.mutate(id)}
                        isPublishing={publish.isPending}
                        onUnpublish={(id) => unpublish.mutate(id)}
                        isUnpublishing={unpublish.isPending}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!isLoading && myWorkflows.length === 0 && (
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <WorkflowIcon style={{ width: 28, height: 28, color: "#e2e8f0", margin: "0 auto 10px" }} />
                <p style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>No workflows yet</p>
                <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>
                  Click <strong>New workflow</strong> above, or switch to <strong>Templates</strong> to start from a preset.
                </p>
              </div>
            )}
          </>
        )}

        {/* ── Templates tab ── */}
        {activeTab === "templates" && (
          <>
            <div style={{ padding: "10px 20px 10px", background: "#fffdf7", borderBottom: "1px solid #fef3c7", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <p style={{ fontSize: 11, color: "#92400e", margin: 0 }}>
                Templates are read-only presets for the team. Build a workflow then publish it as a template, or create one from scratch below.
              </p>
              <button
                onClick={() => navigate("/workflows/new/builder?template=1")}
                style={{
                  display: "flex", alignItems: "center", gap: 6, flexShrink: 0,
                  padding: "7px 14px", borderRadius: 8,
                  background: "#d97706", color: "white", border: "none",
                  cursor: "pointer", fontSize: 12, fontWeight: 700,
                  boxShadow: "0 1px 4px #d9770630",
                }}
              >
                <Plus style={{ width: 12, height: 12 }} />
                New template
              </button>
            </div>
            {templates.length > 0 ? (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ borderBottom: "1px solid #f8fafc", background: "#fffdf7" }}>
                      {["Template", "Nodes", ""].map((h, i) => (
                        <th key={h} style={{
                          padding: "8px " + (i === 0 ? "16px" : i === 2 ? "16px 16px 8px 8px" : "8px"),
                          fontSize: 10, fontWeight: 700, color: "#94a3b8",
                          textTransform: "uppercase", letterSpacing: "0.08em",
                          textAlign: i === 2 ? "right" : "left", whiteSpace: "nowrap",
                        }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {templates.map((workflow) => (
                      <WorkflowRow
                        key={workflow.id}
                        workflow={workflow}
                        token={token}
                        canUseBackend={canUseBackend}
                        onDelete={(id) => setPendingDelete(workflows.find((w) => w.id === id) ?? null)}
                        isDeleting={remove.isPending}
                        onCopyTemplate={handleCopyTemplate}
                        onPublish={(id) => publish.mutate(id)}
                        isPublishing={publish.isPending}
                        onUnpublish={(id) => unpublish.mutate(id)}
                        isUnpublishing={unpublish.isPending}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: "48px 24px", textAlign: "center" }}>
                <Copy style={{ width: 28, height: 28, color: "#e2e8f0", margin: "0 auto 10px" }} />
                <p style={{ fontSize: 13, fontWeight: 700, color: "#374151" }}>No templates yet</p>
                <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 4 }}>Admins can publish workflows as templates for the team.</p>
              </div>
            )}
          </>
        )}
      </Card>

      {/* Delete is irreversible and cascades to the workflow's run history. */}
      {pendingDelete && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 100, background: "rgba(15,23,42,0.35)",
            backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setPendingDelete(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "white", borderRadius: 14, padding: 24, width: 440, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}
          >
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ background: "#fef2f2", borderRadius: 10, padding: 9, display: "flex", flexShrink: 0 }}>
                <AlertTriangle style={{ width: 16, height: 16, color: "#dc2626" }} />
              </div>
              <div>
                <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#0f172a" }}>
                  Delete “{pendingDelete.name}”?
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 12.5, color: "#475569", lineHeight: 1.5 }}>
                  This permanently removes the workflow, its saved canvas, and its entire run
                  history — step runs, logs, agent transcripts, memory, and approvals.{" "}
                  <strong>It can't be undone.</strong>
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 11.5, color: "#94a3b8" }}>
                  Skills imported from a repository stay in your library.
                </p>
              </div>
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
              <button
                onClick={() => setPendingDelete(null)}
                style={{
                  flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 600, background: "#f8fafc",
                  border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", color: "#374151",
                }}
              >
                Cancel
              </button>
              <button
                autoFocus
                disabled={remove.isPending}
                onClick={() => {
                  remove.mutate(pendingDelete.id);
                  setPendingDelete(null);
                }}
                style={{
                  flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 700, background: "#dc2626",
                  color: "white", border: "none", borderRadius: 8,
                  cursor: remove.isPending ? "not-allowed" : "pointer", opacity: remove.isPending ? 0.6 : 1,
                }}
              >
                Delete workflow
              </button>
            </div>
          </div>
        </div>
      )}

      {importOpen && (
        <ImportRepoDialog
          token={token}
          existingSkills={skillsQuery.data ?? []}
          onClose={() => setImportOpen(false)}
          onImport={handleImport}
          onImportSkillsOnly={handleImportSkillsOnly}
        />
      )}

      <style>{`
        @keyframes wf-spin  { to { transform: rotate(360deg); } }
        @keyframes wf-pulse { 0%,100% { opacity:1; } 50% { opacity:0.3; } }
      `}</style>
    </div>
  );
}

const newMenuItem: React.CSSProperties = {
  display: "flex", alignItems: "flex-start", gap: 9, width: "100%", textAlign: "left",
  padding: "10px 14px", background: "none", border: "none", cursor: "pointer",
};
