import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
  AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, Copy, CopyPlus, Database, FileText, GitBranch, GitMerge, History, Layers, LayoutGrid, Loader2, Play, Redo2, Save, Search, Send, ShieldCheck, Sparkles, Trash2, Undo2, Webhook, Zap,
} from "lucide-react";
import type { McpServer } from "@/lib/types";
import { AgentInspector } from "@/components/agents/AgentInspector";
import { ConditionalNode } from "@/components/workflow/nodes/ConditionalNode";
import { HumanApprovalNode } from "@/components/workflow/nodes/HumanApprovalNode";
import { MemoryNode } from "@/components/workflow/nodes/MemoryNode";
import { SpecialistAgentNode } from "@/components/workflow/nodes/SpecialistAgentNode";
import { SupervisorAgentNode } from "@/components/workflow/nodes/SupervisorAgentNode";
import { TriggerNode } from "@/components/workflow/nodes/TriggerNode";
import { WebhookNode } from "@/components/workflow/nodes/WebhookNode";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import { layoutGeneratedSubgraph, topoLayout } from "@/lib/graph-layout";
import { useModelPreference } from "@/lib/model-preference";
import { newNodeId, snapshotOf as snapshotOfGraph, structureOf } from "@/lib/workflow-persistence";
import { canConnect, graphIssues } from "@/lib/graph-validation";
import { btn, nodeAccent } from "@/lib/ui-tokens";
import { canRedo, canUndo, commit as commitHistory, initHistory, redo as redoHistory, undo as undoHistory } from "@/lib/graph-history";
import type { WorkflowGraph } from "@/lib/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";


// ── node type registry ──────────────────────────────────────────────────────
const nodeTypes = {
  trigger: TriggerNode,
  supervisorAgent: SupervisorAgentNode,
  specialistAgent: SpecialistAgentNode,
  humanApproval: HumanApprovalNode,
  memory: MemoryNode,
  conditional: ConditionalNode,
  webhook: WebhookNode,
};

// Node types that run an agent, and so accept a bulk agent/model/runtime edit.
// Keyed on TYPE, not on a data field: nodes from older templates and imports may
// not carry `sandboxAgent` yet, and those are exactly the ones a bulk edit must reach.
const AGENT_NODE_TYPES = new Set(["supervisorAgent", "specialistAgent", "conditional"]);

// id of the seeded "Standard Report Format" skill (backend/app/runtime/skill_seeds.py)
const STANDARD_REPORT_FORMAT_SKILL_ID = "standard-report-format";

// ── default data per node type ──────────────────────────────────────────────
const nodeDefaults: Record<string, Record<string, unknown>> = {
  supervisorAgent: { label: "Supervisor Agent", runtime: "direct", sandboxAgent: "claude", model: "", memoryScope: "team", maxIterations: 1, delegationStrategy: "sequential_delegation", objective: "", systemInstructions: "" },
  specialistAgent: { label: "Specialist Agent", role: "", runtime: "direct", sandboxAgent: "claude", model: "", memoryScope: "workflow", maxIterations: 1, objective: "", systemInstructions: "" },
  humanApproval: { label: "Human Approval", reason: "Requires manual approval before continuing.", timeoutHours: 24 },
  memory: { label: "Write Memory", scope: "workflow" },
  conditional: { label: "Conditional", condition: "", runtime: "direct", sandboxAgent: "claude", model: "" },
  webhook: { label: "Webhook", url: "", method: "POST", payloadTemplate: "" },
  trigger: { label: "Topic", source: "manual", fieldName: "topic", placeholder: "What should this workflow work on?", required: true },
};

// ── presets: same node type as a palette category, but with real pre-filled
// starting data instead of just a different label ──────────────────────────
const presetDefaults: Record<string, Record<string, unknown>> = {
  smartSupervisor: {
    ...nodeDefaults.supervisorAgent,
    objective: "Analyze the objective and repository, break it into the smallest set of independent specialist subtasks, decide which can run in parallel vs must run sequentially, and generate the workflow. Click \"Plan workflow\" below after adjusting this objective.",
    delegationStrategy: "parallel_delegation",
  },
  reportWriter: {
    ...nodeDefaults.specialistAgent,
    role: "Report writer",
    objective: "Aggregate the findings from all prior agents in this workflow into one report.",
    selectedSkills: [STANDARD_REPORT_FORMAT_SKILL_ID],
    memoryScope: "workflow",
  },
  telegramTrigger: {
    ...nodeDefaults.trigger,
    label: "Message",
    source: "telegram",
    placeholder: "Sent from Telegram",
  },
  aggregator: {
    ...nodeDefaults.specialistAgent,
    role: "Aggregator",
    objective: "Combine the outputs of the parallel branches feeding into this node into a single, de-duplicated summary. Note any conflicts or disagreements between branches explicitly.",
    memoryScope: "workflow",
  },
};

// ── palette definition ──────────────────────────────────────────────────────
const palette: { category: string; items: { icon: typeof Bot; label: string; nodeType: string; presetKey?: string; description: string }[] }[] = [
  {
    category: "Agents",
    items: [
      { icon: ShieldCheck, label: "Generic Supervisor", nodeType: "supervisorAgent", description: "Coordinates specialists you wire up yourself" },
      { icon: Sparkles, label: "Smart Supervisor", nodeType: "supervisorAgent", presetKey: "smartSupervisor", description: "Plans a specialist workflow from an objective" },
      { icon: Bot, label: "Specialist Agent", nodeType: "specialistAgent", description: "Runs one focused task in the sandbox" },
      { icon: FileText, label: "Report Writer", nodeType: "specialistAgent", presetKey: "reportWriter", description: "Aggregates prior findings into a report" },
      { icon: GitMerge, label: "Aggregator", nodeType: "specialistAgent", presetKey: "aggregator", description: "Merges parallel branches into one summary" },
    ],
  },
  {
    category: "Triggers",
    items: [
      { icon: Zap, label: "Manual Trigger", nodeType: "trigger", description: "Supplies a value you enter when the run starts" },
      { icon: Send, label: "Telegram Trigger", nodeType: "trigger", presetKey: "telegramTrigger", description: "Starts this workflow from an allowlisted chat message" },
    ],
  },
  {
    category: "Control Flow",
    items: [
      { icon: CheckCircle2, label: "Human Approval", nodeType: "humanApproval", description: "Pauses the run until a human approves" },
      { icon: GitBranch, label: "Conditional", nodeType: "conditional", description: "Branches the flow on a true/false check" },
    ],
  },
  {
    category: "Memory",
    items: [
      { icon: Database, label: "Write Memory", nodeType: "memory", description: "Persists a summary to workflow memory" },
    ],
  },
  {
    category: "Notifications",
    items: [
      { icon: Webhook, label: "Webhook", nodeType: "webhook", description: "Notifies an external URL when reached" },
    ],
  },
];

// ── conditional edge labels ──────────────────────────────────────────────────
// Edges leaving a Conditional node's "true"/"false" handles get a colored label
// so the branch semantics are visible on the canvas, not just at the handles.
function withConditionLabel<T extends Edge | Connection>(edge: T): T {
  const handle = (edge as Edge).sourceHandle;
  if (handle !== "true" && handle !== "false") return edge;
  const isTrue = handle === "true";
  return {
    ...edge,
    label: handle,
    labelStyle: { fill: isTrue ? "#059669" : "#dc2626", fontSize: 9, fontWeight: 700 },
    labelBgStyle: { fill: isTrue ? "#ecfdf5" : "#fef2f2" },
    labelBgPadding: [3, 2] as [number, number],
    labelBgBorderRadius: 2,
  } as T;
}

