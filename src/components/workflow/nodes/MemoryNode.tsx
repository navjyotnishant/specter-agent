import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Database } from "lucide-react";

export function MemoryNode({ data, selected }: NodeProps) {
  return (
    <div
      className={`w-[180px] border bg-white ${
        selected ? "border-[#0f1117]" : "border-[#d1d5db]"
      }`}
      style={{ fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#6366f1]"
      />

      {/* header — indigo accent */}
      <div
        className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2"
        style={{ borderLeft: "3px solid #6366f1" }}
      >
        <Database className="h-3.5 w-3.5 shrink-0 text-[#6366f1]" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[#374151]">
          Memory
        </span>
      </div>

      {/* body */}
      <div className="px-3 py-2.5">
        <p className="text-[11px] font-semibold leading-tight text-[#111827]">
          {String(data.label ?? "Write Memory")}
        </p>

        <div className="mt-2 flex items-center justify-between border-t border-[#f3f4f6] pt-2">
          <span className="text-[9px] uppercase tracking-widest text-[#9ca3af]">scope</span>
          <span className="border border-[#e5e7eb] px-1.5 py-[2px] text-[10px] text-[#374151]">
            {String(data.scope ?? "workflow")}
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#6366f1]"
      />
    </div>
  );
}
