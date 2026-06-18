import { Bot, CheckCircle2, Clock, Database } from "lucide-react";

const events = [
  { icon: Bot, title: "Security Supervisor Agent started", detail: "Created sequential delegation plan." },
  { icon: Database, title: "Shared memory written", detail: "supervisor_plan stored under workflow scope." },
  { icon: Bot, title: "Specialist tasks queued", detail: "Code, dependency, secrets, and report agents bounded to configured skills." },
  { icon: Clock, title: "Waiting for approval", detail: "Final report generation pauses until human approval." },
];

export function AgentTimeline() {
  return (
    <div className="space-y-4">
      {events.map((event, index) => {
        const Icon = event.icon;
        return (
          <div key={event.title} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700">
                <Icon className="h-5 w-5" />
              </span>
              {index < events.length - 1 && <span className="mt-2 h-8 w-px bg-slate-200" />}
            </div>
            <div className="pb-3">
              <p className="font-bold text-slate-950">{event.title}</p>
              <p className="text-sm text-slate-600">{event.detail}</p>
            </div>
          </div>
        );
      })}
    </div>
  );
}
