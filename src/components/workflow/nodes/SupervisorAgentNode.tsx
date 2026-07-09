import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Crown, GitMerge, Loader2 } from "lucide-react";
import { useState, useRef } from "react";

export function SupervisorAgentNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPlanning = Boolean(data.isPlanning);

  const commitLabel = () => {
    setEditing(false);
  };

  return (
    <div
      className={`w-[220px] border bg-[#0f1117] text-white ${
        isPlanning ? "specter-supervisor-planning border-[#4f8ef7]" : selected ? "border-[#4f8ef7]" : "border-[#2a2d36]"
      }`}
      style={{ fontFamily: "ui-monospace, 'Cascadia Code', monospace" }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !rounded-none !border-0 !bg-[#4f8ef7]" />

      <div className="flex items-center gap-2 border-b border-[#2a2d36] px-3 py-2">
        <Crown className="h-3.5 w-3.5 shrink-0 text-[#4f8ef7]" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-[#4f8ef7]">Supervisor</span>
        {isPlanning && (
          <span className="ml-auto flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-[#4f8ef7]">
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
        <p className="mt-0.5 text-[10px] text-[#6b7280]">{String(data.model ?? "codex-cli")}</p>

        <div className="mt-2.5 grid grid-cols-3 gap-[3px]">
          {[
            [String(Array.isArray(data.selectedTools) ? (data.selectedTools as string[]).length : (data.tools ?? 0)), "tools"],
            [String(Array.isArray(data.selectedSkills) ? (data.selectedSkills as string[]).length : (data.skills ?? 0)), "skills"],
            [String(data.memoryScope ?? "team"), "memory"],
          ].map(([val, label]) => (
            <div key={label} className="border border-[#2a2d36] px-1.5 py-1 text-center">
              <span className="block text-[10px] font-semibold text-white">{val}</span>
              <span className="block text-[9px] text-[#6b7280]">{label}</span>
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
  );
}
