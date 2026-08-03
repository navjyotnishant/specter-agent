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
import { getStoredToken, useAuth } from "@/lib/auth";
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
  indigo: { text: "text-[#c92a2a]", bg: "bg-indigo-50", border: "border-indigo-200", chip: "bg-[#fff4e6] text-[#c92a2a]", dot: "bg-indigo-500" },
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

const ST_CLASS: Record<Tone, string> = {
  blue: "sp-st-run", amber: "sp-st-wait", red: "sp-st-bad",
  green: "sp-st-ok", slate: "sp-st-never", indigo: "sp-st-run",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`sp-st sp-st-sm ${ST_CLASS[statusTone(status)]}`}>
      {runStatusLabel(status)}
    </span>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="rounded-[8px] border border-dashed border-slate-200 bg-slate-50 px-4 py-8 text-center">
      <p className="text-sm font-bold text-slate-800">{title}</p>
      <p className="mt-1 text-sm text-slate-500">{detail}</p>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
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

  // Runtime health for the sidebar rail. Built from the queries the page
  // already runs; the mockup's four rows map onto the adapters we know about.
  const runtimeRows = [
    { name: "Host runner",    ok: !hostOffline,                    label: hostOffline ? "offline" : "online" },
    { name: "Docker sandbox", ok: sandboxReady,                    label: sandboxReady ? "ready" : hostOffline ? "unavailable" : "setup needed" },
    { name: "API",            ok: apiReady,                        label: apiReady ? "ok" : "unreachable" },
    { name: "Approved repos", ok: activeWorkspaceCount > 0,        label: `${activeWorkspaceCount} path${activeWorkspaceCount === 1 ? "" : "s"}` },
  ];

  const medianDelta = stats?.median_delta_seconds ?? null;
  const oldestActive = stats?.oldest_active_started_at ?? null;

  return (
    <div className="space-y-4">
      <div className="sp-frame">
        <div className="sp-hdr">
          <h1>Dashboard</h1>
          <p>Local runtime{user?.email ? ` · ${user.email}` : ""}</p>
        </div>

        {/* The page leads with what needs attention, not with counts. When
            nothing does, the banner is absent rather than reassuring — a
            permanent "all clear" strip is scenery people stop reading. */}
        {attention.tone !== "slate" && (
          <div className="sp-att">
            <div className="sp-att-ic"><AttentionIcon className="h-4 w-4" /></div>
            <div>
              <div className="sp-att-tx">{attention.title}</div>
              <div className="sp-att-sb">{attention.detail}</div>
            </div>
            <Link to={attention.href} className="sp-att-go">{attention.action}</Link>
          </div>
        )}

        <div className="sp-tiles">
          <div className="sp-tile">
            <div className="sp-tile-k">Running now</div>
            <div className="sp-tile-v">{stats?.active ?? activeRuns.length}</div>
            {/* "3 running" says nothing about whether one has been stuck for an
                hour, which is the question worth answering. */}
            <div className="sp-tile-d">
              {oldestActive ? `oldest ${timeAgo(oldestActive)}` : "nothing in flight"}
            </div>
          </div>

          <div className="sp-tile">
            <div className="sp-tile-k">Failed · {stats?.window_hours ?? 24}h</div>
            <div className={`sp-tile-v ${stats?.failed ? "sp-tile-v-bad" : ""}`}>
              {stats?.failed ?? failedRuns.length}
            </div>
            <div className="sp-tile-d">
              {stats?.total
                ? `of ${stats.total} runs · ${((stats.failed / stats.total) * 100).toFixed(1)}%`
                : "no runs in window"}
            </div>
          </div>

          <div className="sp-tile">
            <div className="sp-tile-k">Waiting on you</div>
            <div className="sp-tile-v">{stats?.waiting_approval ?? pendingApprovals.length}</div>
            {/* The count comes from the run table and the deadline from the
                approvals list; they can disagree when an approval record has
                not been created yet. Trust the count for "is anything waiting"
                and only add a deadline when there is one to show. */}
            <div className="sp-tile-d">
              {pendingApprovals.length
                ? `approval · ${deadlineText(pendingApprovals[0].expires_at)}`
                : (stats?.waiting_approval ?? 0)
                  ? "awaiting your decision"
                  : "nothing blocked"}
            </div>
          </div>

          <div className="sp-tile">
            <div className="sp-tile-k">Median duration</div>
            <div className="sp-tile-v">
              {stats?.median_duration_seconds
                ? formatDuration2(stats.median_duration_seconds)
                : "—"}
            </div>
            {/* Null delta means no prior window to compare — rendering that as
                "no change" would invent a trend from missing data. */}
            <div className="sp-tile-d">
              {medianDelta === null
                ? "no prior window"
                : medianDelta === 0
                  ? "unchanged"
                  : `${medianDelta < 0 ? "↓" : "↑"} ${formatDuration2(Math.abs(medianDelta))} vs previous`}
            </div>
          </div>
        </div>

        <div className="sp-cols">
          <div className="sp-main">
            <div className="sp-qh">
              <h2>Work queue</h2>
              <Link to="/workflows" className="sp-more">
                View all {runsData.length} →
              </Link>
            </div>

            {runsLoading && <div className="sp-row"><span className="sp-row-mt">Loading runs…</span></div>}

            {!runsLoading && activityRuns.length === 0 && (
              <div className="sp-row">
                <span className="sp-row-mt">
                  No runs yet — start one from Workflows and it will appear here.
                </span>
              </div>
            )}

            {activityRuns.map((run) => {
              const tone = statusTone(run.status);
              return (
                <Link to={runUrl(run)} className="sp-row" key={run.id}>
                  <span className="sp-dot" style={{ background: DOT[tone] }} />
                  <div>
                    <div className="sp-row-nm">{workflowMap[run.workflow_id] ?? "Workflow"}</div>
                    <div className="sp-row-mt">{runStatusLabel(run.status)}</div>
                  </div>
                  <div className="sp-row-rt">
                    <div className="sp-row-el">
                      {run.completed_at
                        ? timeAgo(run.completed_at)
                        : formatDuration(run.created_at, null)}
                    </div>
                    <StatusPill status={run.status} />
                  </div>
                </Link>
              );
            })}
          </div>

          <div className="sp-side">
            <div className="sp-hb">
              <div className="sp-t">Runtime</div>
              {runtimeRows.map((r) => (
                <div className="sp-hl" key={r.name}>
                  <span className="sp-p" style={{ background: r.ok ? "#16a34a" : "#dc2626" }} />
                  {r.name}
                  <span className="sp-st2">{r.label}</span>
                </div>
              ))}
            </div>

            <div className="sp-hb">
              <div className="sp-t">Quick actions</div>
              <Link to="/workflows" className="sp-qa">▶ Run a workflow…</Link>
              <Link to="/workflows" className="sp-qa">⤓ Import from a repo</Link>
              <Link to="/workflows" className="sp-qa">☷ Browse run history</Link>
            </div>

            <div className="sp-hb">
              <div className="sp-t">Library</div>
              <div className="sp-hl">
                Workflows<span className="sp-st2">{userWorkflows.length}</span>
              </div>
              <div className="sp-hl">
                Skills<span className="sp-st2">{skillsData.length}</span>
              </div>
              <div className="sp-hl">
                Sandbox policy<span className="sp-st2">{policyName}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Dot colour per run state. The queue row carries its state in the dot as well
 *  as the pill, so the column scans without reading each label. */
const DOT: Record<string, string> = {
  blue: "#2563eb",
  amber: "#d97706",
  red: "#dc2626",
  green: "#16a34a",
  slate: "#94a3b8",
};
