import { Handle, Position, type NodeProps } from "@xyflow/react";
import { GitBranch } from "lucide-react";

export function ConditionalNode({ data, selected }: NodeProps) {
  return (
    <div
      className={`w-[220px] border bg-white ${
        selected ? "border-[#0f1117]" : "border-[#d1d5db]"
      }`}
      style={{ fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#7c3aed]"
      />

      {/* header — violet left-border accent */}
      <div className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2"
           style={{ borderLeft: "3px solid #7c3aed" }}>
        <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#7c3aed]" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[#374151]">
          Conditional
        </span>
      </div>

      {/* body */}
      <div className="px-3 py-2.5">
        <p className="text-[11px] font-semibold leading-tight text-[#111827]">
          {String(data.label ?? "Conditional")}
        </p>

        <div className="mt-2.5 border border-[#e5e7eb] bg-[#fafafa] px-2.5 py-2">
          <p className="text-[10px] leading-[1.6] text-[#6b7280]">
            {String(data.condition ?? "No condition set — configure in the Agent panel.")}
          </p>
        </div>

        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[9px] font-semibold text-[#059669]">✓ true</span>
          <span className="text-[9px] font-semibold text-[#dc2626]">✕ false</span>
        </div>
      </div>

      <Handle
        id="true"
        type="source"
        position={Position.Right}
        style={{ top: "35%" }}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#059669]"
      />
      <Handle
        id="false"
        type="source"
        position={Position.Right}
        style={{ top: "65%" }}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#dc2626]"
      />
    </div>
  );
}
