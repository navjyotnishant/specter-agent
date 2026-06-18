import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Database, MoveRight } from "lucide-react";

export function MemoryNode({ data, selected }: NodeProps) {
  return (
    <div className={`min-w-56 rounded-[1.5rem] border bg-cyan-50 p-4 text-cyan-950 shadow-md ${selected ? "border-cyan-500" : "border-cyan-200"}`}>
      <Handle type="target" position={Position.Left} className="!bg-cyan-500" />
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-200"><Database className="h-5 w-5" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em]">Memory</p>
          <h3 className="font-black">{String(data.label ?? "Write Memory")}</h3>
        </div>
      </div>
      <p className="mt-3 flex items-center gap-2 text-sm"><MoveRight className="h-4 w-4" /> Scope: {String(data.scope ?? "workflow")}</p>
      <Handle type="source" position={Position.Right} className="!bg-cyan-500" />
    </div>
  );
}
