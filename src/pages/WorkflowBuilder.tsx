import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type EdgeChange,
  useNodesState,
  useEdgesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Database,
  FileText,
  GitBranch,
  History,
  Loader2,
  Play,
  Save,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import type { McpServer } from "@/lib/types";
import { AgentInspector } from "@/components/agents/AgentInspector";
import { AgentTimeline } from "@/components/agents/AgentTimeline";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { HumanApprovalNode } from "@/components/workflow/nodes/HumanApprovalNode";
import { MemoryNode } from "@/components/workflow/nodes/MemoryNode";
import { SpecialistAgentNode } from "@/components/workflow/nodes/SpecialistAgentNode";
import { SupervisorAgentNode } from "@/components/workflow/nodes/SupervisorAgentNode";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { WorkflowGraph } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const MONO: React.CSSProperties = { fontFamily: "ui-monospace, 'Cascadia Code', monospace" };

// ── node type registry ──────────────────────────────────────────────────────
const nodeTypes = {
  supervisorAgent: SupervisorAgentNode,
  specialistAgent: SpecialistAgentNode,
  humanApproval: HumanApprovalNode,
  memory: MemoryNode,
};

// ── default data per node type ──────────────────────────────────────────────
const nodeDefaults: Record<string, Record<string, unknown>> = {
  supervisorAgent: { label: "Supervisor Agent", model: "codex-cli", tools: 0, skills: 0, memoryScope: "team", maxIterations: 4, requiresApproval: true, delegationStrategy: "sequential_delegation", objective: "", systemInstructions: "" },
  specialistAgent: { label: "Specialist Agent", role: "", model: "codex-cli", tools: 0, skills: 0, memoryScope: "workflow", maxIterations: 3, requiresApproval: false, objective: "", systemInstructions: "" },
  humanApproval: { label: "Human Approval", reason: "Requires manual approval before continuing.", timeoutHours: 24 },
  memory: { label: "Write Memory", scope: "workflow" },
};

// ── palette definition ──────────────────────────────────────────────────────
const palette: { category: string; items: { icon: typeof Bot; label: string; nodeType: string }[] }[] = [
  {
    category: "Agents",
    items: [
      { icon: ShieldCheck, label: "Supervisor Agent", nodeType: "supervisorAgent" },
      { icon: Bot, label: "Specialist Agent", nodeType: "specialistAgent" },
    ],
  },
  {
    category: "Control Flow",
    items: [
      { icon: CheckCircle2, label: "Human Approval", nodeType: "humanApproval" },
    ],
  },
  {
    category: "Memory + Context",
    items: [
      { icon: Database, label: "Write Memory", nodeType: "memory" },
      { icon: Database, label: "Read Memory", nodeType: "memory" },
    ],
  },
  {
    category: "Code + SDLC",
    items: [
      { icon: Code2, label: "Codebase Scan", nodeType: "specialistAgent" },
      { icon: Wrench, label: "MCP Tool", nodeType: "specialistAgent" },
      { icon: GitBranch, label: "GitHub Action", nodeType: "specialistAgent" },
      { icon: FileText, label: "Report Generator", nodeType: "specialistAgent" },
    ],
  },
];

