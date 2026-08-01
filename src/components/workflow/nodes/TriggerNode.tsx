// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Entry point that supplies a value to the workflow at run time.

import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";

export function TriggerNode({ data, selected }: NodeProps) {
  const source = String(data.source ?? "manual");
  const field = String(data.fieldName ?? "input");

  return (
    <div className="relative">
      {Boolean((data as Record<string, unknown>).__issue) && (
        <span
          title={String((data as Record<string, unknown>).__issue)}
          className="absolute -right-1.5 -top-1.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-[#dc2626] text-[9px] font-bold text-white"
        >
          !
        </span>
      )}
      <div
      className={`sp-node ${selected ? "sel" : ""}`}
    >
      {/* Entry point — no target handle: nothing runs before a trigger. */}
      <div
        className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2"
        style={{ borderLeft: "3px solid #059669" }}
      >
        <Zap className="h-3.5 w-3.5 shrink-0 text-[#059669]" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[#374151]">
          Trigger
        </span>
      </div>

      <div className="px-3 py-2.5">
        <p className="text-[11px] font-semibold leading-tight text-[#111827]">
          {String(data.label ?? "Trigger")}
        </p>

        <div className="mt-2 flex items-center justify-between border-t border-[#f3f4f6] pt-2">
          <span className="text-[10px] uppercase tracking-widest text-[#9ca3af]">field</span>
          <span className="border border-[#e5e7eb] px-1.5 py-[2px] font-mono text-[10px] text-[#374151]">
            {field}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[10px] uppercase tracking-widest text-[#9ca3af]">source</span>
          <span className="text-[10px] text-[#374151]">{source}</span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !rounded-full !border-2 !border-white !bg-[#059669]"
      />
    </div>
    </div>
  );
}
