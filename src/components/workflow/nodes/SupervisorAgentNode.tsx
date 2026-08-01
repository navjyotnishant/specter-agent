import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Crown, GitMerge, Loader2 } from "lucide-react";
import { useState, useRef } from "react";
import { agentModelChip } from "./chip-utils";

export function SupervisorAgentNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPlanning = Boolean(data.isPlanning);

  const commitLabel = () => {
    setEditing(false);
  };

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
      className={`w-[220px] border bg-[#0f1117] text-white ${
        isPlanning ? "specter-supervisor-planning border-[#4f8ef7]" : selected ? "border-[#4f8ef7]" : "border-[#2a2d36]"
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#4f8ef7]" />

      <div className="flex items-center gap-2 border-b border-[#2a2d36] px-3 py-2">
        <Crown className="h-3.5 w-3.5 shrink-0 text-[#4f8ef7]" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[#4f8ef7]">Supervisor</span>
        {isPlanning && (
          <span className="ml-auto flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#4f8ef7]">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            planning
          </span>
        )}
      </div>

      <div className="px-3 py-2.5">
        {editing ? (
          <input
            ref={inputRef}
            autoFocus
            defaultValue={String(data.label ?? "Supervisor Agent")}
            className="w-full bg-transparent text-[11px] font-semibold text-white outline-none border-b border-[#4f8ef7]"
            onBlur={(e) => { (data as Record<string, unknown>).label = e.target.value; commitLabel(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { (data as Record<string, unknown>).label = (e.target as HTMLInputElement).value; commitLabel(); } }}
          />
        ) : (
          <p
            className="text-[11px] font-semibold leading-tight text-white cursor-text"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
          >
            {String(data.label ?? "Supervisor Agent")}
          </p>
        )}
        <p className="mt-0.5 font-mono text-[10px] text-[#6b7280]">{agentModelChip(data)}</p>

        <div className="mt-2.5 grid grid-cols-3 gap-[3px]">
          {[
            [String(Array.isArray(data.selectedTools) ? (data.selectedTools as string[]).length : (data.tools ?? 0)), "tools"],
            [String(Array.isArray(data.selectedSkills) ? (data.selectedSkills as string[]).length : (data.skills ?? 0)), "skills"],
            [String(data.memoryScope ?? "team"), "memory"],
          ].map(([val, label]) => (
            <div key={label} className="border border-[#2a2d36] px-1.5 py-1 text-center">
              <span className={`block text-[10px] font-semibold ${val === "0" ? "text-[#3f4451]" : "text-white"}`}>{val === "0" ? "—" : val}</span>
              <span className="block text-[10px] text-[#6b7280]">{label}</span>
            </div>
          ))}
        </div>

        <div className="mt-2 flex items-center gap-1.5 border border-[#2a2d36] px-2 py-1.5">
          <GitMerge className="h-3 w-3 shrink-0 text-[#6b7280]" />
          <span className="text-[10px] text-[#9ca3af]">{String(data.delegationStrategy ?? "sequential delegation")}</span>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#4f8ef7]" />
    </div>
    </div>
  );
}