// ── normalizer ───────────────────────────────────────────────────────────────
function normalizeGraph(graph?: Partial<WorkflowGraph>): { nodes: Node[]; edges: Edge[] } {
  // Empty stays empty. Substituting the seed template here made a blank workflow
  // look like the security-review sample, which autosave then made permanent.
  if (!Array.isArray(graph?.nodes) || graph.nodes.length === 0) return { nodes: [], edges: [] };
  const nodes = (graph.nodes as (Partial<Node> & Record<string, unknown>)[]).map((raw, i) => ({
    id: String(raw.id ?? `node-${i}`),
    type: String(raw.type ?? "specialistAgent"),
    position: (raw.position as { x: number; y: number }) ?? { x: 100 + i * 240, y: 120 },
    data: (raw.data ?? {}) as Record<string, unknown>,
  })) as Node[];
  const edges = ((Array.isArray(graph?.edges) ? graph.edges : []) as Edge[]).map(withConditionLabel);
  return { nodes, edges };
}

function storageKey(id: string) { return `sdlc_workflow_graph_v5_${id}`; }

// ── small presentational helpers ─────────────────────────────────────────────
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-[#6b7280]">{children}</p>;
}
function DataRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[#f3f4f6] py-1.5 last:border-b-0">
      <span className="text-[10px] text-[#9ca3af]">{label}</span>
      <span className="text-[10px] font-medium text-[#111827]">{value}</span>
    </div>
  );
}
function GateDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[10px] text-[#6b7280]" title={ok ? `${label}: ready` : `${label}: required`}>
      <span className="block h-1.5 w-1.5 rounded-full" style={{ background: ok ? "#10b981" : "#f59e0b" }} />
      {label}
    </span>
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
  const { screenToFlowPosition, deleteElements, fitView } = useReactFlow();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  // Start empty, never with the seed template: a placeholder graph on the canvas
  // is indistinguishable from real content and autosave will persist it.
  const [nodes, setNodes, onNodesChange] = useNodesState([] as Node[]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([] as Edge[]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("agent");
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Never seed a fake name: autosave would persist it over the real one.
  const [workflowName, setWorkflowName] = useState("");
  // True once the graph, name and description have all loaded.
  const [baselined, setBaselined] = useState(false);

  const [workflowDescription, setWorkflowDescription] = useState(isNew ? "" : "");
  const [nameTouched, setNameTouched] = useState(false);
  const [statusMessage, setStatusMessage] = useState(isNew ? "New workflow — drag nodes from the palette to get started." : "Drag from the palette to add nodes.");
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [rightWidth, setRightWidth] = useState(300);
  const rightDragging = useRef(false);
  const rightStartX = useRef(0);
  const rightStartW = useRef(0);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!rightDragging.current) return;
      const delta = rightStartX.current - e.clientX;
      setRightWidth(Math.max(280, Math.min(520, rightStartW.current + delta)));
    };
    const onUp = () => { rightDragging.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(() => {
    try { return localStorage.getItem(`specter_workspace_${workflowId}`) ?? ""; } catch { return ""; }
  });
  const [autoSaveDb, setAutoSaveDb] = useState(() => {
    try { return localStorage.getItem("specter_autosave_db") === "1"; } catch { return false; }
  });
  const fitViewOptions = useMemo(() => ({ padding: 0.2 }), []);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoSaveDbTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphLoadedRef = useRef(false);
  const draftRestoredRef = useRef(false);

  // Fingerprint of the last state known to be on the server. `saveStatus` can't
  // serve as a dirty flag -- it self-clears after 3s -- so compare against this.
  const savedSnapshot = useRef<string>("");
  const snapshotOf = useCallback(snapshotOfGraph, []);

  const toggleAutoSaveDb = () => {
    setAutoSaveDb((v) => {
      const next = !v;
      try { localStorage.setItem("specter_autosave_db", next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  };

  const workspacesQuery = useQuery({ queryKey: ["runtime-workspaces"], queryFn: () => api.runtimeWorkspaces(token), enabled: canUseBackend, retry: false });
  const skillsQuery = useQuery({ queryKey: ["skills"], queryFn: () => api.skills(token), enabled: canUseBackend, retry: false });
  const mcpQuery = useQuery({ queryKey: ["mcp-list"], queryFn: () => api.mcpList(token), enabled: canUseBackend, retry: false });
  const workflowQuery = useQuery({ queryKey: ["workflow", workflowId], queryFn: () => api.workflow(token, workflowId), enabled: canUseBackend && !isNew, retry: false });
  const allWorkflowsQuery = useQuery({ queryKey: ["workflows"], queryFn: () => api.workflows(token), enabled: canUseBackend, retry: false });
  const templatesList = (allWorkflowsQuery.data ?? []).filter((w) => w.is_template);
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [bulkMenuOpen, setBulkMenuOpen] = useState(false);
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [runInput, setRunInput] = useState<Record<string, string>>({});
  const [modelPreference] = useModelPreference();

  // ── load: localStorage wins over DB (local edits survive refresh) ──────────
  useEffect(() => {
    if (isNew || graphLoadedRef.current) return;
    const saved = localStorage.getItem(storageKey(workflowId));
    if (saved) {
      try {
        const g = normalizeGraph(JSON.parse(saved));
        setNodes(g.nodes); setEdges(g.edges);
        setStatusMessage("Draft restored — save to publish your latest edits.");
        graphLoadedRef.current = true;
        // Baseline against the restored draft. It may differ from the server, but
        // it is what the user last saw -- treating it as dirty on arrival would
        // prompt on every navigation away from an untouched canvas.
        draftRestoredRef.current = true;
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
    if (!workflowQuery.data) return;
    // Name and description always come from the server: the localStorage draft
    // only holds {nodes, edges}, so a restored draft would otherwise leave these
    // blank and a save would wipe them.
    setWorkflowName((cur) => cur || workflowQuery.data.name);
    setWorkflowDescription((cur) => cur || workflowQuery.data.description);
    // Server copy is the source of truth for the repo; localStorage is only a cache.
    const savedPath = workflowQuery.data.workspace_path;
    if (savedPath) {
      const match = (workspacesQuery.data ?? []).find((w) => w.path === savedPath && w.is_active);
      if (match) setSelectedWorkspaceId((cur) => cur || match.id);
    }
    if (graphLoadedRef.current) return;
    const g = normalizeGraph(workflowQuery.data.graph);
    setNodes(g.nodes); setEdges(g.edges);
    setStatusMessage(`Loaded "${workflowQuery.data.name}".`);
    graphLoadedRef.current = true;
    // Freshly loaded from the server = clean. (A restored localStorage draft is
    // deliberately NOT baselined -- it represents edits that never reached the DB.)
    savedSnapshot.current = snapshotOf(
      g.nodes, g.edges, workflowQuery.data.name, workflowQuery.data.description,
    );
  }, [setEdges, setNodes, workflowQuery.data, workspacesQuery.data, snapshotOf]);

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
    mutationFn: (runInput: Record<string, string> = {}) => {
      if (!selectedWorkspace) throw new Error("No workspace selected.");
      return api.startRun(token, {
        workflow_id: workflowId,
        workspace_path: selectedWorkspace.path,
        graph: { nodes, edges },
        run_input: runInput,
      });
    },
    onSuccess: (data) => navigate(`/workflows/${workflowId}/run/${data.run_id}`, { state: { from: `/workflows/${workflowId}/builder` } }),
    onError: (err) => setStatusMessage(err instanceof Error ? err.message : "Failed to start run."),
  });

  const [saveStatus, setSaveStatus] = useState<"idle" | "saved" | "error">("idle");
  const saveStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);


  const saveMutation = useMutation({
    mutationFn: (graphOverride?: { nodes: Node[]; edges: Edge[] }) => {
      const graph = graphOverride ?? { nodes, edges };
      // The snapshot is recorded in onSuccess, not here: with two saves in flight
      // a late failure would otherwise blank a snapshot belonging to a save that
      // actually succeeded, leaving a saved workflow permanently marked dirty.
      return isNew
        // workspace_path travels with the workflow: a trigger-started run has no
        // dropdown to read, so the server copy is the only thing it can use.
        ? api.createWorkflow(token, { name: workflowName || "Untitled Workflow", description: workflowDescription, graph, workspace_path: selectedWorkspace?.path })
        : api.updateWorkflow(token, workflowId, { name: workflowName, description: workflowDescription, graph, workspace_path: selectedWorkspace?.path });
    },
    onSuccess: (wf, graphOverride) => {
      const g = graphOverride ?? { nodes, edges };
      savedSnapshot.current = snapshotOf(g.nodes, g.edges, wf.name, wf.description);
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
      // No snapshot to roll back -- it is only written on success now.
      setStatusMessage(err instanceof Error ? err.message : "Save failed.");
      setSaveStatus("error");
      if (saveStatusTimer.current) clearTimeout(saveStatusTimer.current);
      saveStatusTimer.current = setTimeout(() => setSaveStatus("idle"), 4000);
    },
  });

  // ── auto-save to database 2.5s after any change, when enabled ─────────────
  useEffect(() => {
    // `baselined` (not graphLoadedRef) is the real "fully loaded" signal: a
    // restored draft sets graphLoadedRef before the server name/description
    // arrive, and autosaving then writes placeholder values over real data.
    if (isNew || !autoSaveDb || !baselined || !canUseBackend || !workflowName.trim()) return;
    if (autoSaveDbTimer.current) clearTimeout(autoSaveDbTimer.current);
    autoSaveDbTimer.current = setTimeout(() => {
      if (!saveMutation.isPending) saveMutation.mutate(undefined);
    }, 2500);
    return () => { if (autoSaveDbTimer.current) clearTimeout(autoSaveDbTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, workflowName, workflowDescription, isNew, autoSaveDb, canUseBackend]);

  // ── smart supervisor planning ──────────────────────────────────────────────
  // Reverse-map the generated subgraph back into the planner's plan schema so
  // refinement prompts can reference the current plan without storing extra state.
  const buildCurrentPlan = (sup: Node): Record<string, unknown> | null => {
    const genNodes = nodes.filter((n) => (n.data as Record<string, unknown>)?.generatedBy === sup.id);
    const specialists = genNodes.filter((n) => n.type === "specialistAgent");
    if (!specialists.length) return null;
    const prefix = `gen-${sup.id}-`;
    const taskIdOf = (nodeId: string) => (nodeId.startsWith(prefix) ? nodeId.slice(prefix.length) : nodeId);
    const specialistIds = new Set(specialists.map((n) => n.id));
    const subtasks = specialists.map((n) => {
      const d = n.data as Record<string, unknown>;
      return {
        id: taskIdOf(n.id),
        label: String(d.label ?? ""),
        role: String(d.role ?? ""),
        objective: String(d.objective ?? ""),
        depends_on: edges.filter((e) => e.target === n.id && specialistIds.has(e.source)).map((e) => taskIdOf(e.source)),
      };
    });
    const gateNode = genNodes.find((n) => n.type === "humanApproval");
    const memoryNode = genNodes.find((n) => n.type === "memory");
    return {
      subtasks,
      approval_gate: gateNode
        ? {
            needed: true,
            reason: String((gateNode.data as Record<string, unknown>)?.reason ?? ""),
            after_task_ids: edges.filter((e) => e.target === gateNode.id && specialistIds.has(e.source)).map((e) => taskIdOf(e.source)),
          }
        : { needed: false },
      memory_synthesis: memoryNode
        ? { needed: true, label: String((memoryNode.data as Record<string, unknown>)?.label ?? "") }
        : { needed: false },
    };
  };

  const revealTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => { revealTimers.current.forEach(clearTimeout); }, []);

  const setSupervisorPlanning = (supId: string, planning: boolean) => {
    setNodes((cur) => cur.map((n) => (n.id === supId ? { ...n, data: { ...n.data, isPlanning: planning } } : n)));
  };

  const planMutation = useMutation({
    mutationFn: ({ sup, feedback }: { sup: Node; feedback?: string }) => {
      if (!selectedWorkspace) throw new Error("Select an approved repository first — the planner inspects it to ground the plan.");
      const d = sup.data as Record<string, unknown>;
      setSupervisorPlanning(sup.id, true);
      return api.planWorkflow(token, {
        objective: String(d.objective ?? ""),
        supervisor_node_id: sup.id,
        runtime: String(d.runtime ?? "sandbox"),
        agent: String(d.sandboxAgent ?? d.agent ?? "claude"),
        workspace_path: selectedWorkspace.path,
        system_instructions: String(d.systemInstructions ?? ""),
        current_plan: feedback ? buildCurrentPlan(sup) : null,
        feedback: feedback ?? "",
      });
    },
    onSuccess: (graph, { sup }) => {
      const genNodes = (graph.nodes ?? []) as Node[];
      const genEdges = ((graph.edges ?? []) as Edge[]).map(withConditionLabel);
      if (!genNodes.length) {
        setSupervisorPlanning(sup.id, false);
        setStatusMessage("Planner returned no sub-agents — try refining the objective.");
        return;
      }
      const removedIds = new Set(nodes.filter((n) => (n.data as Record<string, unknown>)?.generatedBy === sup.id).map((n) => n.id));
      const keptNodes = nodes.filter((n) => !removedIds.has(n.id));
      const keptEdges = edges.filter(
        (e) => !removedIds.has(e.source) && !removedIds.has(e.target) && (e.data as Record<string, unknown>)?.generatedBy !== sup.id,
      );
      const mergedEdges = [...keptEdges, ...genEdges];
      const anchor = keptNodes.find((n) => n.id === sup.id) ?? sup;
      const laidOutGenNodes = layoutGeneratedSubgraph([...keptNodes, ...genNodes], mergedEdges, anchor)
        .filter((n) => genNodes.some((g) => g.id === n.id));
      const finalNodes = [...keptNodes.map((n) => (n.id === sup.id ? { ...n, data: { ...n.data, isPlanning: false } } : n)), ...laidOutGenNodes];

      // reveal generated nodes one at a time for a "materializing" feel
      revealTimers.current.forEach(clearTimeout);
      revealTimers.current = [];
      setNodes([...keptNodes.map((n) => (n.id === sup.id ? { ...n, data: { ...n.data, isPlanning: false } } : n))]);
      setEdges([]);
      laidOutGenNodes.forEach((genNode, i) => {
        const timer = setTimeout(() => {
          setNodes((cur) => (cur.some((n) => n.id === genNode.id) ? cur : [...cur, { ...genNode, className: "specter-node-materialize" }]));
          const incomingEdges = mergedEdges.filter((e) => e.target === genNode.id);
          setEdges((cur) => [...cur, ...incomingEdges.filter((e) => !cur.some((c) => c.id === e.id))]);
        }, i * 220);
        revealTimers.current.push(timer);
      });
      const finalizeTimer = setTimeout(() => {
        // Merge rather than replace. The canvas stays interactive for the whole
        // ~2.8s reveal, so assigning the pre-computed array here discarded any
        // edit the user made during it -- and then saved the discard.
        let saved: { nodes: Node[]; edges: Edge[] } = { nodes: finalNodes, edges: mergedEdges };
        setNodes((cur) => {
          const byId = new Map(cur.map((n) => [n.id, n]));
          // Generated nodes the user has not touched take the final layout;
          // anything already on the canvas keeps the user's version.
          const merged = finalNodes.map((n) => byId.get(n.id) ?? n);
          const extras = cur.filter((n) => !finalNodes.some((f) => f.id === n.id));
          saved.nodes = [...merged, ...extras];
          return saved.nodes;
        });
        setEdges((cur) => {
          const extras = cur.filter((e) => !mergedEdges.some((m) => m.id === e.id));
          saved.edges = [...mergedEdges, ...extras];
          return saved.edges;
        });
        const specialistCount = genNodes.filter((n) => n.type === "specialistAgent").length;
        setStatusMessage(`Generated ${specialistCount} specialist agents — review before running. Saving…`);
        saveMutation.mutate(saved);
      }, laidOutGenNodes.length * 220 + 150);
      revealTimers.current.push(finalizeTimer);
    },
    onError: (err, { sup }) => {
      setSupervisorPlanning(sup.id, false);
      setStatusMessage(err instanceof Error ? err.message : "Planning failed.");
    },
  });

  const tuneNodeMutation = useMutation({
    mutationFn: ({ node, instruction }: { node: Node; instruction: string }) => {
      if (!selectedWorkspace) throw new Error("Select an approved repository first.");
      const d = node.data as Record<string, unknown>;
      return api.tuneNode(token, {
        node_data: {
          label: String(d.label ?? ""),
          role: String(d.role ?? ""),
          objective: String(d.objective ?? ""),
          systemInstructions: String(d.systemInstructions ?? ""),
        },
        instruction,
        runtime: String(d.runtime ?? "sandbox"),
        agent: String(d.sandboxAgent ?? d.agent ?? "claude"),
        workspace_path: selectedWorkspace.path,
      });
    },
    onSuccess: (updated, { node }) => {
      setNodes((cur) => cur.map((n) => (n.id === node.id ? { ...n, data: { ...n.data, ...updated } } : n)));
      setStatusMessage(`Node "${updated.label}" tuned — review the updated config.`);
    },
    onError: (err) => setStatusMessage(err instanceof Error ? err.message : "Tuning failed."),
  });

  // ── connections ────────────────────────────────────────────────────────────
  const onConnect = useCallback(
    (connection: Connection) => setEdges((cur) => addEdge(withConditionLabel({ ...connection, style: { stroke: "#9ca3af", strokeWidth: 1 } }), cur)),
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
  // Deliberately immediate (no confirm) — standard canvas UX; the toolbar
  // Delete button carries the confirmation for accidental clicks instead.
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
  const onDragStart = (e: React.DragEvent, nodeType: string, label: string, presetKey?: string) => {
    e.dataTransfer.setData("application/specter-node-type", nodeType);
    e.dataTransfer.setData("application/specter-node-label", label);
    e.dataTransfer.setData("application/specter-node-preset", presetKey ?? "");
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
      const presetKey = e.dataTransfer.getData("application/specter-node-preset");
      if (!nodeType || !nodeTypes[nodeType as keyof typeof nodeTypes]) return;
      const position = screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = newNodeId(nodeType);
      const baseDefaults = (presetKey && presetDefaults[presetKey]) || nodeDefaults[nodeType];
      // Node types that actually run an agent inherit the header's default
      // agent/model; control-flow and memory nodes have no model to set.
      const inheritsModel = "sandboxAgent" in baseDefaults;
      const newNode: Node = {
        id,
        type: nodeType,
        position,
        data: {
          ...baseDefaults,
          label,
          ...(inheritsModel
            ? { sandboxAgent: modelPreference.agent, model: modelPreference.model }
            : {}),
        },
      };
      setNodes((cur) => [...cur, newNode]);
      setSelectedNodeId(id);
      setActiveTab("agent");
      setStatusMessage(`Added "${label}" — configure it in the Agent panel.`);
    },
    [screenToFlowPosition, setNodes, modelPreference],
  );

  // ── load template into canvas ─────────────────────────────────────────────
  // Undo/redo. History is committed from an effect rather than at every call
  // site so it cannot be forgotten; drags coalesce into one entry.
  const history = useRef(initHistory({ nodes: [], edges: [] }));
  const [historyTick, setHistoryTick] = useState(0);
  const applyingHistory = useRef(false);
  useEffect(() => {
    if (!baselined) return;                 // ignore the load-phase churn
    if (applyingHistory.current) { applyingHistory.current = false; return; }
    const before = history.current;
    history.current = commitHistory(before, { nodes, edges }, true);
    if (history.current !== before) setHistoryTick((t) => t + 1);
  }, [nodes, edges, baselined]);

  const applySnapshot = useCallback((h: typeof history.current) => {
    applyingHistory.current = true;
    history.current = h;
    setNodes(h.present.nodes);
    setEdges(h.present.edges);
    setHistoryTick((t) => t + 1);
  }, [setNodes, setEdges]);

  // Click-to-add. The palette was drag-only, so every node type in the app was
  // behind a mouse gesture and unreachable by keyboard.
  const addNodeFromPalette = useCallback((nodeType: string, label: string, presetKey?: string) => {
    const baseDefaults = (presetKey && presetDefaults[presetKey]) || nodeDefaults[nodeType];
    // Same rule as the drop handler: only agent-bearing nodes inherit the
    // header's model preference; control-flow and memory nodes have no model.
    const inheritsModel = "sandboxAgent" in baseDefaults;
    const id = newNodeId(nodeType);
    setNodes((cur) => {
      // Place right of the furthest-right node so a new one never lands on top.
      const x = cur.length ? Math.max(...cur.map((n) => n.position.x)) + 280 : 120;
      const y = cur.length ? cur[cur.length - 1].position.y : 160;
      return [
        ...cur.map((n) => ({ ...n, selected: false })),
        {
          id, type: nodeType, position: { x, y }, selected: true,
          data: {
            ...baseDefaults,
            label,
            ...(inheritsModel
              ? { sandboxAgent: modelPreference.agent, model: modelPreference.model }
              : {}),
          },
        } as Node,
      ];
    });
    setStatusMessage(`Added ${label}.`);
  }, [setNodes, modelPreference]);

  const duplicateSelection = useCallback(() => {
    setNodes((cur) => {
      const chosen = cur.filter((n) => n.selected);
      if (!chosen.length) return cur;
      const copies = chosen.map((n) => ({
        ...n,
        id: newNodeId(String(n.type)),
        position: { x: n.position.x + 40, y: n.position.y + 40 },
        selected: true,
        data: { ...(n.data as Record<string, unknown>) },
      }));
      return [...cur.map((n) => ({ ...n, selected: false })), ...copies];
    });
  }, [setNodes]);

  const doUndo = useCallback(() => {
    if (canUndo(history.current)) applySnapshot(undoHistory(history.current));
  }, [applySnapshot]);
  const doRedo = useCallback(() => {
    if (canRedo(history.current)) applySnapshot(redoHistory(history.current));
  }, [applySnapshot]);

  const onShortcut = useCallback((e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key.toLowerCase() === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
    else if ((e.key.toLowerCase() === "z" && e.shiftKey) || e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
    else if (e.key.toLowerCase() === "d") { e.preventDefault(); duplicateSelection(); }
    else if (e.key.toLowerCase() === "s") { e.preventDefault(); void saveGraph().catch(() => {}); }
  }, [doUndo, doRedo, duplicateSelection]);
  useEffect(() => {
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [onShortcut]);

  const [pendingTemplate, setPendingTemplate] = useState<{ graph?: { nodes?: unknown[]; edges?: unknown[] }; name: string; description: string } | null>(null);

  const loadTemplate = (tpl: { graph?: { nodes?: unknown[]; edges?: unknown[] }; name: string; description: string }) => {
    // Replacing a canvas the user has built is destructive and unrecoverable:
    // it overwrites the canvas, and autosave then persists it over the stored
    // workflow and the local draft. Confirm first.
    if (nodes.length > 0) { setPendingTemplate(tpl); setTemplateMenuOpen(false); return; }
    applyTemplate(tpl);
  };

  const applyTemplate = (tpl: { graph?: { nodes?: unknown[]; edges?: unknown[] }; name: string; description: string }) => {
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

  // Baseline once the initial graph has settled, whichever source it came from.
  // Without this, arriving on a workflow that has a localStorage draft would count
  // as dirty forever and prompt on every navigation away from an untouched canvas.
  // Keyed on the STRUCTURAL fingerprint, not the full snapshot: node positions
  // change every frame of a drag, and depending on those restarted this timer
  // continuously -- so a user who dragged immediately after load never baselined,
  // isDirty stayed false, and the unsaved-changes guard silently never armed.
  const graphStructure = useMemo(() => structureOf(nodes, edges), [nodes, edges]);
  const latestGraph = useRef({ nodes, edges, workflowName, workflowDescription });
  latestGraph.current = { nodes, edges, workflowName, workflowDescription };
  useEffect(() => {
    if (baselined || !graphLoadedRef.current) return;
    const t = setTimeout(() => {
      const g = latestGraph.current;
      savedSnapshot.current = snapshotOf(g.nodes, g.edges, g.workflowName, g.workflowDescription);
      setBaselined(true);
    }, 400); // after normalizeGraph/layout have applied
    return () => clearTimeout(t);
  }, [baselined, graphStructure, snapshotOf]);

  // ── unsaved-changes guard ─────────────────────────────────────────────────
  // Only meaningful once a graph has loaded; before that everything looks "changed".
  const isDirty =
    baselined &&
    snapshotOf(nodes, edges, workflowName, workflowDescription) !== savedSnapshot.current;

  // Browser refresh / tab close. Registered only while dirty so an untouched
  // builder never nags. Does NOT fire for in-app navigation -- that's handled below.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = ""; // required for Chrome to show its native prompt
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [isDirty]);

  // In-app back / forward. This app uses BrowserRouter (not a data router), so
  // useBlocker isn't available; intercept popstate and re-push the entry to stay
  // put when the user cancels.
  const [pendingNav, setPendingNav] = useState<null | (() => void)>(null);

  /** Navigate, but confirm first when there are unsaved changes. */
  const guardedNavigate = useCallback(
    (to: string) => {
      if (isDirty) setPendingNav(() => () => navigate(to));
      else navigate(to);
    },
    [isDirty, navigate],
  );
  useEffect(() => {
    if (!isDirty) return;
    // Sentinel entry: popping it means the user pressed Back.
    window.history.pushState({ specterGuard: true }, "");
    const onPopState = () => {
      window.history.pushState({ specterGuard: true }, "");
      setPendingNav(() => () => {
        window.history.go(-2); // past our sentinel, then the real entry
      });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [isDirty]);

  // ── bulk edit across every agent node ─────────────────────────────────────
  const agentNodeCount = nodes.filter((n) => AGENT_NODE_TYPES.has(String(n.type))).length;

  const applyToAll = useCallback(
    (patch: Record<string, unknown>, label: string) => {
      let touched = 0;
      setNodes((cur) =>
        cur.map((n) => {
          if (!AGENT_NODE_TYPES.has(String(n.type))) return n;
          touched += 1;
          return { ...n, data: { ...n.data, ...patch } };
        }),
      );
      setBulkMenuOpen(false);
      setStatusMessage(`Applied "${label}" to ${touched} agent node${touched === 1 ? "" : "s"}.`);
    },
    [setNodes],
  );

  // ── auto-arrange the canvas into topological columns ──────────────────────
  const tidyLayout = useCallback(() => {
    setNodes((cur) => topoLayout(cur, edges).nodes);
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
    setStatusMessage("Layout tidied.");
  }, [edges, setNodes, fitView]);

  // Returns a promise so callers that must not proceed on failure -- "Save and
  // leave" above all -- can await the real outcome instead of guessing a delay.
  const saveGraph = (): Promise<void> => {
    if (!isNew) {
      try { localStorage.setItem(storageKey(workflowId), JSON.stringify({ nodes, edges })); } catch { /* ignore */ }
    }
    if (!workflowName.trim()) {
      setNameTouched(true);
      setStatusMessage("Workflow name is required before saving.");
      return Promise.reject(new Error("Workflow name is required."));
    }
    if (!canUseBackend) {
      setStatusMessage("Changes saved locally — sign in to save to the server.");
      return Promise.resolve();
    }
    return saveMutation.mutateAsync(undefined).then(() => undefined);
  };

  // ── derived state ──────────────────────────────────────────────────────────
  const activeWorkspaces = workspacesQuery.data?.filter((w) => w.is_active) ?? [];
  const selectedWorkspace = activeWorkspaces.find((w) => w.id === selectedWorkspaceId);
  // Was Boolean(selectedWorkspace) alone, so a graph with no edges, empty
  // objectives, an unset condition or a cycle started a real sandboxed run.
  const issues = useMemo(() => graphIssues(nodes, edges), [nodes, edges]);
  // Surface each issue on its node so "what's left to configure?" is answerable
  // without opening all 15. Kept out of `nodes` state -- it is derived, and
  // writing it back would land in the saved graph.
  const issueByNode = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of issues) if (!m.has(i.nodeId)) m.set(i.nodeId, i.reason);
    return m;
  }, [issues]);
  const nodesWithIssues = useMemo(
    () => nodes.map((n) => (issueByNode.has(n.id)
      ? { ...n, data: { ...n.data, __issue: issueByNode.get(n.id) } }
      : n)),
    [nodes, issueByNode],
  );
  const executionReady = Boolean(selectedWorkspace) && issues.length === 0 && nodes.length > 0;
  // Trigger nodes declare the values a run needs before it can start.
  const triggerNodes = nodes.filter((n) => n.type === "trigger");
  const triggerInputComplete = triggerNodes.every((n) => {
    const d = n.data as Record<string, unknown>;
    if (d.required === false) return true;
    return (runInput[String(d.fieldName ?? "input")] ?? "").trim().length > 0;
  });
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;
  const hasSelection = nodes.some((n) => n.selected) || edges.some((e) => e.selected);
  const mcpServers: McpServer[] = mcpQuery.data?.servers ?? [];
  const allSkills = skillsQuery.data ?? [];

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown} tabIndex={-1}>

      {/* ── top bar ── */}
      <div className="flex items-start justify-between gap-4 border-b border-[#e8ecf1] bg-white px-6 py-3.5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <nav className="mr-1 flex items-center gap-1 text-[10px] uppercase tracking-[0.09em] text-[#94a3b8]">
              <Link to="/workflows" className="hover:text-[#374151]">Workflows</Link>
              <ChevronRight className="h-3 w-3" />
              <span className="max-w-[240px] truncate text-[#374151]">{workflowName || "Untitled"}</span>
            </nav>
            <span className="rounded-full bg-[#f1f5f9] px-2.5 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[0.07em] text-[#64748b]">
              {isNew ? "unsaved" : workflowQuery.data?.is_template ? "template" : "editable"}
            </span>
            {isDirty && (
              <span className="rounded-full bg-[#fef3c7] px-2.5 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[0.07em] text-[#92400e]">
                ● unsaved changes
              </span>
            )}
            <span className="rounded-full px-2.5 py-[3px] text-[9.5px] font-extrabold uppercase tracking-[0.07em]"
              style={executionReady ? { borderColor: "#6ee7b7", color: "#065f46", background: "#ecfdf5" } : { borderColor: "#fcd34d", color: "#92400e", background: "#fffbeb" }}>
              {executionReady ? "ready" : "select repository"}
            </span>
            {!canUseBackend && (
              <span className="border border-[#fcd34d] bg-[#fffbeb] px-1.5 py-[2px] text-[10px] font-semibold uppercase tracking-widest text-[#92400e]">
                signed out
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <input
              className={`block w-full max-w-xl rounded bg-transparent text-[17px] font-extrabold tracking-[-0.01em] text-[#0f172a] outline-none ring-0 transition hover:bg-[#f1f5f9] focus:bg-white focus:px-2 focus:ring-1 ${
                nameTouched && !workflowName.trim() ? "focus:ring-red-400" : "focus:ring-indigo-300"
              }`}
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onBlur={() => { setNameTouched(true); void saveGraph().catch(() => {}); }}
              placeholder="Workflow name"
              style={{
                border: nameTouched && !workflowName.trim() ? "1px solid #fca5a5" : "none",
                padding: nameTouched && !workflowName.trim() ? "0 6px" : 0,
              }}
            />
            <span className="shrink-0 text-[13px] font-semibold text-red-500" title="Required">*</span>
          </div>
          {nameTouched && !workflowName.trim() && (
            <p className="mt-0.5 text-[10px] font-medium text-red-500">Workflow name is required.</p>
          )}
          <input
            className="mt-0.5 block w-full max-w-2xl rounded bg-transparent text-[11px] leading-relaxed text-[#6b7280] outline-none ring-0 transition hover:bg-[#f1f5f9] focus:bg-white focus:px-2 focus:ring-1 focus:ring-indigo-300"
            value={workflowDescription}
            onChange={(e) => setWorkflowDescription(e.target.value)}
            onBlur={() => void saveGraph().catch(() => {})}
            placeholder="Add a description…"
            style={{ border: "none", padding: 0 }}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-1">
          {/* Bulk edit: applies to every agent-bearing node so you don't have to
              open the inspector once per node on an imported graph. */}
          <Button onClick={doUndo} disabled={!canUndo(history.current)} variant="outline"
            className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc] disabled:opacity-35" title="Undo (⌘Z)">
            <Undo2 className="mr-1.5 h-3 w-3" /> Undo
          </Button>
          <Button onClick={doRedo} disabled={!canRedo(history.current)} variant="outline"
            className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc] disabled:opacity-35" title="Redo (⇧⌘Z)">
            <Redo2 className="mr-1.5 h-3 w-3" /> Redo
          </Button>
          <Button onClick={duplicateSelection} disabled={!hasSelection} variant="outline"
            className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc] disabled:opacity-35" title="Duplicate selection (⌘D)">
            <CopyPlus className="mr-1.5 h-3 w-3" /> Duplicate
          </Button>
          {agentNodeCount > 0 && (
            <div style={{ position: "relative" }}>
              <Button
                variant="outline"
                onClick={() => setBulkMenuOpen((v) => !v)}
                title="Apply a setting to every agent node on this canvas"
                className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc]"
              >
                <Layers className="mr-1.5 h-3 w-3" /> Apply to all
                <ChevronDown className="ml-1.5 h-3 w-3" />
              </Button>
              {bulkMenuOpen && (
                <>
                  <div onClick={() => setBulkMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
                  <div style={{
                    position: "absolute", top: "calc(100% + 4px)", right: 0, zIndex: 50,
                    background: "white", border: "1px solid #e2e8f0", borderRadius: 10,
                    boxShadow: "0 8px 30px rgba(0,0,0,0.12)", minWidth: 250, overflow: "hidden",
                  }}>
                    <p style={bulkHeading}>Execution mode</p>
                    <button style={bulkItem} onClick={() => applyToAll({ runtime: "direct" }, "Direct CLI")}>
                      Direct CLI <span style={bulkHint}>fast, runs on host</span>
                    </button>
                    <button style={bulkItem} onClick={() => applyToAll({ runtime: "sandbox" }, "Docker Sandbox")}>
                      Docker Sandbox <span style={bulkHint}>isolated microVM</span>
                    </button>

                    <p style={{ ...bulkHeading, borderTop: "1px solid #f1f5f9" }}>Agent</p>
                    {[["claude", "Claude Code"], ["codex", "Codex"], ["cursor", "Cursor"]].map(([value, label]) => (
                      <button
                        key={value}
                        style={bulkItem}
                        // Models are agent-specific, so switching agent clears the model.
                        onClick={() => applyToAll({ sandboxAgent: value, model: "" }, label)}
                      >
                        {label}
                      </button>
                    ))}

                    <p style={{ ...bulkHeading, borderTop: "1px solid #f1f5f9" }}>Model</p>
                    <button
                      style={bulkItem}
                      onClick={() =>
                        applyToAll(
                          { sandboxAgent: modelPreference.agent, model: modelPreference.model },
                          `${modelPreference.agent}${modelPreference.model ? ` / ${modelPreference.model}` : ""}`,
                        )
                      }
                    >
                      Use header default <span style={bulkHint}>{modelPreference.model || "Auto"}</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          <Button onClick={tidyLayout} variant="outline"
            className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc]"
            title="Auto-arrange nodes into topological columns">
            <LayoutGrid className="mr-1.5 h-3 w-3" /> Tidy layout
          </Button>
          {/* ── template picker dropdown ── */}
          {templatesList.length > 0 && (
            <div style={{ position: "relative" }}>
              <Button
                variant="outline"
                onClick={() => setTemplateMenuOpen((v) => !v)}
                className="h-[30px] rounded-[6px] border-[#d3dae3] bg-white px-3 text-[11px] font-semibold text-[#334155] hover:bg-[#f8fafc]"
               
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

          <button
            onClick={toggleAutoSaveDb}
            title={autoSaveDb ? "Auto-save is on — changes are saved as you edit" : "Auto-save is off — edits stay in draft until you save"}
            className={`flex h-[30px] items-center gap-1.5 rounded-[6px] border px-2.5 text-[10px] font-semibold transition-colors ${
              autoSaveDb ? "border-[#6ee7b7] bg-[#ecfdf5] text-[#065f46]" : "border-[#d1d5db] bg-white text-[#6b7280] hover:bg-[#f9fafb]"
            }`}
           
          >
            <span
              className="relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full transition-colors"
              style={{ background: autoSaveDb ? "#10b981" : "#d1d5db" }}
            >
              <span
                className="inline-block h-2.5 w-2.5 transform rounded-full bg-white transition-transform"
                style={{ transform: autoSaveDb ? "translateX(11px)" : "translateX(2px)" }}
              />
            </span>
            Auto-save
          </button>
          <Button onClick={() => void saveGraph().catch(() => {})} disabled={saveMutation.isPending} variant="outline"
            className={`h-[30px] rounded-[6px] px-3 text-[11px] font-semibold transition-colors ${
              saveStatus === "saved" ? "border-[#6ee7b7] bg-[#ecfdf5] text-[#065f46]" :
              saveStatus === "error" ? "border-[#fca5a5] bg-[#fef2f2] text-[#dc2626]" :
              "border-[#d1d5db] bg-white text-[#374151] hover:bg-[#f9fafb]"
            }`}>
            {saveMutation.isPending
              ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              : saveStatus === "saved" ? <CheckCircle2 className="mr-1.5 h-3 w-3" />
              : <Save className="mr-1.5 h-3 w-3" />}
            {saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Save failed" : autoSaveDb ? "Save now" : "Save graph"}
          </Button>
          <Button
            disabled={isNew || !executionReady || runMutation.isPending}
            onClick={() => (triggerNodes.length ? setRunInputOpen(true) : runMutation.mutate({}))}
            className="h-[30px] rounded-[6px] bg-[#0f1117] px-3.5 text-[11px] font-bold text-white hover:bg-[#1f2937] disabled:opacity-35"
            title={
              isNew ? "Save the workflow first before running"
              : !selectedWorkspace ? "Select a repository first"
              : issues.length ? `${issues.length} issue${issues.length === 1 ? "" : "s"} must be resolved first`
              : nodes.length === 0 ? "Add at least one node"
              : undefined
            }>
            {runMutation.isPending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Play className="mr-1.5 h-3 w-3" />}
            Run workflow
          </Button>
          <Button
            onClick={() => guardedNavigate("/runs")}
            variant="outline"
            className="h-[30px] rounded-[6px] border-[#d3dae3] px-3 text-[11px] font-semibold text-[#64748b] hover:bg-[#f8fafc]">
            <History className="mr-1.5 h-3 w-3" />
            Run history
          </Button>
          {hasSelection && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline"
                  className="h-[30px] rounded-[6px] border-[#fca5a5] bg-white px-3 text-[11px] font-semibold text-[#dc2626] hover:bg-[#fef2f2]">
                  <Trash2 className="mr-1.5 h-3 w-3" /> Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete selection?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Delete {nodes.filter((n) => n.selected).length} node(s) and {edges.filter((e) => e.selected).length} edge(s)? This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={deleteSelected} className="bg-[#dc2626] text-white hover:bg-[#b91c1c]">
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      {/* ── workflow status strip (repo + gates — applies to the whole workflow, not a selected node) ── */}
      <div className="border-b border-[#e8ecf1] bg-[#fbfcfd]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-widest text-[#9ca3af]">repo</span>
            <select
              className="border border-[#d1d5db] bg-white px-1.5 py-[3px] text-[10px] text-[#374151] outline-none focus:border-[#374151]"
              value={selectedWorkspaceId}
              onChange={(e) => handleWorkspaceChange(e.target.value)}
            >
              {!activeWorkspaces.length && <option value="">No repositories configured</option>}
              {activeWorkspaces.map((w) => (
                <option key={w.id} value={w.id}>{w.name}</option>
              ))}
            </select>
          </div>
          <GateDot ok={Boolean(selectedWorkspace)} label="repo approved" />
          <GateDot ok={nodes.some((n) => n.type === "humanApproval")} label="approval gate" />
          <button
            onClick={() => setDetailsOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af] hover:text-[#374151]"
          >
            Details <ChevronDown className={`h-3 w-3 transition-transform ${detailsOpen ? "rotate-180" : ""}`} />
          </button>
        </div>

        {detailsOpen && (
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 border-t border-[#f3f4f6] px-5 py-2.5 sm:grid-cols-4">
            <DataRow label="nodes" value={nodes.length} />
            <DataRow label="edges" value={edges.length} />
            <DataRow label="approval gates" value={nodes.filter((n) => n.type === "humanApproval").length} />
            <DataRow label="nodes w/ tools" value={nodes.filter((n) => Array.isArray(n.data.selectedTools) && (n.data.selectedTools as string[]).length > 0).length} />
            <DataRow label="nodes w/ skills" value={nodes.filter((n) => Array.isArray(n.data.selectedSkills) && (n.data.selectedSkills as string[]).length > 0).length} />
            <DataRow label="MCP servers avail." value={mcpServers.filter((s) => s.configured && s.enabled).length} />
            <DataRow label="skills avail." value={allSkills.length} />
          </div>
        )}

        <div className="flex items-center justify-between border-t border-[#f3f4f6] px-5 py-1.5">
          <p className="text-[10px] text-[#6b7280]">{statusMessage}</p>
          <p className="shrink-0 text-[10px] text-[#9ca3af]">
            {autoSaveDb ? "Auto-save on — changes saved as you edit" : "Edits kept as a draft — Save to publish"}
          </p>
        </div>
      </div>

      {/* Blocking issues, named and clickable. Previously nothing surfaced these:
          Run was enabled and the failure arrived from the backend mid-run. */}
      {issues.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-[#fde68a] bg-[#fffbeb] px-5 py-2">
          <span className="flex items-center gap-1.5 text-[11px] font-semibold text-[#92400e]">
            <AlertTriangle className="h-3 w-3" />
            {issues.length} issue{issues.length === 1 ? "" : "s"} block this run
          </span>
          {issues.slice(0, 6).map((issue) => (
            <button
              key={`${issue.nodeId}-${issue.reason}`}
              onClick={() => {
                setNodes((cur) => cur.map((n) => ({ ...n, selected: n.id === issue.nodeId })));
                setRightCollapsed(false);
              }}
              className="rounded-[5px] border border-[#fcd34d] bg-white px-2.5 py-[3px] text-[10.5px] text-[#92400e] hover:bg-[#fffbeb]"
              title="Select this node"
            >
              <b className="border-b border-dotted border-[#b45309] font-semibold">{issue.label}</b> {issue.reason}
            </button>
          ))}
          {issues.length > 6 && (
            <span className="text-[10.5px] text-[#a16207]">+{issues.length - 6} more</span>
          )}
        </div>
      )}

      {/* ── three-column layout ── */}
      <div className="flex min-h-0 flex-1 overflow-hidden">

        {/* ── palette ── */}
        <div
          className="relative shrink-0 border-r border-[#e8ecf1] bg-[#fcfdfe] transition-all duration-200 overflow-hidden"
          style={{ width: paletteCollapsed ? 28 : 190 }}
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
                <p className="text-[9.5px] font-extrabold uppercase tracking-[0.1em] text-[#64748b]">Palette</p>
                <p className="text-[10px] text-[#9ca3af]">Drag, or click + to add</p>
              </div>
              <div className="relative px-2 py-2">
                <Search className="pointer-events-none absolute left-3.5 top-[13px] h-3 w-3 text-[#9ca3af]" />
                <input
                  value={paletteQuery}
                  onChange={(e) => setPaletteQuery(e.target.value)}
                  placeholder="Search nodes…"
                  className="w-full border border-[#e5e7eb] bg-white py-1 pl-6 pr-2 text-[10px] text-[#374151] outline-none focus:border-[#374151]"
                />
              </div>
              <div className="overflow-y-auto" style={{ maxHeight: "calc(100vh - 120px)" }}>
                {palette
                  .map((group) => ({
                    ...group,
                    items: group.items.filter((it) => {
                      const q = paletteQuery.trim().toLowerCase();
                      return !q || it.label.toLowerCase().includes(q) || it.description.toLowerCase().includes(q);
                    }),
                  }))
                  .filter((group) => group.items.length > 0)
                  .map((group) => (
                  <div key={group.category} className="border-b border-[#f3f4f6] last:border-b-0">
                    <p className="px-3 pb-1 pt-2.5 text-[9px] font-extrabold uppercase tracking-[0.1em] text-[#9aa5b4]">
                      {group.category}
                    </p>
                    {group.items.map(({ icon: Icon, label, nodeType, presetKey, description }) => (
                      <div
                        key={label}
                        draggable
                        onDragStart={(e) => onDragStart(e, nodeType, label, presetKey)}
                        title={description}
                        className="flex cursor-grab items-start gap-2 px-3 py-[7px] hover:bg-[#f1f5f9] active:cursor-grabbing select-none"
                       
                      >
                        <span
                          className="mt-[5px] h-[7px] w-[7px] shrink-0 rounded-[2px]"
                          style={{ background: nodeAccent(nodeType) }}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[11px] font-medium text-[#334155]">{label}</span>
                          <span className="block text-[9.5px] leading-[1.35] text-[#94a3b8]">{description}</span>
                        </span>
                        <button
                          onClick={(ev) => { ev.stopPropagation(); addNodeFromPalette(nodeType, label, presetKey); }}
                          title={`Add ${label}`}
                          aria-label={`Add ${label}`}
                          className="shrink-0 self-center px-1 text-[13px] leading-none text-[#cbd5e1] hover:text-[#4f46e5]"
                        >
                          +
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
                {paletteQuery.trim() &&
                  palette.every((g) =>
                    g.items.every((it) =>
                      !it.label.toLowerCase().includes(paletteQuery.trim().toLowerCase()) &&
                      !it.description.toLowerCase().includes(paletteQuery.trim().toLowerCase()))) && (
                    <p className="px-3 py-3 text-[10px] text-[#9ca3af]">No nodes match "{paletteQuery}".</p>
                  )}
              </div>
            </>
          )}
        </div>

        {/* ── canvas ── */}
        <div
          ref={canvasRef}
          className="flex-1 overflow-hidden border-r border-[#e8ecf1] bg-[#f8fafc]"
          onDragOver={onDragOver}
          onDrop={onDrop}
        >
          <ReactFlow
            nodes={nodesWithIssues}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange as (changes: NodeChange[]) => void}
            onEdgesChange={onEdgesChange as (changes: EdgeChange[]) => void}
            onConnect={onConnect}
            isValidConnection={(c) => Boolean(c.source && c.target) && canConnect(c.source!, c.target!, edges)}
            onNodeClick={onNodeClick}
            onPaneClick={onPaneClick}
            fitView
            fitViewOptions={fitViewOptions}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
            defaultEdgeOptions={{ style: { stroke: "#9ca3af", strokeWidth: 1 } }}
          >
            <Background color="#dde3ea" gap={22} size={1} />
            <MiniMap pannable zoomable nodeStrokeWidth={0}
              nodeColor={(n) => nodeAccent(n.type)}
              style={{ background: "#f9fafb", border: "1px solid #e5e7eb" }}
              className="!rounded-none" />
            <Controls className="!rounded-none !border !border-[#e5e7eb] !bg-white [&>button]:!rounded-none [&>button]:!border-[#e5e7eb]" />
          </ReactFlow>
        </div>

        {/* ── right panel (drag left edge to resize) ── */}
        <div
          className={`relative shrink-0 border-l border-[#e5e7eb] bg-white overflow-hidden ${rightCollapsed ? "transition-all duration-200" : ""}`}
          style={{ width: rightCollapsed ? 28 : rightWidth }}
        >
          {!rightCollapsed && (
            <div
              onMouseDown={(e) => { rightDragging.current = true; rightStartX.current = e.clientX; rightStartW.current = rightWidth; e.preventDefault(); }}
              className="absolute left-0 top-0 z-10 flex h-full w-[5px] cursor-col-resize items-center justify-center"
              title="Drag to resize"
            >
              <div className="h-8 w-[3px] rounded bg-[#e2e8f0]" />
            </div>
          )}
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
            <TabsList className="grid h-7 w-full grid-cols-2 rounded-none border-b border-[#e5e7eb] bg-white p-0">
              {["agent", "memory"].map((tab) => (
                <TabsTrigger key={tab} value={tab}
                  className="h-full rounded-none border-r border-[#e8ecf1] text-[9.5px] font-extrabold uppercase tracking-[0.09em] text-[#94a3b8] last:border-r-0 data-[state=active]:bg-[#f8fafc] data-[state=active]:text-[#0f1117] data-[state=active]:shadow-[inset_0_-2px_0_#4f46e5]"
                 >
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>

            {/* Agent inspector */}
            <TabsContent value="agent" className="mt-0 p-4">
              <AgentInspector
                node={selectedNode}
                onChange={onNodeChange}
                mcpServers={mcpServers}
                skills={allSkills}
                onPlanWorkflow={(node, feedback) => planMutation.mutate({ sup: node, feedback })}
                planPending={planMutation.isPending}
                planError={planMutation.error instanceof Error ? planMutation.error.message : null}
                hasGeneratedPlan={Boolean(selectedNode && nodes.some((n) => (n.data as Record<string, unknown>)?.generatedBy === selectedNode.id))}
                onTuneNode={(node, instruction) => tuneNodeMutation.mutate({ node, instruction })}
                tunePending={tuneNodeMutation.isPending}
              />
            </TabsContent>

            {/* Memory */}
            <TabsContent value="memory" className="mt-0 p-4">
              <div className="border border-[#e5e7eb] px-4 py-6 text-center">
                <p className="text-[10px] leading-relaxed text-[#9ca3af]">
                  Memory is populated once this workflow runs — each node writes its output
                  here, scoped by its Memory scope setting (workflow / team / agent_private).
                  Open a run to view its live memory.
                </p>
              </div>
            </TabsContent>
          </Tabs>
        </div>}
        </div>
      </div>

      {/* Replacing a built canvas with a template is destructive -- confirm. */}
      <AlertDialog open={Boolean(pendingTemplate)} onOpenChange={(o) => !o && setPendingTemplate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace this workflow with a template?</AlertDialogTitle>
            <AlertDialogDescription>
              Loading "{pendingTemplate?.name}" discards the {nodes.length} node
              {nodes.length === 1 ? "" : "s"} currently on the canvas. This cannot be undone,
              and auto-save will persist the replacement.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my workflow</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => { if (pendingTemplate) applyTemplate(pendingTemplate); setPendingTemplate(null); }}
              className="bg-[#dc2626] text-white hover:bg-[#b91c1c]"
            >
              Replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Collect trigger values before starting the run. */}
      {runInputOpen && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 100, background: "rgba(15,23,42,0.35)",
            backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center",
          }}
          onClick={() => setRunInputOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: "white", borderRadius: 14, padding: 24, width: 460, boxShadow: "0 20px 60px rgba(0,0,0,0.18)" }}
          >
            <p style={{ margin: 0, fontSize: 15, fontWeight: 800, color: "#0f172a" }}>Start run</p>
            <p style={{ margin: "4px 0 16px", fontSize: 12, color: "#94a3b8" }}>
              This workflow asks for input before it runs.
            </p>

            {triggerNodes.map((node) => {
              const d = node.data as Record<string, unknown>;
              const field = String(d.fieldName ?? "input");
              const required = d.required !== false;
              return (
                <div key={node.id} style={{ marginBottom: 14 }}>
                  <label style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.08em", display: "block", marginBottom: 5 }}>
                    {String(d.label ?? field)}
                    {required && <span style={{ color: "#dc2626" }}> *</span>}
                  </label>
                  <textarea
                    autoFocus={triggerNodes[0]?.id === node.id}
                    rows={3}
                    value={runInput[field] ?? ""}
                    onChange={(e) => setRunInput((cur) => ({ ...cur, [field]: e.target.value }))}
                    placeholder={String(d.placeholder ?? "")}
                    style={{
                      width: "100%", padding: "8px 10px", borderRadius: 7, border: "1px solid #e2e8f0",
                      fontSize: 13, color: "#0f172a", outline: "none", resize: "vertical", boxSizing: "border-box",
                    }}
                  />
                </div>
              );
            })}

            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button
                onClick={() => setRunInputOpen(false)}
                style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: 600, background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, cursor: "pointer", color: "#374151" }}
              >
                Cancel
              </button>
              <button
                disabled={!triggerInputComplete || runMutation.isPending}
                onClick={() => { setRunInputOpen(false); runMutation.mutate(runInput); }}
                style={{
                  flex: 2, padding: "9px 0", fontSize: 13, fontWeight: 700,
                  background: triggerInputComplete ? "#0f1117" : "#e2e8f0",
                  color: triggerInputComplete ? "white" : "#94a3b8",
                  border: "none", borderRadius: 8,
                  cursor: triggerInputComplete ? "pointer" : "not-allowed",
                }}
              >
                Run workflow
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Unsaved-changes confirm for in-app navigation (Back, toolbar links). */}
      <AlertDialog open={pendingNav !== null} onOpenChange={(open) => !open && setPendingNav(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              This workflow has changes that haven't been saved to the server. Leaving now
              discards them.
              {!isNew && " A local draft is kept in this browser, but it won't reach the server."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingNav(null)}>Stay on this page</AlertDialogCancel>
            <AlertDialogAction
              onClick={async () => {
                const go = pendingNav;
                // Await the save: navigating on a timer discarded the user's work
                // whenever the request was slow or rejected (e.g. a duplicate name),
                // while the button promised it had been saved.
                try {
                  await saveGraph();
                } catch {
                  return; // stay put; the error is shown in the status bar
                }
                setPendingNav(null);
                go?.();
              }}
            >
              Save and leave
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                const go = pendingNav;
                setPendingNav(null);
                go?.();
              }}
              className="bg-red-600 hover:bg-red-700"
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── exported page (wraps with ReactFlowProvider) ─────────────────────────────
export default function WorkflowBuilder() {
  const { workflowId = "security-review-team" } = useParams();
  const [searchParams] = useSearchParams();
  const publishOnSave = searchParams.get("template") === "1";
  const token = getStoredToken() ?? "";
  const canUseBackend = Boolean(token);

  return (
    <ReactFlowProvider>
      <BuilderInner workflowId={workflowId} token={token} canUseBackend={canUseBackend} publishOnSave={publishOnSave} />
    </ReactFlowProvider>
  );
}

const bulkHeading: React.CSSProperties = {
  margin: 0, padding: "8px 12px 3px", fontSize: 9, fontWeight: 700,
  textTransform: "uppercase", letterSpacing: "0.1em", color: "#94a3b8",
};
const bulkItem: React.CSSProperties = {
  display: "flex", alignItems: "baseline", gap: 6, width: "100%", textAlign: "left",
  padding: "6px 12px", fontSize: 12, color: "#0f172a",
  background: "none", border: "none", cursor: "pointer",
};
const bulkHint: React.CSSProperties = { fontSize: 10, color: "#94a3b8" };