// ── seed template ────────────────────────────────────────────────────────────
// Sequential left-to-right pipeline — each col is 320px wide, vertically centred
// supervisor(0) → memory(1,top) → code(2) → deps(3) → secrets(4) → report(5)
// memory runs in parallel with code as a planning step off the supervisor
const COL = 320;
const defaultNodes: Node[] = [
  { id: "supervisor",  type: "supervisorAgent", position: { x: 0,        y: 200 }, data: { label: "Security Supervisor",    model: "codex-cli", selectedTools: [], selectedSkills: [], memoryScope: "team",         maxIterations: 4, requiresApproval: false, delegationStrategy: "sequential_delegation", objective: "Scope this security review, identify the top areas to inspect, and coordinate specialist agents to run in sequence.", systemInstructions: "Delegate only to known specialist agents. Enforce tool allowlists, memory boundaries, and approval policy." } },
  { id: "memory-plan", type: "memory",          position: { x: COL,      y: 40  }, data: { label: "Write task plan",        scope: "team" } },
  { id: "code",        type: "specialistAgent", position: { x: COL * 2,  y: 200 }, data: { label: "Code Security Reviewer",  role: "Secure code review",    model: "codex-cli", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 3, requiresApproval: false, objective: "Review 2–3 key source files for auth, injection, and access-control vulnerabilities.", systemInstructions: "" } },
  { id: "deps",        type: "specialistAgent", position: { x: COL * 3,  y: 200 }, data: { label: "Dependency Auditor",      role: "Dependency auditor",    model: "codex-cli", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 3, requiresApproval: false, objective: "Check requirements.txt or package.json for known vulnerable or outdated packages.", systemInstructions: "" } },
  { id: "secrets",     type: "specialistAgent", position: { x: COL * 4,  y: 200 }, data: { label: "Secrets & Config Agent",  role: "Masked config review",  model: "codex-cli", selectedTools: [], selectedSkills: [], memoryScope: "agent_private", maxIterations: 3, requiresApproval: false, objective: "Scan config files and env patterns for hardcoded secrets, tokens, or insecure defaults.", systemInstructions: "" } },
  { id: "report",      type: "specialistAgent", position: { x: COL * 5,  y: 200 }, data: { label: "Report Writer Agent",     role: "Security report writer", model: "codex-cli", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 2, requiresApproval: false, objective: "Summarise findings from all prior agents into a structured security report with severity ratings.", systemInstructions: "" } },
];

const defaultEdges: Edge[] = [
  { id: "e1", source: "supervisor",  target: "memory-plan", type: "smoothstep" },
  { id: "e2", source: "supervisor",  target: "code",        type: "smoothstep" },
  { id: "e3", source: "code",        target: "deps",        type: "smoothstep" },
  { id: "e4", source: "deps",        target: "secrets",     type: "smoothstep" },
  { id: "e5", source: "secrets",     target: "report",      type: "smoothstep" },
];

// ── normalizer ───────────────────────────────────────────────────────────────
function normalizeGraph(graph?: Partial<WorkflowGraph>): { nodes: Node[]; edges: Edge[] } {
  if (!Array.isArray(graph?.nodes) || graph.nodes.length === 0) return { nodes: defaultNodes, edges: defaultEdges };
  const nodes = (graph.nodes as (Partial<Node> & Record<string, unknown>)[]).map((raw, i) => ({
    id: String(raw.id ?? `node-${i}`),
    type: String(raw.type ?? "specialistAgent"),
    position: (raw.position as { x: number; y: number }) ?? { x: 100 + i * 240, y: 120 },
    data: (raw.data ?? {}) as Record<string, unknown>,
  })) as Node[];
  const edges = (Array.isArray(graph?.edges) ? graph.edges : []) as Edge[];
  return { nodes, edges };
}

function storageKey(id: string) { return `sdlc_workflow_graph_v5_${id}`; }
let nodeCounter = 100;

