import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Brain, Code2, FileText, FlaskConical, KeyRound, PackageSearch, Wrench } from "lucide-react";
import { useState } from "react";
import { agentModelChip } from "./chip-utils";

// Maps role keywords → accent color + icon
function roleStyle(role: string): { color: string; bg: string; Icon: typeof Code2 } {
  const r = role.toLowerCase();
  if (r.includes("code") || r.includes("review"))       return { color: "#2563eb", bg: "#eff6ff", Icon: Code2 };
  if (r.includes("depend") || r.includes("audit"))       return { color: "#7c3aed", bg: "#f5f3ff", Icon: PackageSearch };
  if (r.includes("secret") || r.includes("config") || r.includes("mask")) return { color: "#dc2626", bg: "#fef2f2", Icon: KeyRound };
  if (r.includes("report") || r.includes("writer"))      return { color: "#0891b2", bg: "#ecfeff", Icon: FileText };
  if (r.includes("test") || r.includes("qa"))            return { color: "#059669", bg: "#ecfdf5", Icon: FlaskConical };
  return { color: "#374151", bg: "#f9fafb", Icon: Wrench };
}

export function SpecialistAgentNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const role = String(data.role ?? "");
  const { color, bg, Icon } = roleStyle(role);
  const toolCount = Array.isArray(data.selectedTools) ? (data.selectedTools as string[]).length : Number(data.tools ?? 0);
  const skillCount = Array.isArray(data.selectedSkills) ? (data.selectedSkills as string[]).length : Number(data.skills ?? 0);

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
      className={`w-[220px] bg-white ${selected ? "border-2 border-[#0f1117]" : "border border-[#d1d5db]"}`}
      style={{ borderLeft: `3px solid ${color}` }}
    >
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !rounded-none !border-0" style={{ background: color }} />

      {/* header — role-coloured */}
      <div className="flex items-center gap-2 border-b border-[#e5e7eb] px-3 py-2" style={{ background: bg }}>
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
        <span className="truncate text-[11px] font-semibold uppercase tracking-widest" style={{ color }}>
          {role || "Specialist"}
        </span>
      </div>

      <div className="px-3 py-2.5">
        {/* label — double-click to rename */}
        {editing ? (
          <input
            autoFocus
            defaultValue={String(data.label ?? "Specialist Agent")}
            className="w-full bg-transparent text-[12px] font-bold text-[#111827] outline-none border-b border-[#374151]"
            onBlur={(e) => { (data as Record<string, unknown>).label = e.target.value; setEditing(false); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { (data as Record<string, unknown>).label = (e.target as HTMLInputElement).value; setEditing(false); } }}
          />
        ) : (
          <p
            className="text-[12px] font-bold leading-tight text-[#111827] cursor-text"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to rename"
          >
            {String(data.label ?? "Specialist Agent")}
          </p>
        )}

        {/* stats row */}
        <div className="mt-2.5 flex flex-wrap gap-[3px]">
          <span className="border border-[#e5e7eb] px-1.5 py-[3px] font-mono text-[10px] text-[#374151]">{agentModelChip(data)}</span>
          {toolCount > 0 && (
            <span className="flex items-center gap-1 border border-[#e5e7eb] px-1.5 py-[3px] text-[10px] text-[#374151]">
              <Wrench className="h-2.5 w-2.5" />{toolCount}
            </span>
          )}
          {skillCount > 0 && (
            <span className="flex items-center gap-1 border border-[#e5e7eb] px-1.5 py-[3px] text-[10px] text-[#374151]">
              <Brain className="h-2.5 w-2.5" />{skillCount}
            </span>
          )}
        </div>

        <div className="mt-2 border-t border-[#f3f4f6] pt-2">
          <span className="text-[10px] uppercase tracking-widest text-[#9ca3af]">memory</span>
          <span className="ml-2 text-[10px] text-[#374151]">{String(data.memoryScope ?? "workflow")}</span>
        </div>
      </div>

      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !rounded-none !border-0" style={{ background: color }} />
    </div>
    </div>
  );
}
