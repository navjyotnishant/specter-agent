import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Cpu,
  GitBranch,
  HardDrive,
  History,
  LockKeyhole,
  MemoryStick,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import { getStoredToken } from "@/lib/auth";
import type { WorkflowRun } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type Tone = "green" | "blue" | "amber" | "red" | "slate" | "indigo";

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const normalized = value.endsWith("Z") || value.includes("+") ? value : `${value}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDuration2(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return m < 60 ? `${m}m${sec ? ` ${sec}s` : ""}` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeAgo(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "not recorded";
  const diffMs = Math.max(0, Date.now() - date.getTime());
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function deadlineText(value: string | null | undefined): string {
  const date = parseDate(value);
  if (!date) return "No deadline";
  const diffMs = date.getTime() - Date.now();
  const absSeconds = Math.abs(Math.floor(diffMs / 1000));
  const minutes = Math.floor(absSeconds / 60);
  const hours = Math.floor(minutes / 60);
  const label = hours >= 1 ? `${hours}h` : `${Math.max(1, minutes)}m`;
  return diffMs >= 0 ? `Due in ${label}` : `Expired ${label} ago`;
}

function formatDuration(start: string, end: string | null): string {
  const startDate = parseDate(start);
  // A null completed_at means the run is still going, not that it has no
  // duration -- returning "-" hid elapsed time on exactly the rows an operator
  // is watching.
  const endDate = parseDate(end) ?? (startDate ? new Date() : null);
  if (!startDate || !endDate) return "-";
  const seconds = Math.max(0, Math.floor((endDate.getTime() - startDate.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatBytes(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? Math.round(size) : size.toFixed(1)} ${units[unitIndex]}`;
}

function runUrl(run: WorkflowRun): string {
  return `/workflows/${run.workflow_id}/run/${run.id}`;
}

function runStatusLabel(status: string): string {
  if (status === "waiting_approval") return "Approval";
  if (status === "revision_requested") return "Revision";
  return status.replace(/_/g, " ");
}

