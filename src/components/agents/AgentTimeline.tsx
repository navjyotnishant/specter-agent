import { Bot, Clock, Database } from "lucide-react";

const MONO: React.CSSProperties = { fontFamily: "ui-monospace, 'Cascadia Code', monospace" };

const events = [
  { icon: Bot, level: "info", title: "supervisor started", detail: "Created sequential delegation plan." },
  { icon: Database, level: "info", title: "memory written", detail: "supervisor_plan → workflow scope" },
  { icon: Bot, level: "info", title: "specialist tasks queued", detail: "code · dependency · secrets · report" },
  { icon: Clock, level: "warn", title: "waiting for approval", detail: "Paused before final report generation." },
];

const levelColor: Record<string, string> = {
  info: "#6366f1",
  warn: "#d97706",
  error: "#dc2626",
};

export function AgentTimeline() {
  return (
    <div className="border border-[#e5e7eb]" style={MONO}>
      <div className="border-b border-[#e5e7eb] px-4 py-2.5">
        <p className="text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">Run timeline</p>
        <p className="mt-0.5 text-[10px] text-[#6b7280]">No active run — showing last demo trace</p>
      </div>

      <div className="divide-y divide-[#f3f4f6]">
        {events.map((event, i) => {
          const Icon = event.icon;
          return (
            <div key={i} className="flex items-start gap-3 px-4 py-3">
              <div
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center"
                style={{ background: `${levelColor[event.level]}18`, color: levelColor[event.level] }}
              >
                <Icon className="h-3 w-3" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-[#111827]">{event.title}</p>
                <p className="text-[10px] text-[#6b7280]">{event.detail}</p>
              </div>
              <span
                className="ml-auto shrink-0 border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide"
                style={{ borderColor: `${levelColor[event.level]}40`, color: levelColor[event.level] }}
              >
                {event.level}
              </span>
            </div>
          );
        })}
      </div>

      <div className="border-t border-[#e5e7eb] px-4 py-2.5">
        <p className="text-[10px] text-[#9ca3af]">Run a workflow to see live events here.</p>
      </div>
    </div>
  );
}
