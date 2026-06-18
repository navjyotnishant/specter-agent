import { Database, EyeOff } from "lucide-react";
import type { MemoryEntry } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const sampleMemory: MemoryEntry[] = [
  {
    id: "memory-1",
    workflow_run_id: "demo-run",
    scope: "workflow",
    key: "supervisor_plan",
    value_text: "Sequential security review delegated to code, dependency, secrets, and report specialists.",
    sensitivity_label: "internal",
    created_by_agent: "Security Supervisor Agent",
    created_at: new Date().toISOString(),
  },
  {
    id: "memory-2",
    workflow_run_id: "demo-run",
    scope: "agent_private",
    key: "masked_config_observation",
    value_text: "Potential secret-like value found and masked as sk_••••••••.",
    sensitivity_label: "sensitive_masked",
    created_by_agent: "Secrets & Configuration Agent",
    created_at: new Date().toISOString(),
  },
];

export function MemoryPanel({ entries = sampleMemory }: { entries?: MemoryEntry[] }) {
  return (
    <Card className="rounded-[2rem] border-cyan-100 bg-cyan-50/70">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl font-black text-slate-950"><Database className="h-5 w-5 text-cyan-700" /> Structured memory</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {entries.map((entry) => (
          <div key={entry.id} className="rounded-3xl border border-cyan-100 bg-white/80 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h4 className="font-black text-slate-950">{entry.key}</h4>
              <div className="flex gap-2">
                <Badge className="rounded-full bg-cyan-100 text-cyan-800 hover:bg-cyan-100">{entry.scope}</Badge>
                <Badge variant="outline" className="rounded-full bg-white"><EyeOff className="mr-1 h-3 w-3" /> {entry.sensitivity_label}</Badge>
              </div>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-700">{entry.value_text}</p>
            <p className="mt-2 text-xs font-semibold text-slate-500">Written by {entry.created_by_agent ?? "runtime"}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
