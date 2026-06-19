import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import {
  addEdge,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Bot, CheckCircle2, Code2, Database, FileText, GitBranch, Loader2, Play, Save, ShieldCheck, Wrench } from "lucide-react";
import { AgentInspector } from "@/components/agents/AgentInspector";
import { AgentTimeline } from "@/components/agents/AgentTimeline";
import { MemoryPanel } from "@/components/memory/MemoryPanel";
import { HumanApprovalNode } from "@/components/workflow/nodes/HumanApprovalNode";
import { MemoryNode } from "@/components/workflow/nodes/MemoryNode";
import { SpecialistAgentNode } from "@/components/workflow/nodes/SpecialistAgentNode";
import { SupervisorAgentNode } from "@/components/workflow/nodes/SupervisorAgentNode";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { AgentNodeConfig, WorkflowGraph } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const nodeTypes = {
  supervisorAgent: SupervisorAgentNode,
  specialistAgent: SpecialistAgentNode,
  humanApproval: HumanApprovalNode,
  memory: MemoryNode,
};

const palette = [
  { category: "Agents", items: [[ShieldCheck, "Supervisor Agent"], [Bot, "Specialist Agent"], [GitBranch, "Agent Team"]] },
  { category: "AI + Skills", items: [[Bot, "AI Prompt"], [Wrench, "Skill"], [FileText, "Report Generator"]] },
  { category: "Code + SDLC Tools", items: [[Code2, "Codebase Scan"], [Wrench, "MCP Tool"], [GitBranch, "GitHub Action"], [GitBranch, "Jira Action"], [Play, "Test Command"]] },
  { category: "Control Flow", items: [[GitBranch, "Conditional"], [CheckCircle2, "Human Approval"], [GitBranch, "Merge/Aggregate"]] },
  { category: "Memory + Context", items: [[Database, "Read Memory"], [Database, "Write Memory"], [Database, "Context Pack Builder"]] },
];

const defaultNodes: Node[] = [
  { id: "supervisor", type: "supervisorAgent", position: { x: 40, y: 160 }, data: { label: "Security Supervisor Agent", model: "ollama/llama3.1", tools: 4, skills: 4 } },
  { id: "memory-plan", type: "memory", position: { x: 390, y: 40 }, data: { label: "Write task plan", scope: "team" } },
  { id: "code", type: "specialistAgent", position: { x: 430, y: 190 }, data: { label: "Code Security Reviewer", role: "Secure code review", model: "ollama/codellama", tools: 1, skills: 1, memoryScope: "workflow" } },
  { id: "deps", type: "specialistAgent", position: { x: 430, y: 390 }, data: { label: "Dependency Vulnerability Agent", role: "Dependency auditor", model: "openai-compatible/gpt-4.1", tools: 1, skills: 1, memoryScope: "workflow" } },
  { id: "secrets", type: "specialistAgent", position: { x: 780, y: 190 }, data: { label: "Secrets & Configuration Agent", role: "Masked config review", model: "ollama/llama3.1", tools: 1, skills: 1, memoryScope: "agent_private", requiresApproval: true } },
  { id: "approval", type: "humanApproval", position: { x: 1120, y: 260 }, data: { label: "Approve final report", reason: "Supervisor pauses before final report generation or external write actions." } },
  { id: "report", type: "specialistAgent", position: { x: 1450, y: 260 }, data: { label: "Report Writer Agent", role: "Security report writer", model: "anthropic-compatible/claude", tools: 0, skills: 1, memoryScope: "workflow" } },
];

const defaultEdges: Edge[] = [
  { id: "e1", source: "supervisor", target: "memory-plan", animated: true },
  { id: "e2", source: "supervisor", target: "code", animated: true },
  { id: "e3", source: "supervisor", target: "deps", animated: true },
  { id: "e4", source: "code", target: "secrets", animated: true },
  { id: "e5", source: "deps", target: "approval", animated: true },
  { id: "e6", source: "secrets", target: "approval", animated: true },
  { id: "e7", source: "approval", target: "report", animated: true },
];

