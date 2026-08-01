import { Handle, Position, type NodeProps } from "@xyflow/react";
import { OctagonAlert } from "lucide-react";

export function HumanApprovalNode({ data, selected }: NodeProps) {
  return (
    <div
      className={`sp-node ${selected ? "sel" : ""}`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !rounded-full !border-2 !border-white !bg-[#d97706]"
      />

      {/* header — amber left-border accent only */}
      <div className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2"
           style={{ borderLeft: "3px solid #d97706" }}>
        <OctagonAlert className="h-3.5 w-3.5 shrink-0 text-[#d97706]" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[#374151]">
          Approval gate
        </span>
      </div>

      {/* body */}
      <div className="px-3 py-2.5">
        <p className="text-[11px] font-semibold leading-tight text-[#111827]">
          {String(data.label ?? "Human Approval")}
        </p>

        <div className="mt-2.5 border border-[#e5e7eb] bg-[#fafafa] px-2.5 py-2">
          <p
            className="line-clamp-2 text-[10px] leading-[1.6] text-[#6b7280]"
            title={String(data.reason ?? "Requires manual approval before continuing.")}
          >
            {String(data.reason ?? "Requires manual approval before continuing.")}
          </p>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1">
          {(Array.isArray(data.allowedActions) ? data.allowedActions as string[] : ["approve", "reject", "request_revision"]).map((action) => {
            const label = action === "approve" ? "✓ Approve" : action === "reject" ? "✕ Reject" : "↩ Revise";
            const color = action === "approve" ? "#059669" : action === "reject" ? "#dc2626" : "#6b7280";
            const bg    = action === "approve" ? "#ecfdf5" : action === "reject" ? "#fef2f2" : "#f8fafc";
            const border= action === "approve" ? "#a7f3d0" : action === "reject" ? "#fecaca" : "#e2e8f0";
            return (
              <span key={action} style={{ fontSize: 9, fontWeight: 700, color, background: bg, border: `1px solid ${border}`, borderRadius: 4, padding: "1px 6px", letterSpacing: "0.04em" }}>
                {label}
              </span>
            );
          })}
          {data.noteRequired && (
            <span style={{ fontSize: 9, color: "#d97706", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 4, padding: "1px 6px" }}>note required</span>
          )}
          <span style={{ fontSize: 9, color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 4, padding: "1px 6px" }}>
            expires {String(data.timeoutHours ?? 24)}h
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !rounded-full !border-2 !border-white !bg-[#d97706]"
      />
    </div>
  );
}