// ── small presentational helpers ─────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]" style={MONO}>{children}</p>;
}
function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[#f3f4f6] py-1.5 last:border-b-0">
      <span className="text-[10px] text-[#9ca3af]" style={MONO}>{label}</span>
      <span className="text-[10px] font-medium text-[#111827]" style={MONO}>{value}</span>
    </div>
  );
}
function GateRow({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-[#f3f4f6] py-1.5 last:border-b-0">
      <span className="text-[10px] text-[#374151]" style={MONO}>{label}</span>
      <span className="border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide" style={{ borderColor: ready ? "#6ee7b7" : "#fcd34d", color: ready ? "#065f46" : "#92400e", background: ready ? "#ecfdf5" : "#fffbeb", ...MONO }}>
        {ready ? "ready" : "required"}
      </span>
    </div>
  );
}

// ── inner builder (needs ReactFlowProvider above it) ─────────────────────────
function BuilderInner({
  workflowId,
  token,
  canUseBackend,
  publishOnSave = false,
}: {
  workflowId: string;
  token: string;
  canUseBackend: boolean;
  publishOnSave?: boolean;
}) {
  const isNew = workflowId === "new";
  const { screenToFlowPosition, deleteElements } = useReactFlow();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(isNew ? [] : defaultNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(isNew ? [] : defaultEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("context");
  const [workflowName, setWorkflowName] = useState(isNew ? "" : "Security Review Team");
  const [workflowDescription, setWorkflowDescription] = useState(isNew ? "" : "");
  const [statusMessage, setStatusMessage] = useState(isNew ? "New workflow — drag nodes from the palette to get started." : "Drag from the palette to add nodes.");
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => {
    try { return localStorage.getItem(`specter_workspace_${workflowId}`) ?? ""; } catch { return ""; }
  });
  const fitViewOptions = useMemo(() => ({ padding: 0.2 }), []);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphLoadedRef = useRef(false);

  const runtimeStatusQuery = useQuery({ queryKey: ["codex-runtime-status"], queryFn: () => api.codexRuntimeStatus(token), enabled: canUseBackend, retry: false });
  const workspacesQuery = useQuery({ queryKey: ["runtime-workspaces"], queryFn: () => api.runtimeWorkspaces(token), enabled: canUseBackend, retry: false });
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills(token), enabled: canUseBackend, retry: false });
  const mcpQuery = useQuery({ queryKey: ["mcp-list"], queryFn: () => api.mcpList(token), enabled: canUseBackend, retry: false });
  const workflowQuery = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => api.workflow(token, workflowId), enabled: canUseBackend && !isNew, retry: false });
  const allWorkflowsQuery = useQuery({ queryKey: ["workflows"], queryFn: () => api.workflows(token), enabled: canUseBackend, retry: false });
  const templatesList = (allWorkflowsQuery.data ?? []).filter((w) => w.is_template);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);

  // ── load: localStorage wins over DB (local edits survive refresh) ──────────
  useEffect(() => {
    if (isNew || graphLoadedRef.current) return;
    const saved = localStorage.getItem(storageKey(workflowId));
    if (saved) {
      try {
        const g = normalizeGraph(JSON.parse(saved));
        setNodes(g.nodes); setEdges(g.edges);
        setStatusMessage("Graph restored from local storage. Click 'Save graph' to push to database.");
        graphLoadedRef.current = true;
        return;
      } catch { /* fall through to DB */ }
    }
    // no local save — will load from DB once query resolves
  }, [isNew, workflowId, setNodes, setEdges]);

  useEffect(() => {
    const active = workspacesQuery.data?.filter((w) => w.is_active) ?? [];
    if (!selectedWorkspaceId && active.length) {
      const id = active[0].id;
      setSelectedWorkspaceId(id);
      try { localStorage.setItem(`specter_workspace_${workflowId}`, id); } catch { /* ignore */ }
    }
  }, [selectedWorkspaceId, workspacesQuery.data, workflowId]);

  const handleWorkspaceChange = (id: string) => {
    setSelectedWorkspaceId(id);
    try { localStorage.setItem(`specter_workspace_${workflowId}`, id); } catch { /* ignore */ }
  };

  useEffect(() => {
    if (!workflowQuery.data || graphLoadedRef.current) return;
    const g = normalizeGraph(workflowQuery.data.graph);
    setNodes(g.nodes); setEdges(g.edges);
    setWorkflowName(workflowQuery.data.name);
    setWorkflowDescription(workflowQuery.data.description);
    setStatusMessage(`Loaded "${workflowQuery.data.name}" from database.`);
    graphLoadedRef.current = true;
  }, [setEdges, setNodes, workflowQuery.data]);

  // ── auto-save to localStorage 1s after any change ─────────────────────────
  useEffect(() => {
    if (isNew || !graphLoadedRef.current) return;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      try {
        localStorage.setItem(storageKey(workflowId), JSON.stringify({ nodes, edges }));
      } catch { /* ignore quota errors */ }
    }, 1000);
    return () => { if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current); };
  }, [nodes, edges, workflowId]);

  const runMutation = useMutation({
    mutationFn: () => {
      if (!selectedWorkspace) throw new Error("No workspace selected.");
      return api.startRun(token, {
        workflow_id: workflowId,
        workspace_path: selectedWorkspace.path,
        graph: { nodes, edges },
      });
    },
    onSuccess: (data) => navigate(`/workflows/${workflowId}/run/${data.run_id}`),
    onError: (err) => setStatusMessage(err instanceof Error ? err.message : "Failed to start run."),
  });

  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveMutation = useMutation({
    mutationFn: () => isNew
      ? api.createWorkflow(token, { name: workflowName || "Untitled Workflow", description: workflowDescription, graph: { nodes, edges } })
      : api.updateWorkflow(token, workflowId, { name: workflowName, description: workflowDescription, graph: { nodes, edges } }),
    onSuccess: (wf) => {
      setStatusMessage(`Saved "${wf.name}" at ${new Date().toLocaleTimeString()}.`);
      setSaveStatus("saved");
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = setTimeout(() => setSaveStatus("idle"), 3000);
      // for new workflows: replace history, and auto-publish as template if requested
      if (isNew) {
        if (publishOnSave) {
          api.publishTemplate(token, wf.id)
            .then(() => queryClient.invalidateQueries({ queryKey: ["workflows"] }))
            .catch(() => {});
        }
        navigate(`/workflows/${wf.id}/builder`, { replace: true });
      }
    },
    onError: (err) => {
      setStatusMessage(err instanceof Error ? err.message : "Save failed.");
      setSaveStatus("error");
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = setTimeout(() => setSaveStatus("idle"), 4000);
    },
  });

  // ── connections ────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (connection: Connection) => setEdges((cur) => addEdge({ ...connection, style: { stroke: "#9ca3af", strokeWidth: 1 } }, cur)),
    [setEdges],
  );

  // ── node click → inspector ─────────────────────────────────────────────────
  const onNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    setSelectedNodeId(node.id);
    setActiveTab("agent");
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
  }, []);

  // ── inspector writes back to node data ─────────────────────────────────────
  const onNodeChange = useCallback((updated: Node) => {
    setNodes((cur) => cur.map((n) => (n.id === updated.id ? updated : n)));
  }, [setNodes]);

  // ── keyboard delete ────────────────────────────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      const selectedNodes = nodes.filter((n) => n.selected);
      const selectedEdges = edges.filter((ed) => ed.selected);
      if (selectedNodes.length || selectedEdges.length) {
        deleteElements({ nodes: selectedNodes, edges: selectedEdges });
        if (selectedNodeId && selectedNodes.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null);
      }
    },
    [nodes, edges, deleteElements, selectedNodeId],
  );

  // ── palette drag ───────────────────────────────────────────────────────────
  const onDragStart = (e: React.DragEvent, nodeType: string, label: string) => {
    e.dataTransfer.setData("application/specter-node-type", nodeType);
    e.dataTransfer.setData("application/specter-node-label", label);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const nodeType = e.dataTransfer.getData("application/specter-node-type");
      const label = e.dataTransfer.getData("application/specter-node-label");
      if (!nodeType || !nodeTypes[nodeType as keyof typeof nodeTypes]) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `${nodeType}-${++nodeCounter}`;
      const newNode: Node = {
        id,
        type: nodeType,
        position,
        data: { ...nodeDefaults[nodeType], label },
      };
      setNodes((cur) => [...cur, newNode]);
      setSelectedNodeId(id);
      setActiveTab("agent");
      setStatusMessage(`Added "${label}" — configure it in the Agent panel.`);
    },
    [screenToFlowPosition, setNodes],
  );

  // ── load template into canvas ─────────────────────────────────────────────
  const loadTemplate = (tpl: { graph?: { nodes?: unknown[]; edges?: unknown[] }; name: string; description: string }) => {
    const g = normalizeGraph(tpl.graph as Partial<WorkflowGraph>);
    setNodes(g.nodes);
    setEdges(g.edges);
    graphLoadedRef.current = true;
    setStatusMessage(`Template "${tpl.name}" loaded. Customise the nodes, then save.`);
    setTemplateMenuOpen(false);
  };

  // ── delete selected via toolbar button ────────────────────────────────────
  const deleteSelected = useCallback(() => {
    const selNodes = nodes.filter((n) => n.selected);
    const selEdges = edges.filter((ed) => ed.selected);
    deleteElements({ nodes: selNodes, edges: selEdges });
    if (selectedNodeId && selNodes.some((n) => n.id === selectedNodeId)) setSelectedNodeId(null);
  }, [nodes, edges, deleteElements, selectedNodeId]);

  const saveGraph = () => {
    if (!isNew) {
      try { localStorage.setItem(storageKey(workflowId), JSON.stringify({ nodes, edges })); } catch { /* ignore */ }
    }
    if (!canUseBackend) {
      setStatusMessage(`Saved to browser storage at ${new Date().toLocaleTimeString()}.`);
      return;
    }
    saveMutation.mutate();
  };

  // ── derived state ──────────────────────────────────────────────────────────
  const activeWorkspaces = workspacesQuery.data?.filter((w) => w.is_active) ?? [];
  const selectedWorkspace = activeWorkspaces.find((w) => w.id === selectedWorkspaceId);
  const runtimeStatus = runtimeStatusQuery.data;
  const runtimeReady = runtimeStatus?.status === "ready" || Boolean(runtimeStatus?.available && runtimeStatus?.installed);
  const executionReady = runtimeReady && Boolean(selectedWorkspace);
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const hasSelection = nodes.some((n) => n.selected) || edges.some((e) => e.selected);
  const mcpServers: McpServer[] = mcpQuery.data?.servers ?? [];
  const allSkills = skillsQuery.data ?? [];

  return (
    <div className="flex h-full flex-col" style={MONO} onKeyDown={onKeyDown} tabIndex={-1}>

      {/* ── top bar ── */}
      <div className="flex items-start justify-between gap-4 border-b border-[#e5e7eb] bg-white px-5 py-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="border border-[#e5e7eb] px-1.5 py-[2px] text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]">
              {isNew ? "new · unsaved" : workflowQuery.data?.is_template ? "template" : "editable"}
            </span>
            <span className="border px-1.5 py-[2px] text-[9px] font-semibold uppercase tracking-widest"
              style={executionReady ? { borderColor: "#6ee7b7", color: "#065f46", background: "#ecfdf5" } : { borderColor: "#fcd34d", color: "#92400e", background: "#fffbeb" }}>
              {executionReady ? "ready" : "config required"}
            </span>
            {!canUseBackend && (
              <span className="border border-[#fcd34d] bg-[#fffbeb] px-1.5 py-[2px] text-[9px] font-semibold uppercase tracking-widest text-[#92400e]">
                preview mode
              </span>
            )}
          </div>
          <input
            className="mt-2 block w-full max-w-xl rounded bg-transparent text-[15px] font-semibold text-[#0f1117] outline-none ring-0 transition hover:bg-[#f1f5f9] focus:bg-white focus:px-2 focus:ring-1 focus:ring-indigo-300"
            value={workflowName}
            onChange={(e) => setWorkflowName(e.target.value)}
            onBlur={saveGraph}
            placeholder="Workflow name"
            style={{ border: "none", padding: 0 }}
          />
          <input
            className="mt-0.5 block w-full max-w-2xl rounded bg-transparent text-[11px] leading-relaxed text-[#6b7280] outline-none ring-0 transition hover:bg-[#f1f5f9] focus:bg-white focus:px-2 focus:ring-1 focus:ring-indigo-300"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            onBlur={saveGraph}
            placeholder="Add a description…"
            style={{ border: "none", padding: 0 }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {hasSelection && (
            <Button onClick={deleteSelected} variant="outline"
              className="h-8 rounded-none border-[#fca5a5] bg-white px-3 text-[11px] font-medium text-[#dc2626] hover:bg-[#fef2f2]" style={MONO}>
              <Trash2 className="mr-1.5 h-3 w-3" /> Delete
            </Button>
          )}
          {/* ── template picker dropdown ── */}
          {templatesList.length > 0 && (
            <div style={{ position: "relative" }}>
              <Button
                variant="outline"
                onClick={() => setTemplateMenuOpen((v) => !v)}
                className="h-8 rounded-none border-[#d1d5db] bg-white px-3 text-[11px] font-medium text-[#374151] hover:bg-[#f9fafb]"
                style={MONO}
              >
                <Copy className="mr-1.5 h-3 w-3" />
                Use template
                <ChevronDown className="ml-1.5 h-3 w-3" />
              </Button>
              {templateMenuOpen && (
                <div style={{
                  position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 50,
                  background: "white", border: "1px solid #e2e8f0", borderRadius: 10,
                  boxShadow: "0 8px 30px rgba(0,0,0,0.12)", minWidth: 240, overflow: "hidden",
                }}>
                  <p style={{ padding: "8px 12px 4px", fontSize: 9, fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
                    Available templates
                  </p>
                  {templatesList.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => loadTemplate(tpl)}
                      style={{
                        display: "block", width: "100%", textAlign: "left",
                        padding: "8px 12px", fontSize: 12, color: "#0f172a",
                        background: "none", border: "none", cursor: "pointer",
                        borderTop: "1px solid #f8fafc",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f0f4ff")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
                    >
                      <span style={{ fontWeight: 600 }}>{tpl.name}</span>
                      {tpl.description && (
                        <span style={{ display: "block", fontSize: 10, color: "#94a3b8", marginTop: 1 }}>{tpl.description.slice(0, 70)}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <Button onClick={saveGraph} disabled={saveMutation.isPending} variant="outline"
            className={`h-8 rounded-none px-3 text-[11px] font-medium transition-colors ${
              saveStatus === "saved" ? "border-[#6ee7b7] bg-[#ecfdf5] text-[#065f46]" :
              saveStatus === "error" ? "border-[#fca5a5] bg-[#fef2f2] text-[#dc2626]" :
              "border-[#d1d5db] bg-white text-[#374151] hover:bg-[#f9fafb]"
            }`} style={MONO}>
            {saveMutation.isPending
              ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              : saveStatus === "saved" ? <CheckCircle2 className="mr-1.5 h-3 w-3" />
              : <Save className="mr-1.5 h-3 w-3" />}
            {saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Save failed" : "Save graph"}
          </Button>
          <Button
            disabled={isNew || !executionReady || runMutation.isPending}
            onClick={() => runMutation.mutate()}
            className="h-8 rounded-none bg-[#0f1117] px-3 text-[11px] font-medium text-white hover:bg-[#1f2937] disabled:opacity-40" style={MONO}
            title={isNew ? "Save the workflow first before running" : undefined}>
            {runMutation.isPending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Play className="mr-1.5 h-3 w-3" />}
            Run workflow
          </Button>
          <Button
            onClick={() => navigate("/runs")}
            variant="outline"
            className="h-8 rounded-none border-[#d1d5db] px-3 text-[11px] font-medium text-[#6b7280] hover:bg-[#f9fafb]" style={MONO}>
            <History className="mr-1.5 h-3 w-3" />
            Run history
          </Button>
        </div>
      </div>

      {/* ── status strip ── */}
      <div className="flex items-center justify-between border-b border-[#e5e7eb] bg-[#fafafa] px-5 py-1.5">
        <p className="text-[10px] text-[#6b7280]" style={MONO}>{statusMessage}</p>
        <p className="shrink-0 text-[9px] text-[#9ca3af]" style={MONO}>changes auto-saved locally · click Save graph to push to DB</p>
      </div>

      {/* ── three-column layout ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* ── palette ── */}
        <div
          className="relative shrink-0 border-r border-[#e5e7eb] bg-white transition-all duration-200 overflow-hidden"
          style={{ width: paletteCollapsed ? 28 : 156 }}
        >
          {/* collapse toggle */}
          <button
            onClick={() => setPaletteCollapsed((v) => !v)}
            title={paletteCollapsed ? "Expand palette" : "Collapse palette"}
            className="absolute -right-3 top-4 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-[#e5e7eb] bg-white shadow-sm text-[#9ca3af] hover:text-[#374151]"
          >
            {paletteCollapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
          </button>

          {!paletteCollapsed && (
            <>
              <div className="border-b border-[#e5e7eb] px-3 py-2">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]" style={MONO}>Palette</p>
                <p className="text-[9px] text-[#9ca3af]" style={MONO}>Drag to canvas</p>
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
                {palette.map((group) => (
                  <div key={group.category} className="border-b border-[#f3f4f6] last:border-b-0">
                    <p className="px-3 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>
                      {group.category}
                    </p>
                    {group.items.map(({ icon: Icon, label, nodeType }) => (
                      <div
                        key={label}
                        draggable
                        onDragStart={(e) => onDragStart(e, nodeType, label)}
                        className="flex cursor-grab items-center gap-1.5 px-3 py-1.5 text-[10px] text-[#374151] hover:bg-[#f9fafb] active:cursor-grabbing select-none"
                        style={MONO}
                      >
                        <Icon className="h-3 w-3 shrink-0 text-[#9ca3af]" />
                        {label}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* ── canvas ── */}
        <div
          ref={canvasRef}
          className="flex-1 overflow-hidden border-r border-[#e5e7eb] bg-[#f9fafb]"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
            onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
            onConnect={onConnect}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={fitViewOptions}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
            defaultEdgeOptions={{ style: { stroke: "#9ca3af", strokeWidth: 1 } }}
          >
            <Background color="#d1d5db" gap={24} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={0}
              style={{ background: "#f9fafb", border: "1px solid #e5e7eb" }}
              className="!rounded-none" />
            <Controls className="!rounded-none !border !border-[#e5e7eb] !bg-white [&>button]:!rounded-none [&>button]:!border-[#e5e7eb]" />
          </ReactFlow>
        </div>

        {/* ── right panel ── */}
        <div
          className="relative shrink-0 border-l border-[#e5e7eb] bg-white transition-all duration-200 overflow-hidden"
          style={{ width: rightCollapsed ? 28 : 260 }}
        >
          {/* collapse toggle */}
          <button
            onClick={() => setRightCollapsed((v) => !v)}
            title={rightCollapsed ? "Expand panel" : "Collapse panel"}
            className="absolute -left-3 top-4 z-20 flex h-6 w-6 items-center justify-center rounded-full border border-[#e5e7eb] bg-white shadow-sm text-[#9ca3af] hover:text-[#374151]"
          >
            {rightCollapsed ? <ChevronLeft className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        {!rightCollapsed && <div className="overflow-y-auto h-full">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid h-7 w-full grid-cols-4 rounded-none border-b border-[#e5e7eb] bg-white p-0" style={MONO}>
              {["context", "agent", "run", "memory"].map((tab) => (
                <TabsTrigger key={tab} value={tab}
                  className="h-full rounded-none border-r border-[#e5e7eb] text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af] last:border-r-0 data-[state=active]:bg-[#f9fafb] data-[state=active]:text-[#0f1117] data-[state=active]:shadow-none"
                  style={MONO}>
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Context */}
            <TabsContent value="context" className="mt-0 divide-y divide-[#f3f4f6]">

              {/* Runtime block */}
              <div className="px-4 py-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>Execution runtime</p>
                  <span className="border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-widest"
                    style={{ borderColor: runtimeReady ? "#6ee7b7" : "#fcd34d", color: runtimeReady ? "#065f46" : "#92400e", background: runtimeReady ? "#ecfdf5" : "#fffbeb", ...MONO }}>
                    {runtimeStatus?.status ?? "unknown"}
                  </span>
                </div>
                <div className="divide-y divide-[#f3f4f6] border border-[#e5e7eb]">
                  <DataRow label="runtime" value={runtimeStatus?.display_name ?? "Codex CLI Runtime"} />
                  <DataRow label="version" value={runtimeStatus?.version ?? runtimeStatus?.current_version ?? "—"} />
                  <DataRow label="mode" value={runtimeStatus?.runner_mode ?? "safe"} />
                </div>
              </div>

              {/* Repository block */}
              <div className="px-4 py-3">
                <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>Approved repository</p>
                <select
                  className="w-full border border-[#d1d5db] bg-white px-2.5 py-1.5 text-[11px] text-[#374151] outline-none focus:border-[#374151]"
                  style={MONO}
                  value={selectedWorkspaceId}
                  onChange={(e) => handleWorkspaceChange(e.target.value)}
                >
                  {!activeWorkspaces.length && <option value="">No repositories configured</option>}
                  {activeWorkspaces.map((w) => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                  ))}
                </select>
                {selectedWorkspace && (
                  <p className="mt-1.5 break-all text-[10px] leading-relaxed text-[#6b7280]" style={MONO}>{selectedWorkspace.path}</p>
                )}
              </div>

              {/* MCP + Skills summary (per-node — configured in Agent tab) */}
              <div className="px-4 py-3">
                <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>Tools &amp; skills (per node)</p>
                <div className="divide-y divide-[#f3f4f6] border border-[#e5e7eb]">
                  <DataRow label="MCP servers available" value={mcpServers.filter((s) => s.configured && s.enabled).length} />
                  <DataRow label="Skills available" value={allSkills.length} />
                  <DataRow label="Nodes with tools" value={nodes.filter((n) => Array.isArray(n.data.selectedTools) && (n.data.selectedTools as string[]).length > 0).length} />
                  <DataRow label="Nodes with skills" value={nodes.filter((n) => Array.isArray(n.data.selectedSkills) && (n.data.selectedSkills as string[]).length > 0).length} />
                </div>
                <p className="mt-1.5 text-[9px] text-[#9ca3af]" style={MONO}>Click a node → Agent tab to configure its tools and skills.</p>
              </div>

              {/* Run gates block */}
              <div className="px-4 py-3">
                <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>Run gates</p>
                <div className="divide-y divide-[#f3f4f6] border border-[#e5e7eb]">
                  <GateRow label="Runtime ready" ready={runtimeReady} />
                  <GateRow label="Repository approved" ready={Boolean(selectedWorkspace)} />
                  <GateRow label="Safe mode" ready={(runtimeStatus?.runner_mode ?? "safe") === "safe"} />
                  <GateRow label="Human approval node" ready={nodes.some((n) => n.type === "humanApproval")} />
                </div>
              </div>

              {/* Graph stats block */}
              <div className="px-4 py-3">
                <p className="mb-2 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>Graph</p>
                <div className="divide-y divide-[#f3f4f6] border border-[#e5e7eb]">
                  <DataRow label="nodes" value={nodes.length} />
                  <DataRow label="edges" value={edges.length} />
                  <DataRow label="approval gates" value={nodes.filter((n) => n.type === "humanApproval").length} />
                  <DataRow label="memory nodes" value={nodes.filter((n) => n.type === "memory").length} />
                </div>
              </div>
            </TabsContent>

            {/* Agent inspector */}
            <TabsContent value="agent" className="mt-0 p-4">
              <AgentInspector node={selectedNode} onChange={onNodeChange} mcpServers={mcpServers} skills={allSkills} />
            </TabsContent>

            {/* Run timeline */}
            <TabsContent value="run" className="mt-0 p-4">
              <AgentTimeline />
            </TabsContent>

            {/* Memory */}
            <TabsContent value="memory" className="mt-0 p-4">
              <MemoryPanel />
            </TabsContent>
          </Tabs>
        </div>}
        </div>
      </div>
    </div>
  );
}

// ── exported page (wraps with ReactFlowProvider) ─────────────────────────────
export default function WorkflowBuilder() {
  const { workflowId = "security-review-team" } = useParams();
  const [searchParams] = useSearchParams();
  const publishOnSave = searchParams.get("template") === "1";
  const token = getStoredToken() ?? "";
  const canUseBackend = Boolean(token && token !== "preview-mode");

  return (
    <ReactFlowProvider>
      <BuilderInner workflowId={workflowId} token={token} canUseBackend={canUseBackend} publishOnSave={publishOnSave} />
    </ReactFlowProvider>
  );
}