const defaultAgent: AgentNodeConfig = {
  id: "supervisor",
  name: "Security Supervisor Agent",
  role: "Supervisor Agent",
  objective: "Break a security review into bounded specialist tasks, coordinate memory, and request approval before final reporting.",
  systemInstructions: "Delegate only to known specialist agents. Enforce tool allowlists, memory boundaries, and approval policy.",
  provider: "ollama",
  model: "llama3.1",
  skills: ["secure-code-review", "dependency-risk-review", "secrets-config-review", "security-report-writer"],
  tools: ["local-codebase", "mcp-shell", "github-shell", "jira-shell"],
  memoryScope: "team",
  maxIterations: 4,
  requiresApproval: true,
  outputSchema: "{ plan: Task[], approval_policy: string, final_summary: string }",
  delegationStrategy: "sequential_delegation",
  aggregationStrategy: "Group findings by severity, evidence, affected file/component, and remediation.",
};

const nodePositions: Record<string, { x: number; y: number }> = {
  "security-supervisor": { x: 40, y: 160 },
  "memory-plan": { x: 390, y: 40 },
  "code-reviewer": { x: 430, y: 190 },
  "dependency-auditor": { x: 430, y: 390 },
  "secrets-config": { x: 780, y: 190 },
  "approval-final-report": { x: 1120, y: 260 },
  "report-writer": { x: 1450, y: 260 },
};

function storageKey(workflowId: string) {
  return `sdlc_workflow_graph_${workflowId}`;
}

function normalizeGraph(graph?: Partial<WorkflowGraph>): { nodes: Node[]; edges: Edge[] } {
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : defaultNodes;
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : defaultEdges;

  const nodes = rawNodes.map((rawNode, index) => {
    const node = rawNode as Partial<Node> & Record<string, unknown>;
    const nodeId = String(node.id ?? `node-${index + 1}`);
    const nodeType = String(node.type ?? "specialistAgent");
    const position = node.position ?? nodePositions[nodeId] ?? { x: 120 + index * 260, y: 160 + (index % 3) * 140 };

    return {
      id: nodeId,
      type: nodeType,
      position,
      data: node.data ?? {
        label: node.label ?? node.name ?? nodeId,
        role: node.role,
        model: node.model,
        tools: Array.isArray(node.tools) ? node.tools.length : node.tools,
        skills: Array.isArray(node.skills) ? node.skills.length : node.skills,
        memoryScope: node.memory_scope ?? node.memoryScope,
        requiresApproval: node.requires_approval ?? node.requiresApproval,
        reason: node.reason,
        scope: node.scope ?? node.memory_scope,
      },
    } as Node;
  });

  const edges = rawEdges.map((rawEdge, index) => {
    const edge = rawEdge as Partial<Edge> & Record<string, unknown>;
    return {
      id: String(edge.id ?? `edge-${index + 1}`),
      source: String(edge.source),
      target: String(edge.target),
      animated: edge.animated !== false,
    } as Edge;
  }).filter((edge) => edge.source && edge.target);

  return { nodes, edges };
}

