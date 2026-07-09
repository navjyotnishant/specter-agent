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
  Copy,
  Database,
  FileText,
  GitBranch,
  GitMerge,
  History,
  Loader2,
  Play,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2,
  Webhook,
} from "lucide-react";
import type { McpServer } from "@/lib/types";
import { AgentInspector } from "@/components/agents/AgentInspector";
import { ConditionalNode } from "@/components/workflow/nodes/ConditionalNode";
import { HumanApprovalNode } from "@/components/workflow/nodes/HumanApprovalNode";
import { MemoryNode } from "@/components/workflow/nodes/MemoryNode";
import { SpecialistAgentNode } from "@/components/workflow/nodes/SpecialistAgentNode";
import { SupervisorAgentNode } from "@/components/workflow/nodes/SupervisorAgentNode";
import { WebhookNode } from "@/components/workflow/nodes/WebhookNode";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import { layoutGeneratedSubgraph } from "@/lib/graph-layout";
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
  conditional: ConditionalNode,
  webhook: WebhookNode,
};

// id of the seeded "Standard Report Format" skill (backend/app/runtime/skill_seeds.py)
const STANDARD_REPORT_FORMAT_SKILL_ID = "standard-report-format";

// ── default data per node type ──────────────────────────────────────────────
const nodeDefaults: Record<string, Record<string, unknown>> = {
  supervisorAgent: { label: "Supervisor Agent", sandboxAgent: "codex", model: "", memoryScope: "team", maxIterations: 1, delegationStrategy: "sequential_delegation", objective: "", systemInstructions: "" },
  specialistAgent: { label: "Specialist Agent", role: "", sandboxAgent: "codex", model: "", memoryScope: "workflow", maxIterations: 1, objective: "", systemInstructions: "" },
  humanApproval: { label: "Human Approval", reason: "Requires manual approval before continuing.", timeoutHours: 24 },
  memory: { label: "Write Memory", scope: "workflow" },
  conditional: { label: "Conditional", condition: "", sandboxAgent: "codex", model: "" },
  webhook: { label: "Webhook", url: "", method: "POST", payloadTemplate: "" },
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
  aggregator: {
    ...nodeDefaults.specialistAgent,
    role: "Aggregator",
    objective: "Combine the outputs of the parallel branches feeding into this node into a single, de-duplicated summary. Note any conflicts or disagreements between branches explicitly.",
    memoryScope: "workflow",
  },
};

// ── palette definition ──────────────────────────────────────────────────────
const palette: { category: string; items: { icon: typeof Bot; label: string; nodeType: string; presetKey?: string }[] }[] = [
  {
    category: "Agents",
    items: [
      { icon: ShieldCheck, label: "Generic Supervisor", nodeType: "supervisorAgent" },
      { icon: Sparkles, label: "Smart Supervisor", nodeType: "supervisorAgent", presetKey: "smartSupervisor" },
      { icon: Bot, label: "Specialist Agent", nodeType: "specialistAgent" },
      { icon: FileText, label: "Report Writer", nodeType: "specialistAgent", presetKey: "reportWriter" },
      { icon: GitMerge, label: "Aggregator", nodeType: "specialistAgent", presetKey: "aggregator" },
    ],
  },
  {
    category: "Control Flow",
    items: [
      { icon: CheckCircle2, label: "Human Approval", nodeType: "humanApproval" },
      { icon: GitBranch, label: "Conditional", nodeType: "conditional" },
    ],
  },
  {
    category: "Memory",
    items: [
      { icon: Database, label: "Write Memory", nodeType: "memory" },
    ],
  },
  {
    category: "Notifications",
    items: [
      { icon: Webhook, label: "Webhook", nodeType: "webhook" },
    ],
  },
];

