import { Handle, Position, type NodeProps } from "@xyflow/react";
import { AlertTriangle, PauseCircle } from "lucide-react";

export function HumanApprovalNode({ data, selected }: NodeProps) {
  return (
    <div className={`min-w-64 rounded-[1.5rem] border-2 bg-amber-100 p-4 text-amber-950 shadow-lg shadow-amber-100 ${selected ? "border-orange-500" : "border-amber-300"}`}>
      <Handle type="target" position={Position.Left} className="!bg-orange-500" />
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-amber-300"><PauseCircle className="h-6 w-6" /></span>
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.2em]">Pause</p>
          <h3 className="font-black">{String(data.label ?? "Human Approval")}</h3>
        </div>
      </div>
      <div className="mt-4 rounded-2xl bg-white/70 p-3 text-sm leading-5">
        <AlertTriangle className="mb-2 h-4 w-4" />
        {String(data.reason ?? "Requires manual approval before continuing.")}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-orange-500" />
    </div>
  );
}