export default function WorkflowBuilder() {
  const { workflowId = "security-review-team" } = useParams();
  const token = getStoredToken();
  const [agent, setAgent] = useState(defaultAgent);
  const [nodes, setNodes, onNodesChange] = useNodesState(defaultNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(defaultEdges);
  const [workflowName, setWorkflowName] = useState("Security Review Team");
  const [workflowDescription, setWorkflowDescription] = useState("A supervisor-led multi-agent SDLC workflow with specialist reviewers, shared memory, and approval checkpoints.");
  const [statusMessage, setStatusMessage] = useState("Preview graph loaded from built-in template.");
  const fitViewOptions = useMemo(() => ({ padding: 0.2 }), []);

  const canUseBackend = Boolean(token && token !== "preview-mode");
  const workflowQuery = useQuery({
    queryKey: ["workflow", workflowId],
    queryFn: () => api.workflow(token ?? "", workflowId),
    enabled: canUseBackend,
    retry: false,
  });

  useEffect(() => {
    const saved = localStorage.getItem(storageKey(workflowId));
    if (!canUseBackend && saved) {
      const graph = normalizeGraph(JSON.parse(saved));
      setNodes(graph.nodes);
      setEdges(graph.edges);
      setStatusMessage("Preview graph restored from browser storage.");
      return;
    }

    if (!canUseBackend) {
      setStatusMessage("Preview graph loaded from built-in template. Saving will use browser storage.");
    }
  }, [canUseBackend, setEdges, setNodes, workflowId]);

  useEffect(() => {
    if (!workflowQuery.data) return;
    const graph = normalizeGraph(workflowQuery.data.graph);
    setNodes(graph.nodes);
    setEdges(graph.edges);
    setWorkflowName(workflowQuery.data.name);
    setWorkflowDescription(workflowQuery.data.description);
    setStatusMessage(`Loaded ${workflowQuery.data.name} from SQLite.`);
  }, [setEdges, setNodes, workflowQuery.data]);

  const saveMutation = useMutation({
    mutationFn: () => api.updateWorkflow(token ?? "", workflowId, { name: workflowName, description: workflowDescription, graph: { nodes, edges } }),
    onSuccess: (workflow) => setStatusMessage(`Saved ${workflow.name} to SQLite at ${new Date().toLocaleTimeString()}.`),
    onError: (error) => setStatusMessage(error instanceof Error ? error.message : "Unable to save workflow graph."),
  });

  const onConnect = (connection: Connection) => setEdges((current) => addEdge({ ...connection, animated: true }, current));

  const saveGraph = () => {
    const graph = { nodes, edges };
    if (!canUseBackend) {
      localStorage.setItem(storageKey(workflowId), JSON.stringify(graph));
      setStatusMessage(`Preview graph saved to browser storage at ${new Date().toLocaleTimeString()}.`);
      return;
    }
    saveMutation.mutate();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 rounded-[2rem] border border-white/80 bg-white/85 p-5 shadow-sm backdrop-blur-xl xl:flex-row xl:items-center xl:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">{workflowQuery.data?.is_template ? "Built-in template" : "Editable workflow"}</Badge>
            <Badge className="rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-100">SQLite-backed graph JSON</Badge>
            {!canUseBackend && <Badge className="rounded-full bg-amber-100 text-amber-900 hover:bg-amber-100">Preview storage</Badge>}
          </div>
          <h2 className="mt-3 text-3xl font-black text-slate-950">{workflowName} Builder</h2>
          <p className="mt-2 max-w-4xl text-slate-600">{workflowDescription}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={saveGraph} disabled={saveMutation.isPending} variant="outline" className="rounded-2xl bg-white">
            {saveMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />} Save graph
          </Button>
          <Button className="rounded-2xl bg-indigo-600 hover:bg-indigo-700"><Play className="mr-2 h-4 w-4" /> Run manually</Button>
        </div>
      </div>

      <Alert className="rounded-2xl border-cyan-100 bg-cyan-50 text-cyan-950">
        <AlertDescription>{statusMessage}</AlertDescription>
      </Alert>

      <div className="grid gap-5 xl:grid-cols-[280px_minmax(0,1fr)_380px]">
        <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
          <CardContent className="p-4">
            <h3 className="mb-4 text-lg font-black text-slate-950">Node palette</h3>
            <div className="space-y-4">
              {palette.map((group) => (
                <div key={group.category}>
                  <p className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-slate-500">{group.category}</p>
                  <div className="space-y-2">
                    {group.items.map(([Icon, label]) => {
                      const ItemIcon = Icon as typeof Bot;
                      return (
                        <button key={label as string} className="flex w-full items-center gap-3 rounded-2xl border border-slate-100 bg-slate-50 px-3 py-2.5 text-left text-sm font-semibold text-slate-700 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-800">
                          <ItemIcon className="h-4 w-4" /> {label as string}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="h-[760px] overflow-hidden rounded-[2rem] border border-white/80 bg-white shadow-sm">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            fitViewOptions={fitViewOptions}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#cbd5e1" gap={20} />
            <MiniMap pannable zoomable nodeStrokeWidth={3} className="!rounded-2xl" />
            <Controls className="!rounded-2xl !border-white !bg-white/90" />
          </ReactFlow>
        </div>

        <Tabs defaultValue="inspector" className="min-w-0">
          <TabsList className="grid w-full grid-cols-3 rounded-2xl bg-white/80 p-1">
            <TabsTrigger value="inspector" className="rounded-xl">Inspector</TabsTrigger>
            <TabsTrigger value="timeline" className="rounded-xl">Run</TabsTrigger>
            <TabsTrigger value="memory" className="rounded-xl">Memory</TabsTrigger>
          </TabsList>
          <TabsContent value="inspector" className="mt-4"><AgentInspector agent={agent} onChange={setAgent} /></TabsContent>
          <TabsContent value="timeline" className="mt-4 rounded-[2rem] border border-white/80 bg-white/90 p-5"><AgentTimeline /></TabsContent>
          <TabsContent value="memory" className="mt-4"><MemoryPanel /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
