import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Crown, Loader2 } from "lucide-react";
import { useState } from "react";
import { agentModelChip } from "./chip-utils";

export function SupervisorAgentNode({ data, selected }: NodeProps) {
  const [editing, setEditing] = useState(false);
  const isPlanning = Boolean(data.isPlanning);
  const issue = (data as Record<string, unknown>).__issue as string | undefined;
  const status = String((data as Record<string, unknown>).__status ?? "");

  const fanOut = String(data.delegationStrategy ?? "").includes("parallel") ? "fan-out" : "sequential";
  const skillCount = Array.isArray(data.selectedSkills) ? (data.selectedSkills as string[]).length : 0;

  // The card carries its own run state — that is the point of this direction.
  const outputLine = issue
    ? <span className="er">! {issue}</span>
    : isPlanning ? <span className="rn">▶ planning…</span>
    : status === "running" ? <span className="rn">▶ running · {String((data as Record<string, unknown>).__elapsed ?? "")}</span>
    : status === "completed" ? <span className="ok">✓ {String((data as Record<string, unknown>).__duration ?? "done")}</span>
    : status === "failed" ? <span className="er">✕ failed</span>
    : <>{agentModelChip(data)} · {fanOut}{skillCount ? ` · ${skillCount} skill${skillCount === 1 ? "" : "s"}` : ""}</>;

  return (
    <div className={`sp-node ${selected ? "sel" : ""} ${issue ? "bad" : ""} ${isPlanning ? "specter-supervisor-planning" : ""}`}>
      <Handle type="target" position={Position.Left} className={`sp-port ${status ? "sp-port-on" : ""}`} />

      <div className="sp-node-hd">
        <span className="sp-node-ic" style={{ background: issue ? "#e03131" : "#495057" }}>
          {isPlanning ? <Loader2 className="h-[15px] w-[15px] animate-spin" /> : <Crown className="h-[15px] w-[15px]" />}
        </span>
        <span className="min-w-0">
          {editing ? (
            <input
              autoFocus
              defaultValue={String(data.label ?? "Supervisor Agent")}
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
              {String(data.label ?? "Supervisor Agent")}
            </span>
          )}
          <span className="sp-node-sb truncate">Supervisor · {String(data.memoryScope ?? "team")} memory</span>
        </span>
      </div>

      <div className="sp-node-out">{outputLine}</div>

      <Handle type="source" position={Position.Right} className={`sp-port ${status === "completed" ? "sp-port-on" : ""}`} />
    </div>
  );
}