// ── seed template ────────────────────────────────────────────────────────────
// Sequential left-to-right pipeline — each col is 320px wide, vertically centred
// supervisor(0) → memory(1,top) → code(2) → deps(3) → secrets(4) → report(5)
// memory runs in parallel with code as a planning step off the supervisor
const COL = 320;
const defaultNodes: Node[] = [
  { id: "supervisor",  type: "supervisorAgent", position: { x: 0,        y: 200 }, data: { label: "Security Supervisor",    sandboxAgent: "codex", model: "", selectedTools: [], selectedSkills: [], memoryScope: "team",         maxIterations: 4, requiresApproval: false, delegationStrategy: "sequential_delegation", objective: "Scope this security review, identify the top areas to inspect, and coordinate specialist agents to run in sequence.", systemInstructions: "Delegate only to known specialist agents. Enforce tool allowlists, memory boundaries, and approval policy." } },
  { id: "memory-plan", type: "memory",          position: { x: COL,      y: 40  }, data: { label: "Write task plan",        scope: "team" } },
  { id: "code",        type: "specialistAgent", position: { x: COL * 2,  y: 200 }, data: { label: "Code Security Reviewer",  role: "Secure code review",    sandboxAgent: "codex", model: "", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 3, requiresApproval: false, objective: "Review 2–3 key source files for auth, injection, and access-control vulnerabilities.", systemInstructions: "" } },
  { id: "deps",        type: "specialistAgent", position: { x: COL * 3,  y: 200 }, data: { label: "Dependency Auditor",      role: "Dependency auditor",    sandboxAgent: "codex", model: "", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 3, requiresApproval: false, objective: "Check requirements.txt or package.json for known vulnerable or outdated packages.", systemInstructions: "" } },
  { id: "secrets",     type: "specialistAgent", position: { x: COL * 4,  y: 200 }, data: { label: "Secrets & Config Agent",  role: "Masked config review",  sandboxAgent: "codex", model: "", selectedTools: [], selectedSkills: [], memoryScope: "agent_private", maxIterations: 3, requiresApproval: false, objective: "Scan config files and env patterns for hardcoded secrets, tokens, or insecure defaults.", systemInstructions: "" } },
  { id: "report",      type: "specialistAgent", position: { x: COL * 5,  y: 200 }, data: { label: "Report Writer Agent",     role: "Security report writer", sandboxAgent: "codex", model: "", selectedTools: [], selectedSkills: [], memoryScope: "workflow",      maxIterations: 2, requiresApproval: false, objective: "Summarise findings from all prior agents into a structured security report with severity ratings.", systemInstructions: "" } },
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
function GateDot({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className="flex items-center gap-1 text-[9px] text-[#6b7280]" title={ok ? `${label}: ready` : `${label}: required`}>
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
  const { screenToFlowPosition, deleteElements } = useReactFlow();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState(isNew ? [] : defaultNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(isNew ? [] : defaultEdges);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("agent");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState(isNew ? "" : "Security Review Team");
  const [workflowDescription, setWorkflowDescription] = useState(isNew ? "" : "");
  const [nameTouched, setNameTouched] = useState(false);
  const [statusMessage, setStatusMessage] = useState(isNew ? "New workflow — drag nodes from the palette to get started." : "Drag from the palette to add nodes.");
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
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
    mutationFn: (graphOverride?: { nodes: Node[]; edges: Edge[] }) => {
      const graph = graphOverride ?? { nodes, edges };
      return isNew
        ? api.createWorkflow(token, { name: workflowName || "Untitled Workflow", description: workflowDescription, graph })
        : api.updateWorkflow(token, workflowId, { name: workflowName, description: workflowDescription, graph });
    },
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

  // ── auto-save to database 2.5s after any change, when enabled ─────────────
  useEffect(() => {
    if (isNew || !autoSaveDb || !graphLoadedRef.current || !canUseBackend || !workflowName.trim()) return;
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
        agent: String(d.sandboxAgent ?? d.agent ?? "codex"),
        workspace_path: selectedWorkspace.path,
        system_instructions: String(d.systemInstructions ?? ""),
        current_plan: feedback ? buildCurrentPlan(sup) : null,
        feedback: feedback ?? "",
      });
    },
    onSuccess: (graph, { sup }) => {
      const genNodes = (graph.nodes ?? []) as Node[];
      const genEdges = (graph.edges ?? []) as Edge[];
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
        setNodes(finalNodes);
        setEdges(mergedEdges);
        const specialistCount = genNodes.filter((n) => n.type === "specialistAgent").length;
        setStatusMessage(`Generated ${specialistCount} specialist agents — review before running. Saving to database…`);
        saveMutation.mutate({ nodes: finalNodes, edges: mergedEdges });
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
        agent: String(d.sandboxAgent ?? d.agent ?? "codex"),
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
      const id = `${nodeType}-${++nodeCounter}`;
      const baseDefaults = (presetKey && presetDefaults[presetKey]) || nodeDefaults[nodeType];
      const newNode: Node = {
        id,
        type: nodeType,
        position,
        data: { ...baseDefaults, label },
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
    if (!workflowName.trim()) {
      setNameTouched(true);
      setStatusMessage("Workflow name is required before saving.");
      return;
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
  const executionReady = Boolean(selectedWorkspace);
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
              {executionReady ? "ready" : "select repository"}
            </span>
            {!canUseBackend && (
              <span className="border border-[#fcd34d] bg-[#fffbeb] px-1.5 py-[2px] text-[9px] font-semibold uppercase tracking-widest text-[#92400e]">
                preview mode
              </span>
            )}
          </div>
          <div className="mt-2 flex items-center gap-1">
            <input
              className={`block w-full max-w-xl rounded bg-transparent text-[15px] font-semibold text-[#0f1117] outline-none ring-0 transition hover:bg-[#f1f5f9] focus:bg-white focus:px-2 focus:ring-1 ${
                nameTouched && !workflowName.trim() ? "focus:ring-red-400" : "focus:ring-indigo-300"
              }`}
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              onBlur={() => { setNameTouched(true); saveGraph(); }}
              placeholder="Workflow name"
              style={{
                border: nameTouched && !workflowName.trim() ? "1px solid #fca5a5" : "none",
                padding: nameTouched && !workflowName.trim() ? "0 6px" : 0,
              }}
            />
            <span className="shrink-0 text-[13px] font-semibold text-red-500" title="Required">*</span>
          </div>
          {nameTouched && !workflowName.trim() && (
            <p className="mt-0.5 text-[9px] font-medium text-red-500" style={MONO}>Workflow name is required.</p>
          )}
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

          <button
            onClick={toggleAutoSaveDb}
            title={autoSaveDb ? "Auto-save to database is on — click to switch to manual save" : "Auto-save to database is off — click to save automatically as you edit"}
            className={`flex h-8 items-center gap-1.5 border px-2.5 text-[10px] font-medium transition-colors ${
              autoSaveDb ? "border-[#6ee7b7] bg-[#ecfdf5] text-[#065f46]" : "border-[#d1d5db] bg-white text-[#6b7280] hover:bg-[#f9fafb]"
            }`}
            style={MONO}
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
            {saveStatus === "saved" ? "Saved" : saveStatus === "error" ? "Save failed" : autoSaveDb ? "Save now" : "Save graph"}
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

      {/* ── workflow status strip (repo + gates — applies to the whole workflow, not a selected node) ── */}
      <div className="border-b border-[#e5e7eb] bg-[#fafafa]" style={MONO}>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[9px] uppercase tracking-widest text-[#9ca3af]">repo</span>
            <select
              className="border border-[#d1d5db] bg-white px-1.5 py-[3px] text-[10px] text-[#374151] outline-none focus:border-[#374151]"
              style={MONO}
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
            className="ml-auto flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af] hover:text-[#374151]"
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
          <p className="shrink-0 text-[9px] text-[#9ca3af]">
            {autoSaveDb ? "auto-saving to database as you edit" : "changes auto-saved locally · click Save graph to push to DB"}
          </p>
        </div>
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
                    {group.items.map(({ icon: Icon, label, nodeType, presetKey }) => (
                      <div
                        key={label}
                        draggable
                        onDragStart={(e) => onDragStart(e, nodeType, label, presetKey)}
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
            <TabsList className="grid h-7 w-full grid-cols-2 rounded-none border-b border-[#e5e7eb] bg-white p-0" style={MONO}>
              {["agent", "memory"].map((tab) => (
                <TabsTrigger key={tab} value={tab}
                  className="h-full rounded-none border-r border-[#e5e7eb] text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af] last:border-r-0 data-[state=active]:bg-[#f9fafb] data-[state=active]:text-[#0f1117] data-[state=active]:shadow-none"
                  style={MONO}>
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
                hasGeneratedPlan={Boolean(selectedNode && nodes.some((n) => (n.data as Record<string, unknown>)?.generatedBy === selectedNode.id))}
                onTuneNode={(node, instruction) => tuneNodeMutation.mutate({ node, instruction })}
                tunePending={tuneNodeMutation.isPending}
              />
            </TabsContent>

            {/* Memory */}
            <TabsContent value="memory" className="mt-0 p-4">
              <div className="border border-[#e5e7eb] px-4 py-6 text-center" style={MONO}>
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
