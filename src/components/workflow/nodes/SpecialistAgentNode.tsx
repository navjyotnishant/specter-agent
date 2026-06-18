import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Bot, Brain, Wrench } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function SpecialistAgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`min-w-64 rounded-[1.5rem] border bg-white p-4 shadow-lg shadow-slate-200/70 ${selected ? "border-indigo-400" : "border-white"}`}>
      <Handle type="target" position={Position.Left} className="!bg-indigo-400" />
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800"><Bot className="h-6 w-6" /></span>
        {data.requiresApproval ? <Badge className="rounded-full bg-amber-100 text-amber-900 hover:bg-amber-100">Approval</Badge> : <Badge variant="outline" className="rounded-full bg-slate-50">Specialist</Badge>}
      </div>
      <h3 className="mt-4 font-black text-slate-950">{String(data.label ?? "Specialist Agent")}</h3>
      <p className="mt-1 text-sm font-semibold text-indigo-700">{String(data.role ?? "Focused SDLC role")}</p>
      <Badge variant="outline" className="mt-3 rounded-full bg-slate-50">{String(data.model ?? "ollama/codellama")}</Badge>
      <div className="mt-4 flex gap-2 text-xs font-semibold text-slate-600">
        <span className="flex items-center gap-1 rounded-2xl bg-slate-100 px-2 py-2"><Wrench className="h-3 w-3" /> {String(data.tools ?? "1")} tools</span>
        <span className="flex items-center gap-1 rounded-2xl bg-slate-100 px-2 py-2"><Brain className="h-3 w-3" /> {String(data.skills ?? "1")} skills</span>
      </div>
      <p className="mt-3 text-xs text-slate-500">Memory: {String(data.memoryScope ?? "workflow")}</p>
      <Handle type="source" position={Position.Right} className="!bg-indigo-400" />
    </div>
  );
}
