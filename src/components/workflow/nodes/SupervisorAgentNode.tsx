import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Crown, Route } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function SupervisorAgentNode({ data, selected }: NodeProps) {
  return (
    <div className={`min-w-72 rounded-[1.75rem] border-2 bg-indigo-600 p-4 text-white shadow-xl shadow-indigo-200 ${selected ? "border-cyan-300" : "border-indigo-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-300" />
      <div className="flex items-start justify-between gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15"><Crown className="h-6 w-6 text-cyan-200" /></span>
        <Badge className="rounded-full bg-cyan-200 text-indigo-950 hover:bg-cyan-200">Supervisor</Badge>
      </div>
      <h3 className="mt-4 text-lg font-black">{String(data.label ?? "Supervisor Agent")}</h3>
      <p className="mt-1 text-sm text-indigo-100">{String(data.model ?? "ollama/llama3.1")}</p>
      <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs font-semibold">
        <span className="rounded-2xl bg-white/15 px-2 py-2">{String(data.tools ?? "4")} tools</span>
        <span className="rounded-2xl bg-white/15 px-2 py-2">{String(data.skills ?? "4")} skills</span>
        <span className="rounded-2xl bg-white/15 px-2 py-2">team memory</span>
      </div>
      <div className="mt-3 flex items-center gap-2 rounded-2xl bg-white/10 px-3 py-2 text-xs text-indigo-50">
        <Route className="h-4 w-4" /> Sequential delegation
      </div>
      <Handle type="source" position={Position.Right} className="!bg-cyan-300" />
    </div>
  );
}
