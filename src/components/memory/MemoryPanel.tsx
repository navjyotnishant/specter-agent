import { EyeOff } from "lucide-react";
import type { MemoryEntry } from "@/lib/types";

const MONO: React.CSSProperties = { fontFamily: "ui-monospace, 'Cascadia Code', monospace" };

const scopeColor: Record<string, string> = {
  workflow: "#6366f1",
  team: "#0ea5e9",
  agent_private: "#6b7280",
};

export function MemoryPanel({ entries = [] }: { entries?: MemoryEntry[] }) {
  return (
    <div className="border border-[#e5e7eb]" style={MONO}>
      <div className="border-b border-[#e5e7eb] px-4 py-2.5">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">Structured memory</p>
        <p className="mt-0.5 text-[10px] text-[#6b7280]">{entries.length} entr{entries.length === 1 ? "y" : "ies"} this run</p>
      </div>

      {entries.length === 0 && (
        <div className="px-4 py-6 text-center">
          <p className="text-[10px] text-[#9ca3af]">
            No memory entries yet. Each node writes its output here after it completes,
            scoped by its Memory scope setting.
          </p>
        </div>
      )}

      <div className="divide-y divide-[#f3f4f6]">
        {entries.map((entry) => {
          const isMasked = entry.sensitivity_label === "sensitive_masked";
          const color = scopeColor[entry.scope] ?? "#6b7280";
          return (
            <div key={entry.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <p className="text-[11px] font-semibold text-[#111827]">{entry.key}</p>
                <div className="flex shrink-0 items-center gap-1.5">
                  <span
                    className="border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide"
                    style={{ borderColor: `${color}40`, color, background: `${color}0d` }}
                  >
                    {entry.scope}
                  </span>
                  {isMasked && (
                    <span className="flex items-center gap-1 border border-[#fcd34d] bg-[#fffbeb] px-1.5 py-[1px] text-[9px] text-[#92400e]">
                      <EyeOff className="h-2.5 w-2.5" /> masked
                    </span>
                  )}
                </div>
              </div>
              <p className="mt-1.5 text-[10px] leading-relaxed text-[#6b7280]">{entry.value_text}</p>
              <p className="mt-1.5 text-[9px] text-[#9ca3af]">
                {entry.created_by_agent ?? "runtime"} · {new Date(entry.created_at).toLocaleTimeString()}
              </p>
            </div>
          );
        })}
      </div>

    </div>
  );
}