const toneClasses: Record<Tone, { text: string; bg: string; border: string; chip: string; dot: string }> = {
  green: { text: "text-emerald-800", bg: "bg-emerald-50", border: "border-emerald-200", chip: "bg-emerald-100 text-emerald-800", dot: "bg-emerald-500" },
  blue: { text: "text-blue-800", bg: "bg-blue-50", border: "border-blue-200", chip: "bg-blue-100 text-blue-800", dot: "bg-blue-500" },
  amber: { text: "text-amber-900", bg: "bg-amber-50", border: "border-amber-200", chip: "bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  red: { text: "text-red-800", bg: "bg-red-50", border: "border-red-200", chip: "bg-red-100 text-red-800", dot: "bg-red-500" },
  slate: { text: "text-slate-700", bg: "bg-slate-50", border: "border-slate-200", chip: "bg-slate-100 text-slate-700", dot: "bg-slate-400" },
  indigo: { text: "text-indigo-800", bg: "bg-indigo-50", border: "border-indigo-200", chip: "bg-indigo-100 text-indigo-800", dot: "bg-indigo-500" },
};

function statusTone(status: string): Tone {
  if (status === "completed") return "green";
  if (status === "running" || status === "queued") return "blue";
  if (status === "waiting_approval") return "amber";
  if (status === "failed") return "red";
  return "slate";
}

function healthTone(status: string | undefined): Tone {
  if (status === "healthy") return "green";
  if (status === "warning") return "amber";
  if (status === "critical") return "red";
  return "slate";
}

function StatusPill({ status }: { status: string }) {
  const tone = toneClasses[statusTone(status)];
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold capitalize ${tone.chip}`}>
      {runStatusLabel(status)}
    </span>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
      <p className="text-sm font-bold text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

export default function Dashboard() {
  const token = getStoredToken() ?? "";
  const canUseBackend = Boolean(token);

  const { data: healthData, isLoading: healthLoading } = useQuery({ queryKey: ["health"], queryFn: api.health, retry: false });
  const { data: systemHealthData } = useQuery({
    queryKey: ["dashboard", "system-health"],
    queryFn: api.systemHealth,
    retry: false,
    refetchInterval: 10000,
  });
  const { data: workflowsData = [], isLoading: workflowsLoading } = useQuery({
    queryKey: ["dashboard", "workflows"],
    queryFn: () => api.workflows(token),
    enabled: canUseBackend,
    retry: false,
  });
  const { data: runsData = [], isLoading: runsLoading } = useQuery({
    queryKey: ["dashboard", "runs"],
    queryFn: () => api.listRuns(token),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 8000,
  });
  const { data: approvalsData = [] } = useQuery({
    queryKey: ["dashboard", "approvals"],
    queryFn: () => api.approvals(token),
    // Gated like every other query on this page: it now requires auth, and an
    // ungated call would 401 on every poll while signed out.
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 10000,
  });
  const { data: stats } = useQuery({
    queryKey: ["dashboard", "run-stats"],
    queryFn: () => api.runStats(token, 24),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });
  const { data: skillsData = [] } = useQuery({
    queryKey: ["dashboard", "skills"],
    queryFn: () => api.skills(token),
    enabled: canUseBackend,
    retry: false,
  });
  const { data: sandboxStatus } = useQuery({
    queryKey: ["dashboard", "sandbox-status"],
    queryFn: () => api.dockerSandboxRuntimeStatus(token),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 15000,
  });
  const { data: sandboxPolicy } = useQuery({
    queryKey: ["dashboard", "sandbox-policy"],
    queryFn: () => api.dockerSandboxPolicy(token),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 20000,
  });
  const { data: workspacesData = [] } = useQuery({
    queryKey: ["dashboard", "workspaces"],
    queryFn: () => api.runtimeWorkspaces(token),
    enabled: canUseBackend,
    retry: false,
  });

  const workflowMap = useMemo(() => {
    const map: Record<string, string> = {};
    for (const workflow of workflowsData) map[workflow.id] = workflow.name;
    return map;
  }, [workflowsData]);

  const userWorkflows = workflowsData.filter((workflow) => !workflow.is_template);
  const pendingApprovals = approvalsData.filter((approval) => approval.status === "pending");
  const activeRuns = runsData.filter((run) => ["queued", "running", "waiting_approval"].includes(run.status));
  const failedRuns = runsData.filter((run) => run.status === "failed");
  const completedRuns = runsData.filter((run) => run.status === "completed");
  const attentionRuns = runsData.filter((run) => ["failed", "waiting_approval", "running", "queued"].includes(run.status));
  const activityRuns = [...attentionRuns, ...runsData.filter((run) => !attentionRuns.includes(run))].slice(0, 8);
  // Ordered by completion, not creation: a long run started earlier can finish
  // after a short one, so created_at order named the wrong "last" run.
  const byCompletion = (a: WorkflowRun, b: WorkflowRun) =>
    String(b.completed_at ?? "").localeCompare(String(a.completed_at ?? ""));
  const lastSuccessfulRun = [...completedRuns].sort(byCompletion)[0] ?? null;
  const lastFailedRun = [...failedRuns].sort(byCompletion)[0] ?? null;

  const apiReady = healthData?.api === "ok";
  const sandboxReady = sandboxStatus?.status === "ready";
  const sandboxAvailable = sandboxStatus?.available === true;
  const hostOffline = sandboxStatus?.status === "host_runner_unavailable";
  const activeWorkspaceCount = workspacesData.filter((workspace) => workspace.is_active).length;
  const policyName = sandboxPolicy?.current_policy ?? sandboxPolicy?.policy ?? "unknown";
  const runtimeLabel = sandboxReady ? "Sandbox ready" : hostOffline ? "Host runner offline" : sandboxAvailable ? "Sandbox degraded" : "Setup required";

  const attention = (() => {
    if (!canUseBackend) {
      return {
        tone: "amber" as Tone,
        icon: AlertTriangle,
        title: "Backend session required",
        detail: "Sign in to view live workflow evidence and sandbox posture.",
        action: "Sign in",
        href: "/login",
      };
    }
    if (pendingApprovals.length > 0) {
      return {
        tone: "amber" as Tone,
        icon: AlertTriangle,
        title: `${pendingApprovals.length} approval${pendingApprovals.length > 1 ? "s" : ""} waiting`,
        detail: "Human gates are blocking workflow completion.",
        action: "Review approvals",
        href: "/workflows",
      };
    }
    if (failedRuns.length > 0) {
      return {
        tone: "red" as Tone,
        icon: XCircle,
        title: "Failed run needs review",
        detail: `${workflowMap[failedRuns[0].workflow_id] ?? "Workflow"} failed ${timeAgo(failedRuns[0].completed_at ?? failedRuns[0].created_at)}.`,
        action: "Open evidence",
        href: runUrl(failedRuns[0]),
      };
    }
    if (!sandboxReady) {
      return {
        tone: "amber" as Tone,
        icon: LockKeyhole,
        title: "Sandbox posture needs attention",
        detail: sandboxStatus?.message ?? "Sandbox readiness is required before reliable isolated runs.",
        action: "Manage runtime",
        href: "/settings/models",
      };
    }
    // Consult the SQL aggregate before claiming all-clear. failedRuns is filtered
    // from a page of recent runs, so a failure just outside that page produced a
    // confident green banner while the system was in fact failing.
    if (stats && stats.failed > 0) {
      return {
        tone: "amber" as Tone,
        icon: AlertTriangle,
        title: `${stats.failed} run${stats.failed === 1 ? "" : "s"} failed in the last 24h`,
        detail: "Not visible in the recent list below — open the workflows page to review.",
        action: "Review failures",
        href: "/workflows",
      };
    }
    return {
      tone: "green" as Tone,
      icon: CheckCircle2,
      title: "All clear",
      detail: stats
        ? `No failures in the last ${stats.window_hours}h and nothing waiting on you.`
        : "No pending approvals or failed runs are blocking attention.",
      action: "Open workflows",
      href: "/workflows",
    };
  })();
  const AttentionIcon = attention.icon;
  const attentionTone = toneClasses[attention.tone];

  const metrics = [
    {
      label: "Running now",
      value: stats?.active ?? activeRuns.length,
      detail: (stats?.active ?? activeRuns.length)
        ? `${stats?.active ?? activeRuns.length} in motion`
        : "No live runs",
      icon: Activity,
      tone: (stats?.active ?? activeRuns.length) ? "blue" as Tone : "slate" as Tone,
      href: "/workflows",
    },
    {
      label: "Approval queue",
      value: pendingApprovals.length,
      detail: pendingApprovals[0] ? deadlineText(pendingApprovals[0].expires_at) : "No gates waiting",
      icon: AlertTriangle,
      tone: pendingApprovals.length ? "amber" as Tone : "slate" as Tone,
      href: "/workflows",
    },
    {
      // From /stats, aggregated in SQL. This used to be runsData.length -- a count
      // of the truncated page, so it froze once more runs existed than fit.
      label: "Failed · 24h",
      value: stats?.failed ?? 0,
      detail: stats?.total
        ? `of ${stats.total} run${stats.total === 1 ? "" : "s"} · ${((stats.failed / stats.total) * 100).toFixed(1)}%`
        : "No runs in the last 24h",
      icon: History,
      tone: (stats?.failed ? "red" : "slate") as Tone,
      href: "/workflows",
    },
    {
      // Replaces a skill count, which never changed and never needed action --
      // and whose detail line counted workflows, an unrelated number.
      label: "Median duration",
      value: stats?.median_duration_seconds ? formatDuration2(stats.median_duration_seconds) : "—",
      detail: stats?.completed ? `across ${stats.completed} completed` : "No completed runs yet",
      icon: Activity,
      tone: "indigo" as Tone,
      href: "/workflows",
    },
  ];

  const postureItems = [
    {
      label: "API",
      value: healthLoading ? "Checking" : apiReady ? "Operational" : "Degraded",
      detail: `SQLite ${healthData?.sqlite ?? "-"} · Scheduler ${healthData?.scheduler ?? "-"}`,
      tone: apiReady ? "green" as Tone : "red" as Tone,
    },
    {
      label: "Isolation",
      value: runtimeLabel,
      detail: sandboxStatus?.base_image ?? sandboxStatus?.message ?? "Sandbox status unavailable",
      tone: sandboxReady ? "green" as Tone : "amber" as Tone,
    },
    {
      label: "Policy",
      value: String(policyName),
      detail: sandboxPolicy?.message ?? "Network policy signal from sbx",
      tone: policyName === "deny-all" ? "green" as Tone : policyName === "balanced" ? "blue" as Tone : "amber" as Tone,
    },
    {
      label: "Approved repos",
      value: String(activeWorkspaceCount),
      detail: activeWorkspaceCount ? "Workspace allowlist active" : "No repositories approved",
      tone: activeWorkspaceCount ? "green" as Tone : "amber" as Tone,
    },
  ];

  const hostHealthItems = [
    {
      label: "CPU load",
      value: systemHealthData?.load.load_1 !== null && systemHealthData?.load.load_1 !== undefined ? String(systemHealthData.load.load_1) : "-",
      detail: systemHealthData?.load.pressure_percent !== null && systemHealthData?.load.pressure_percent !== undefined
        ? `${systemHealthData.load.pressure_percent}% pressure · ${systemHealthData.load.cpu_count ?? "-"} cores`
        : systemHealthData?.load.message ?? "Waiting for sample",
      icon: Cpu,
      tone: healthTone(systemHealthData?.load.status),
    },
    {
      label: "Memory",
      value: systemHealthData?.memory.used_percent !== null && systemHealthData?.memory.used_percent !== undefined ? `${systemHealthData.memory.used_percent}%` : "-",
      detail: systemHealthData?.memory.used_bytes !== null && systemHealthData?.memory.used_bytes !== undefined
        ? `${formatBytes(systemHealthData.memory.used_bytes)} / ${formatBytes(systemHealthData.memory.total_bytes)}`
        : systemHealthData?.memory.message ?? "Waiting for sample",
      icon: MemoryStick,
      tone: healthTone(systemHealthData?.memory.status),
    },
    {
      label: "Disk",
      value: systemHealthData?.disk.used_percent !== null && systemHealthData?.disk.used_percent !== undefined ? `${systemHealthData.disk.used_percent}%` : "-",
      detail: systemHealthData?.disk.free_bytes !== null && systemHealthData?.disk.free_bytes !== undefined
        ? `${formatBytes(systemHealthData.disk.free_bytes)} free for local data`
        : systemHealthData?.disk.message ?? "Waiting for sample",
      icon: HardDrive,
      tone: healthTone(systemHealthData?.disk.status),
    },
  ];

  return (
    <div className="space-y-5">
      <section className={`rounded-2xl border px-5 py-4 ${attentionTone.border} ${attentionTone.bg}`}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${attentionTone.chip}`}>
              <AttentionIcon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <p className={`text-sm font-black uppercase tracking-[0.12em] ${attentionTone.text}`}>Attention</p>
              <h2 className="mt-1 text-xl font-black text-slate-950">{attention.title}</h2>
              <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">{attention.detail}</p>
            </div>
          </div>
          <Button asChild className="h-10 rounded-xl bg-slate-950 px-4 text-white hover:bg-slate-800">
            <Link to={attention.href}>
              {attention.action}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          const tone = toneClasses[metric.tone];
          return (
            <Link key={metric.label} to={metric.href} className="group">
              <Card className="rounded-2xl border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-slate-500">{metric.label}</p>
                      <p className="mt-2 text-3xl font-black text-slate-950">{metric.value}</p>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-500">{metric.detail}</p>
                    </div>
                    <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone.chip}`}>
                      <Icon className="h-5 w-5" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </section>

      <section className="grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(360px,0.55fr)]">
        <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between gap-4 border-b border-slate-100 px-5 py-4">
            <div>
              <CardTitle className="text-lg font-black text-slate-950">Work queue</CardTitle>
              <p className="mt-1 text-sm text-slate-500">Active gates, failed evidence, and recent workflow outcomes.</p>
            </div>
            <Button asChild variant="outline" className="h-9 rounded-xl border-slate-200 bg-white px-3 text-sm">
              <Link to="/workflows">
                View all
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent className="p-4">
            {runsLoading || workflowsLoading ? (
              <EmptyState title="Loading workflow activity" detail="Collecting recent run evidence." />
            ) : activityRuns.length === 0 ? (
              <EmptyState title="No workflow evidence yet" detail="Start a workflow to populate the operations queue." />
            ) : (
              <div className="space-y-2">
                {activityRuns.map((run) => {
                  const tone = toneClasses[statusTone(run.status)];
                  const workflowName = workflowMap[run.workflow_id] ?? run.workflow_id.slice(0, 8);
                  const isPriority = ["failed", "waiting_approval", "running", "queued"].includes(run.status);
                  return (
                    <Link
                      key={run.id}
                      to={runUrl(run)}
                      className={`flex flex-col gap-3 rounded-xl border px-4 py-3 transition hover:border-indigo-200 hover:bg-indigo-50/30 sm:flex-row sm:items-center sm:justify-between ${
                        isPriority ? `${tone.border} ${tone.bg}` : "border-slate-100 bg-white"
                      }`}
                    >
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${tone.dot}`} />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-black text-slate-900">{workflowName}</p>
                          <p className="mt-1 text-xs text-slate-500">
                            Started {timeAgo(run.created_at)} · Duration {formatDuration(run.created_at, run.completed_at)}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <StatusPill status={run.status} />
                        <ArrowRight className="h-4 w-4 text-slate-400" />
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-5">
          <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
            <CardHeader className="border-b border-slate-100 px-5 py-4">
              <CardTitle className="flex items-center gap-2 text-lg font-black text-slate-950">
                <ShieldCheck className="h-5 w-5 text-indigo-600" />
                Sandbox posture
              </CardTitle>
              <p className="text-sm text-slate-500">Signals only. Runtime configuration stays in Models.</p>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              {postureItems.map((item) => {
                const tone = toneClasses[item.tone];
                return (
                  <div key={item.label} className={`rounded-xl border px-3 py-3 ${tone.border} ${tone.bg}`}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{item.label}</p>
                      <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                    </div>
                    <p className="mt-1 text-sm font-black text-slate-950">{item.value}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{item.detail}</p>
                  </div>
                );
              })}
              <Button asChild variant="outline" className="h-9 w-full rounded-xl border-slate-200 bg-white">
                <Link to="/settings/models">
                  <LockKeyhole className="mr-2 h-4 w-4" />
                  Runtime posture
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
            <CardHeader className="border-b border-slate-100 px-5 py-4">
              <CardTitle className="flex items-center gap-2 text-lg font-black text-slate-950">
                <Activity className="h-5 w-5 text-indigo-600" />
                Host health
              </CardTitle>
              <p className="text-sm text-slate-500">Local capacity signals for safe workflow execution.</p>
            </CardHeader>
            <CardContent className="space-y-3 p-4">
              {hostHealthItems.map((item) => {
                const Icon = item.icon;
                const tone = toneClasses[item.tone];
                return (
                  <div key={item.label} className="flex items-center gap-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${tone.chip}`}>
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-3">
                        <p className="truncate text-sm font-black text-slate-950">{item.label}</p>
                        <span className={`h-2.5 w-2.5 rounded-full ${tone.dot}`} />
                      </div>
                      <p className="mt-1 truncate text-xs font-semibold text-slate-500">{item.detail}</p>
                    </div>
                    <p className="shrink-0 text-sm font-black text-slate-900">{item.value}</p>
                  </div>
                );
              })}
              <p className="px-1 text-xs font-semibold text-slate-400">
                Sampled {systemHealthData ? timeAgo(systemHealthData.sampled_at) : "after load"}
              </p>
            </CardContent>
          </Card>

          <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
            <CardHeader className="border-b border-slate-100 px-5 py-4">
              <CardTitle className="flex items-center gap-2 text-lg font-black text-slate-950">
                <SquareTerminal className="h-5 w-5 text-indigo-600" />
                Quick actions
              </CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 p-4">
              <Button asChild className="h-10 justify-start rounded-xl bg-indigo-600 text-white hover:bg-indigo-700">
                <Link to="/workflows">
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Run workflow
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-10 justify-start rounded-xl border-slate-200 bg-white">
                <Link to="/workflows">
                  <GitBranch className="mr-2 h-4 w-4" />
                  Build workflow
                </Link>
              </Button>
              <Button asChild variant="outline" className="h-10 justify-start rounded-xl border-slate-200 bg-white">
                <Link to="/skills">
                  <Sparkles className="mr-2 h-4 w-4" />
                  Manage skills
                </Link>
              </Button>
            </CardContent>
          </Card>
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2">
        <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              <div>
                <p className="text-sm font-black text-slate-950">Last successful run</p>
                <p className="mt-1 text-sm text-slate-500">
                  {lastSuccessfulRun
                    ? `${workflowMap[lastSuccessfulRun.workflow_id] ?? "Workflow"} · ${timeAgo(lastSuccessfulRun.completed_at ?? lastSuccessfulRun.created_at)}`
                    : "No successful evidence yet"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-2xl border-slate-200 bg-white shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center gap-3">
              <Clock3 className="h-5 w-5 text-slate-500" />
              <div>
                <p className="text-sm font-black text-slate-950">Last failed run</p>
                <p className="mt-1 text-sm text-slate-500">
                  {lastFailedRun
                    ? `${workflowMap[lastFailedRun.workflow_id] ?? "Workflow"} · ${timeAgo(lastFailedRun.completed_at ?? lastFailedRun.created_at)}`
                    : "No failed evidence in recent history"}
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
