import { FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Loader2, Plus, ShieldCheck, Trash2, Workflow as WorkflowIcon } from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { Workflow } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const emptyGraph = { nodes: [], edges: [] };

const previewWorkflows: Workflow[] = [
  {
    id: "security-review-team",
    name: "Security Review Team",
    description: "Supervisor-led security review with specialist agents, shared memory, and approval before final report.",
    graph: emptyGraph,
    is_template: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

export default function Workflows() {
  const token = getStoredToken();
  const canUseBackend = Boolean(token && token !== "preview-mode");
  const queryClient = useQueryClient();
  const [name, setName] = useState("Custom SDLC Agent Team");
  const [description, setDescription] = useState("A custom governed workflow with agent nodes, shared memory, and approval checkpoints.");
  const [error, setError] = useState("");

  const { data = [], isLoading } = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });

  const workflows = data.length ? data : previewWorkflows;

  const create = useMutation({
    mutationFn: () => api.createWorkflow(token ?? "", { name, description, graph: emptyGraph }),
    onSuccess: () => {
      setError("");
      queryClient.invalidateQueries({ queryKey: ["workflows"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to create workflow"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteWorkflow(token ?? "", id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["workflows"] }),
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    create.mutate();
  };

  return (
    <div className="space-y-6">
      <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
        <CardContent className="p-6 sm:p-8">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-4">
              <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-600 text-white">
                <GitBranch className="h-8 w-8" />
              </span>
              <div>
                <Badge className="mb-2 rounded-full bg-indigo-100 text-indigo-800 hover:bg-indigo-100">Workflow operations</Badge>
                <h2 className="text-3xl font-black text-slate-950">Workflows</h2>
                <p className="mt-2 max-w-3xl text-slate-600">Create, operate, and audit visual workflows with agent orchestration nodes.</p>
              </div>
            </div>
            <Button asChild className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
              <Link to="/workflows/security-review-team/builder"><ShieldCheck className="mr-2 h-4 w-4" /> Open Security Review Team</Link>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-sm">
        <CardContent className="p-5 sm:p-6">
          <h3 className="mb-5 flex items-center gap-2 text-xl font-black text-slate-950"><Plus className="h-5 w-5 text-indigo-600" /> Create workflow</h3>
          <form onSubmit={onSubmit} className="grid gap-4 lg:grid-cols-[1fr_1.3fr_auto] lg:items-end">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input className="rounded-2xl" value={name} onChange={(event) => setName(event.target.value)} required />
            </div>
            <div className="space-y-2">
              <Label>Description</Label>
              <Textarea className="min-h-11 rounded-2xl" value={description} onChange={(event) => setDescription(event.target.value)} />
            </div>
            <Button disabled={create.isPending || !canUseBackend} className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
              {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create
            </Button>
          </form>
          {!canUseBackend && <p className="mt-3 text-sm text-slate-500">Creating workflows is available when the service is connected. Preview changes can still be saved in this browser.</p>}
          {error && <Alert variant="destructive" className="mt-4 rounded-2xl"><AlertDescription>{error}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-3">
        {isLoading && canUseBackend && (
          <Card className="rounded-3xl border-white/80 bg-white/80 p-6 text-slate-600">Loading workflows…</Card>
        )}
        {workflows.map((workflow) => (
          <Card key={workflow.id} className="rounded-3xl border-white/80 bg-white/80 transition hover:-translate-y-0.5 hover:shadow-lg hover:shadow-slate-200/70">
            <CardContent className="p-5">
              <div className="flex items-start justify-between gap-3">
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><WorkflowIcon className="h-6 w-6" /></span>
                <Badge className={`rounded-full ${workflow.is_template ? "bg-amber-100 text-amber-900" : "bg-emerald-100 text-emerald-800"} hover:bg-current/0`}>
                  {workflow.is_template ? "Template" : "Custom"}
                </Badge>
              </div>
              <h3 className="mt-4 text-xl font-black text-slate-950">{workflow.name}</h3>
              <p className="mt-2 min-h-12 text-sm leading-6 text-slate-600">{workflow.description}</p>
              <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-500">
                <Badge variant="outline" className="rounded-full bg-white">{workflow.graph?.nodes?.length ?? 0} nodes</Badge>
                <Badge variant="outline" className="rounded-full bg-white">{workflow.graph?.edges?.length ?? 0} edges</Badge>
              </div>
              <div className="mt-5 flex items-center justify-between gap-2">
                <Button asChild className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
                  <Link to={`/workflows/${workflow.id}/builder`}>Open builder</Link>
                </Button>
                <Button
                  disabled={!canUseBackend || workflow.is_template || remove.isPending}
                  onClick={() => remove.mutate(workflow.id)}
                  variant="outline"
                  size="icon"
                  className="rounded-2xl border-red-200 text-red-700 hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
