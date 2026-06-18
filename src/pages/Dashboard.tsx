import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Activity, AlertTriangle, Bot, CheckCircle2, Clock, Database, GitBranch, Network, Play, ShieldCheck, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const statusCards = [
  { label: "Local runtime", value: "Active", icon: Activity, tone: "bg-emerald-100 text-emerald-800" },
  { label: "SQLite database", value: "Healthy", icon: Database, tone: "bg-cyan-100 text-cyan-800" },
  { label: "Scheduler", value: "Active", icon: Clock, tone: "bg-indigo-100 text-indigo-800" },
  { label: "Approvals", value: "2 pending", icon: AlertTriangle, tone: "bg-amber-100 text-amber-900" },
];

const teams = [
  { name: "Security Review Team", status: "Ready template", description: "Supervisor + code, dependency, secrets, and report agents.", accent: "bg-indigo-600", href: "/workflows/security-review-team/builder" },
  { name: "Testing / QA Team", status: "Placeholder", description: "Test analyst and coverage agents for future automated QA.", accent: "bg-cyan-500", href: "/workflows" },
  { name: "Release Automation Team", status: "Placeholder", description: "Release notes, checks, and approval workflow shell.", accent: "bg-emerald-500", href: "/workflows" },
  { name: "Custom Agent Team", status: "Create", description: "Compose a new supervisor-led SDLC team from reusable agents.", accent: "bg-amber-500", href: "/workflows" },
];

export default function Dashboard() {
  const { data } = useQuery({ queryKey: ["health"], queryFn: api.health, retry: false });

  return (
    <div className="space-y-6">
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {statusCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label} className="rounded-3xl border-white/80 bg-white/80 shadow-sm backdrop-blur-xl">
              <CardContent className="p-5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-500">{card.label}</p>
                    <p className="mt-1 text-2xl font-black text-slate-950">{card.value}</p>
                  </div>
                  <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${card.tone}`}>
                    <Icon className="h-6 w-6" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
        <Card className="rounded-[2rem] border-white/80 bg-white/85 shadow-sm backdrop-blur-xl">
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <div>
              <CardTitle className="text-2xl font-black">Agent Teams</CardTitle>
              <p className="mt-1 text-sm text-slate-600">Start from a built-in team or create a custom multi-agent SDLC workflow.</p>
            </div>
            <Button asChild className="rounded-2xl bg-indigo-600 hover:bg-indigo-700">
              <Link to="/workflows"><GitBranch className="mr-2 h-4 w-4" /> Workflows</Link>
            </Button>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            {teams.map((team) => (
              <Link key={team.name} to={team.href} className="group rounded-3xl border border-slate-100 bg-slate-50/80 p-5 transition hover:-translate-y-0.5 hover:bg-white hover:shadow-lg hover:shadow-slate-200/70">
                <div className="flex items-start justify-between gap-4">
                  <span className={`flex h-11 w-11 rounded-2xl ${team.accent}`} />
                  <Badge variant="outline" className="rounded-full bg-white">{team.status}</Badge>
                </div>
                <h3 className="mt-5 text-xl font-black text-slate-950 group-hover:text-indigo-700">{team.name}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{team.description}</p>
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card className="rounded-[2rem] border-slate-900 bg-slate-950 text-white shadow-xl shadow-slate-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl font-black"><ShieldCheck className="h-6 w-6 text-cyan-300" /> Runtime health</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-3xl border border-white/10 bg-white/10 p-4">
              <p className="text-sm uppercase tracking-[0.2em] text-cyan-200">SQLite</p>
              <p className="mt-2 text-lg font-bold">{data?.sqlite ?? "Waiting for API"}</p>
              <p className="mt-1 break-all text-sm text-slate-300">{data?.db_path ?? "/app/data/app.db"}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/10 p-4">
                <p className="text-sm text-slate-300">Journal</p>
                <p className="font-bold text-cyan-200">{data?.journal_mode ?? "WAL"}</p>
              </div>
              <div className="rounded-2xl bg-white/10 p-4">
                <p className="text-sm text-slate-300">Scheduler</p>
                <p className="font-bold text-cyan-200">{data?.scheduler ?? "active"}</p>
              </div>
            </div>
            <Button asChild className="w-full rounded-2xl bg-cyan-300 text-slate-950 hover:bg-cyan-200">
              <Link to="/workflows/security-review-team/builder"><Play className="mr-2 h-4 w-4" /> Open Security Review Team</Link>
            </Button>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {[
          [Bot, "Model providers", "Ollama first, plus OpenAI- and Anthropic-compatible settings."],
          [Network, "Connectors", "Local codebase allowlist, MCP configuration, GitHub/Jira shells."],
          [Sparkles, "Skills library", "Reusable secure review, dependency, secrets, and report-writing prompts."],
        ].map(([Icon, title, text]) => {
          const ItemIcon = Icon as typeof Bot;
          return (
            <Card key={title as string} className="rounded-3xl border-white/80 bg-white/75">
              <CardContent className="p-5">
                <ItemIcon className="mb-4 h-7 w-7 text-indigo-600" />
                <h3 className="font-black text-slate-950">{title as string}</h3>
                <p className="mt-2 text-sm leading-6 text-slate-600">{text as string}</p>
              </CardContent>
            </Card>
          );
        })}
      </section>
    </div>
  );
}
