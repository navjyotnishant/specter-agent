import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Code2, FileText, FlaskConical, KeyRound, PackageSearch, Wrench } from "lucide-react";
import { useState } from "react";
import { agentModelChip } from "./chip-utils";

// Maps role keywords → accent colour + icon for the node's icon tile.
function roleStyle(role: string): { color: string; Icon: typeof Code2 } {
  const r = role.toLowerCase();
  if (r.includes("code") || r.includes("review")) return { color: "#4c6ef5", Icon: Code2 };
  if (r.includes("depend") || r.includes("audit")) return { color: "#7950f2", Icon: PackageSearch };
  if (r.includes("secret") || r.includes("config") || r.includes("mask")) return { color: "#e03131", Icon: KeyRound };
  if (r.includes("report") || r.includes("writer")) return { color: "#15aabf", Icon: FileText };
  if (r.includes("test") || r.includes("qa")) return { color: "#12b886", Icon: FlaskConical };
  return { color: "#4c6ef5", Icon: Wrench };
}

export function SpecialistAgentNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const role = String(data.role ?? "");
  const { color, Icon } = roleStyle(role);
  const skillCount = Array.isArray(data.selectedSkills) ? (data.selectedSkills as string[]).length : Number(data.skills ?? 0);
  const issue = (data as Record<string, unknown>).__issue as string | undefined;

  // The card's own status line. This is the point of the design: the graph
  // carries execution state, so you read the run from the canvas rather than
  // clicking into a panel.
  const status = String((data as Record<string, unknown>).__status ?? "");
  const outputLine = issue
    ? <span className="er">! {issue}</span>
    : status === "running" ? <span className="rn">▶ running · {String((data as Record<string, unknown>).__elapsed ?? "")}</span>
    : status === "completed" ? <span className="ok">✓ {String((data as Record<string, unknown>).__duration ?? "done")}</span>
    : status === "failed" ? <span className="er">✕ failed</span>
    : <>{agentModelChip(data)}{skillCount > 0 ? ` · ${skillCount} skill${skillCount === 1 ? "" : "s"}` : ""}</>;

  return (
    <div className={`sp-node ${selected ? "sel" : ""} ${issue ? "bad" : ""}`}>
      <Handle type="target" position={Position.Left} className={`sp-port ${status ? "sp-port-on" : ""}`} />

      <div className="sp-node-hd">
        <span className="sp-node-ic" style={{ background: issue ? "#e03131" : color }}>
          <Icon className="h-[15px] w-[15px]" />
        </span>
        <span className="min-w-0">
          {editing ? (
            <input
              autoFocus
              defaultValue={String(data.label ?? "Specialist Agent")}
              className="sp-node-tt w-full border-b border-[#dfe3e8] bg-transparent outline-none"
              onBlur={(e) => { (data as Record<string, unknown>).label = e.target.value; setEditing(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === "Escape") { (data as Record<string, unknown>).label = (e.target as HTMLInputElement).value; setEditing(false); } }}
            />
          ) : (
            <span
              className="sp-node-tt cursor-text truncate"
              onDoubleClick={() => setEditing(true)}
              title="Double-click to rename"
            >
              {String(data.label ?? "Specialist Agent")}
            </span>
          )}
          <span className="sp-node-sb truncate">{role || "Specialist"}</span>
        </span>
      </div>

      <div className="sp-node-out">{outputLine}</div>

      <Handle type="source" position={Position.Right} className={`sp-port ${status === "completed" ? "sp-port-on" : ""}`} />
    </div>
  );
}
