import { Bot, ShieldCheck } from "lucide-react";
import type { AgentNodeConfig } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

export function AgentCard({ agent, supervisor = false }: { agent: AgentNodeConfig; supervisor?: boolean }) {
  return (
    <Card className={`rounded-3xl ${supervisor ? "border-indigo-300 bg-indigo-50" : "border-white/80 bg-white/85"}`}>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-3">
          <span className={`flex h-12 w-12 items-center justify-center rounded-2xl ${supervisor ? "bg-indigo-600 text-white" : "bg-cyan-100 text-cyan-800"}`}>
            {supervisor ? <ShieldCheck className="h-6 w-6" /> : <Bot className="h-6 w-6" />}
          </span>
          {agent.requiresApproval && <Badge className="rounded-full bg-amber-100 text-amber-900 hover:bg-amber-100">Approval required</Badge>}
        </div>
        <h3 className="mt-4 text-lg font-black text-slate-950">{agent.name}</h3>
        <p className="mt-1 text-sm font-semibold text-indigo-700">{agent.role}</p>
        <p className="mt-3 line-clamp-2 text-sm leading-6 text-slate-600">{agent.objective}</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Badge variant="outline" className="rounded-full bg-white">{agent.model}</Badge>
          <Badge variant="outline" className="rounded-full bg-white">{agent.tools.length} tools</Badge>
          <Badge variant="outline" className="rounded-full bg-white">{agent.skills.length} skills</Badge>
          <Badge variant="outline" className="rounded-full bg-white">{agent.memoryScope}</Badge>
        </div>
      </CardContent>
    </Card>
  );
}
