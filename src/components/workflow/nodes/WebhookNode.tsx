import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Webhook } from "lucide-react";

export function WebhookNode({ data, selected }: NodeProps) {
  const url = String(data.url ?? "");
  let host = "";
  try { host = url ? new URL(url).host : ""; } catch { host = url; }

  return (
    <div
      className={`w-[220px] border bg-white ${
        selected ? "border-[#0f1117]" : "border-[#d1d5db]"
      }`}
    >
      <Handle
        type="target"
        position={Position.Left}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#0891b2]"
      />

      {/* header — cyan left-border accent */}
      <div className="flex items-center gap-2 border-b border-[#e5e7eb] bg-white px-3 py-2"
           style={{ borderLeft: "3px solid #0891b2" }}>
        <Webhook className="h-3.5 w-3.5 shrink-0 text-[#0891b2]" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-[#374151]">
          Webhook
        </span>
      </div>

      {/* body */}
      <div className="px-3 py-2.5">
        <p className="text-[11px] font-semibold leading-tight text-[#111827]">
          {String(data.label ?? "Webhook")}
        </p>

        <div className="mt-2 flex items-center justify-between border-t border-[#f3f4f6] pt-2">
          <span className="text-[10px] uppercase tracking-widest text-[#9ca3af]">target</span>
          <span className="max-w-[140px] truncate border border-[#e5e7eb] px-1.5 py-[2px] font-mono text-[10px] text-[#374151]" title={url}>
            {host || "not set"}
          </span>
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Right}
        className="!h-2 !w-2 !rounded-none !border-0 !bg-[#0891b2]"
      />
    </div>
  );
}
