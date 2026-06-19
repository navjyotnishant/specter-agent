import { Link } from "react-router-dom";
import { ArrowRight, Bot, CheckCircle2, GitBranch, Lock, ShieldCheck, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const capabilities = [
  { icon: ShieldCheck, title: "Governed automation", text: "Coordinate agent work with policy-aware controls, approvals, and auditable decisions." },
  { icon: Bot, title: "Specialist agent teams", text: "Supervisors delegate bounded work to focused agents with clear roles and responsibilities." },
  { icon: CheckCircle2, title: "Human checkpoints", text: "Require review before sensitive actions, final reports, or external system updates." },
  { icon: GitBranch, title: "Visual workflows", text: "Design reusable delivery workflows with agents, skills, memory, tools, and approval gates." },
];

const Index = () => {
  return (
    <main className="min-h-screen overflow-hidden bg-[#f7fbff] text-slate-950">
      <div className="pointer-events-none fixed inset-0">
        <div className="absolute -left-24 top-10 h-80 w-80 rounded-full bg-cyan-200/60 blur-3xl" />
        <div className="absolute right-0 top-36 h-96 w-96 rounded-full bg-indigo-200/60 blur-3xl" />
      </div>
      <section className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-8 sm:px-6 lg:px-8">
        <nav className="flex items-center justify-between rounded-3xl border border-white/70 bg-white/75 p-3 shadow-sm backdrop-blur-xl">
          <Link to="/" className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-950 text-cyan-300">
              <ShieldCheck className="h-6 w-6" />
            </span>
            <span>
              <span className="block text-lg font-black text-slate-950">Specter Agent</span>
              <span className="block text-sm font-semibold text-slate-500">Agentic delivery operations</span>
            </span>
          </Link>
          <div className="hidden items-center gap-2 sm:flex">
            <Badge className="rounded-full bg-emerald-100 px-3 py-1.5 text-emerald-800 hover:bg-emerald-100">Governed workflows</Badge>
            <Badge className="rounded-full bg-cyan-100 px-3 py-1.5 text-cyan-800 hover:bg-cyan-100">Audit-ready</Badge>
          </div>
          <Button asChild className="rounded-2xl bg-indigo-600 px-5 text-white hover:bg-indigo-700">
            <Link to="/dashboard">Open app</Link>
          </Button>
        </nav>

        <div className="grid flex-1 items-center gap-10 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
          <div>
            <Badge className="mb-5 rounded-full bg-amber-100 px-4 py-2 text-amber-900 hover:bg-amber-100">
              <Lock className="mr-2 h-4 w-4" /> Enterprise agent orchestration
            </Badge>
            <h1 className="max-w-4xl text-5xl font-black leading-[0.98] tracking-tight text-slate-950 sm:text-6xl lg:text-7xl">
              Orchestrate secure software delivery with auditable AI agent teams.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-650 sm:text-xl">
              Define governed workflows, assign specialist agents, manage approvals, and produce traceable delivery evidence from one operational workspace.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg" className="rounded-2xl bg-indigo-600 px-6 text-white shadow-xl shadow-indigo-200 hover:bg-indigo-700">
                <Link to="/dashboard">Open Specter Agent <ArrowRight className="ml-2 h-5 w-5" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline" className="rounded-2xl border-slate-200 bg-white px-6 text-slate-800 hover:bg-slate-50">
                <Link to="/workflows/security-review-team/builder">Inspect Security Review Team</Link>
              </Button>
            </div>
          </div>

          <Card className="rounded-[2rem] border-white/80 bg-white/80 shadow-2xl shadow-slate-200/70 backdrop-blur-xl">
            <CardContent className="p-5 sm:p-6">
              <div className="rounded-[1.5rem] bg-slate-950 p-5 text-white">
                <div className="mb-5 flex items-center justify-between">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-[0.24em] text-cyan-200">Security Review Team</p>
                    <h2 className="mt-1 text-2xl font-black">Supervisor delegation run</h2>
                  </div>
                  <Workflow className="h-8 w-8 text-cyan-300" />
                </div>
                <div className="space-y-3">
                  {[
                    ["Supervisor", "Plans bounded review tasks", "bg-indigo-400"],
                    ["Code Reviewer", "Finds insecure patterns", "bg-cyan-300"],
                    ["Dependency Auditor", "Reviews manifests", "bg-emerald-300"],
                    ["Secrets Agent", "Masks sensitive config risks", "bg-amber-300"],
                    ["Approval Gate", "Pauses before final report", "bg-orange-300"],
                  ].map(([label, text, color]) => (
                    <div key={label} className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/10 p-3">
                      <span className={`h-3 w-3 rounded-full ${color}`} />
                      <div className="min-w-0">
                        <p className="font-bold">{label}</p>
                        <p className="text-sm text-slate-300">{text}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="relative grid gap-4 pb-10 md:grid-cols-2 lg:grid-cols-4">
          {capabilities.map((item) => {
            const Icon = item.icon;
            return (
              <Card key={item.title} className="rounded-3xl border-white/80 bg-white/75 shadow-sm backdrop-blur-xl">
                <CardContent className="p-5">
                  <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-700">
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-black text-slate-950">{item.title}</h3>
                  <p className="mt-2 text-sm leading-6 text-slate-600">{item.text}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>
    </main>
  );
};

export default Index;
