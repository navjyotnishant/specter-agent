import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import MarkdownIt from "markdown-it";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Box,
  CheckCircle2,
  Copy,
  ChevronDown,
  ChevronRight,
  FolderSearch,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { RuntimeAdapterStatus } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/hooks/use-toast";
import { useModelPreference } from "@/lib/model-preference";

const codexSigninCommand = "codex";
const dockerSandboxMacInstallCommand = "brew install docker/tap/sbx";
const dockerSandboxWindowsInstallCommand = "winget install Docker.sbx";
const runnerSafeCommand = "python3 scripts/specter_host_runner.py";

const SANDBOX_AGENTS: Record<string, { label: string; authCommand: string; template: string }> = {
  codex:  { label: "Codex",       authCommand: "sbx secret set -g openai --oauth", template: "docker/sandbox-templates:codex" },
  claude: { label: "Claude Code", authCommand: "sbx secret set -g anthropic",      template: "docker/sandbox-templates:claude-code" },
  cursor: { label: "Cursor",      authCommand: "sbx run cursor",                   template: "docker/sandbox-templates:cursor-agent-docker" },
};
const runnerMaintenanceCommand = "SPECTER_HOST_RUNNER_ENABLE_INSTALL=1 python3 scripts/specter_host_runner.py";
const defaultRuntimePrompt = "Summarize this repository structure and identify the main application entry points. Do not modify files.";

const sandboxPolicyDescriptions: Record<string, string> = {
  "balanced": "AI services, package registries, code hosts, and common development endpoints.",
  "deny-all": "Blocks outbound network traffic until explicit rules are added.",
  "allow-all": "Allows outbound network traffic from sandboxes.",
};

function runtimeBadge(status?: RuntimeAdapterStatus) {
  if (!status) return { label: "Checking", className: "bg-slate-100 text-slate-700" };
  if (status.status === "ready") return { label: "Ready", className: "bg-emerald-100 text-emerald-800" };
  if (status.status === "missing") return { label: "Missing", className: "bg-amber-100 text-amber-800" };
  if (status.status === "host_runner_unavailable") return { label: "Offline", className: "bg-slate-100 text-slate-700" };
  return { label: "Action needed", className: "bg-amber-100 text-amber-800" };
}

function statusLine(status?: RuntimeAdapterStatus) {
  if (status?.status === "host_runner_unavailable") return "Start the host runner.";
  if (!status?.installed) return "Install Codex CLI.";
  if (status.outdated === true && status.latest_version) return `Update available: ${status.current_version ?? "current"} -> ${status.latest_version}`;
  if (status.current_version) return `Codex ${status.current_version}`;
  if (status.version) return `Codex ${status.version}`;
  return status?.message ?? "Runtime status unavailable.";
}

function sandboxStatusLine(status?: RuntimeAdapterStatus) {
  if (status?.status === "host_runner_unavailable") return "Start the host runner.";
  if (status?.status === "missing" || !status?.sbx_installed) return "Install Docker Sandboxes CLI.";
  if (status.sandbox_health_status === "daemon_unavailable") return "Start Docker Sandboxes daemon.";
  if (status.sandbox_health_status === "cli_available") return `sbx ${status.current_version ?? status.sbx_version ?? "installed"}`;
  return status?.message ?? "Docker Sandbox status unavailable.";
}

function shortPath(path?: string) {
  if (!path) return "";
  const parts = path.split("/");
  return parts.length > 3 ? `.../${parts.slice(-3).join("/")}` : path;
}

/** One link in the dependency chain. Green when healthy, amber when partially
 *  ready, red when down — the pip carries the state so the row reads at a
 *  glance without parsing the label. */
function ChainLink({ tone, name, detail }: { tone: "ok" | "warn" | "bad"; name: string; detail: string }) {
  const PIP = { ok: "#16a34a", warn: "#d97706", bad: "#dc2626" };
  return (
    <div className="sp-chain-lk">
      <span className="sp-chain-pip" style={{ background: PIP[tone] }} />
      <span>
        <span className="sp-chain-n">{name}</span>{" "}
        <span className="sp-chain-s">{detail}</span>
      </span>
    </div>
  );
}

/** Runtime dependency chain: host runner → sandbox → agents → approved repos.
 *
 *  Rendered as a chain because that is what it is. Each link depends on the one
 *  to its left, so when the host runner is down every card to the right of it is
 *  reporting a symptom rather than a cause. */
function DependencyChain({
  hostRunnerOnline, hostRunnerVersion, sandboxReady, sandboxLabel,
  agentsReady, agentsTotal, approvedPaths,
}: {
  hostRunnerOnline: boolean;
  hostRunnerVersion: string | null;
  sandboxReady: boolean;
  sandboxLabel: string;
  agentsReady: number;
  agentsTotal: number;
  approvedPaths: number;
}) {
  const arrow = <span className="sp-chain-arw">→</span>;
  return (
    <div className="sp-chain">
      <ChainLink
        tone={hostRunnerOnline ? "ok" : "bad"}
        name="Host runner"
        detail={`${hostRunnerVersion ? `${hostRunnerVersion} · ` : ""}${hostRunnerOnline ? "online" : "offline"}`}
      />
      {arrow}
      <ChainLink
        tone={sandboxReady ? "ok" : "warn"}
        name="Docker sandbox"
        detail={sandboxLabel}
      />
      {arrow}
      <ChainLink
        tone={agentsTotal && agentsReady === agentsTotal ? "ok" : agentsReady ? "warn" : "bad"}
        name="Agents"
        detail={`${agentsReady} of ${agentsTotal} ready`}
      />
      {arrow}
      {/* Zero approved paths is not a healthy state: nothing can run. */}
      <ChainLink
        tone={approvedPaths ? "ok" : "warn"}
        name="Approved repos"
        detail={`${approvedPaths} path${approvedPaths === 1 ? "" : "s"}`}
      />
    </div>
  );
}

/** One agent's state in a given runtime. The design distinguishes three, and
 *  the distinction is the point: an uninstalled agent needs an install command,
 *  an unauthenticated one needs a login, and conflating them sends people to the
 *  wrong fix. Sandbox mode additionally needs the daemon up. */
function AgentState({ installed, authenticated, runtimeUp, rateLimited }: {
  installed: boolean; authenticated: boolean; runtimeUp: boolean; rateLimited?: boolean | null;
}) {
  if (!installed) return <span className="sp-st sp-st-no">not installed</span>;
  if (!runtimeUp) return <span className="sp-st sp-st-auth">daemon down</span>;
  if (!authenticated) return <span className="sp-st sp-st-auth">login needed</span>;
  // Installed and signed in, but the provider is refusing calls. Distinct from
  // "ready" because nothing will run, and distinct from "login needed" because
  // signing in again does not help — you wait, or switch agent.
  if (rateLimited) return <span className="sp-st sp-st-lim">rate limited</span>;
  return <span className="sp-st sp-st-ok">ready</span>;
}

export default function Models() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [copiedCommand, setCopiedCommand] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState<string>("all");
  const [logSince, setLogSince] = useState(0);
  const [sandboxAgent, setSandboxAgent] = useState<string>(() => {
    try { return localStorage.getItem("specter_sandbox_agent") ?? "claude"; } catch { return "claude"; }
  });
  const [discoveryRoot, setDiscoveryRoot] = useState("");
  const [selectedDiscoveredPaths, setSelectedDiscoveredPaths] = useState<string[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [runtimePrompt, setRuntimePrompt] = useState(defaultRuntimePrompt);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<string | null>(null);
  const [directoryScanOpen, setDirectoryScanOpen] = useState(false);
  // Open by default: this is the authoritative answer to "what can agents
  // touch?", and collapsed behind a Show toggle it never gets audited.
  const [approvedOpen, setApprovedOpen] = useState(true);
  const [testOpen, setTestOpen] = useState(false);
  const [testRuntime, setTestRuntime] = useState<"sandbox" | "direct">("sandbox");
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const liveOutputRef = useRef<HTMLPreElement>(null);
  const md = useMemo(() => new MarkdownIt({ linkify: true, breaks: true }), []);

  // Direct CLI state
  const [cliAgent, setCliAgent] = useState<string>(() => {
    try { return localStorage.getItem("specter_cli_agent") ?? "claude"; } catch { return "claude"; }
  });
  const [cliActiveRunStartedAt, setCliActiveRunStartedAt] = useState<string | null>(null);
  const [cliOutputExpanded, setCliOutputExpanded] = useState(false);
  const [cliShowRaw, setCliShowRaw] = useState(false);
  const cliLiveOutputRef = useRef<HTMLPreElement>(null);

  const canUseBackend = Boolean(token);
  const { data: codexRuntime, isLoading: runtimeLoading } = useQuery({
    queryKey: ["runtime-adapter", "codex-cli"],
    queryFn: () => api.codexRuntimeStatus(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const { data: dockerSandboxRuntime, isLoading: sandboxRuntimeLoading } = useQuery({
    queryKey: ["runtime-adapter", "docker-sandbox"],
    queryFn: () => api.dockerSandboxRuntimeStatus(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const { data: directCliRuntime, isLoading: directCliLoading } = useQuery({
    queryKey: ["runtime-adapter", "direct-cli"],
    queryFn: () => api.directCliStatus(token ?? ""),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 30000,
  });
  const { data: runnerMode } = useQuery({
    queryKey: ["host-runner", "mode"],
    queryFn: () => api.hostRunnerMode(token ?? ""),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
  });
  const { data: runnerLogs } = useQuery({
    queryKey: ["host-runner", "logs", logLevelFilter],
    queryFn: () => api.hostRunnerLogs(token ?? "", 0, logLevelFilter === "all" ? undefined : logLevelFilter),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
    refetchInterval: activeRunStartedAt ? 1000 : 3000,
    select: (data) => {
      if (data.latest_seq > logSince) setLogSince(data.latest_seq);
      return data;
    },
  });
  const { data: sandboxPolicy } = useQuery({
    queryKey: ["runtime-adapter", "docker-sandbox", "policy"],
    queryFn: () => api.dockerSandboxPolicy(token ?? ""),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
  });
  const { data: runtimeWorkspaces = [] } = useQuery({
    queryKey: ["runtime-workspaces"],
    queryFn: () => api.runtimeWorkspaces(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const modelsQuery = useQuery({
    queryKey: ["agent-models"],
    queryFn: () => api.agentModels(token ?? ""),
    enabled: canUseBackend,
    retry: false,
    staleTime: 55 * 60 * 1000,   // the host runner caches for an hour
  });
  const agentModelSets = modelsQuery.data?.agents ?? {};
  const [preference, setPreference] = useModelPreference();

  const { data: allWorkflows = [] } = useQuery({
    queryKey: ["workflows"],
    queryFn: () => api.workflows(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });

  const { data: runtimeRuns = [] } = useQuery({
    queryKey: ["runtime-runs", "codex-cli"],
    queryFn: () => api.codexRuntimeRuns(token ?? ""),
    enabled: canUseBackend,
    retry: false,
  });
  const { data: launchdSvc, refetch: refetchLaunchd } = useQuery({
    queryKey: ["host-runner", "launchd"],
    queryFn: () => api.launchdStatus(token ?? ""),
    enabled: canUseBackend,
    retry: false,
    refetchInterval: 8000,
  });
  const { data: hostRunnerVersion } = useQuery({
    queryKey: ["host-runner", "version"],
    queryFn: () => api.hostRunnerVersion(token ?? ""),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
    refetchInterval: 30000,
  });

  const installLaunchd = useMutation({
    mutationFn: () => api.launchdInstall(token ?? ""),
    onSuccess: () => { void refetchLaunchd(); },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to install launchd service"),
  });
  const uninstallLaunchd = useMutation({
    mutationFn: () => api.launchdUninstall(token ?? ""),
    onSuccess: () => { void refetchLaunchd(); },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to uninstall launchd service"),
  });
  const restartLaunchd = useMutation({
    mutationFn: () => api.launchdRestart(token ?? ""),
    onSuccess: () => { window.setTimeout(() => { void refetchLaunchd(); }, 1200); },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to restart host runner"),
  });

  const installCodex = useMutation({
    mutationFn: () => api.installCodexRuntime(token ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "codex-cli"] }),
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to start Codex CLI install"),
  });
  const upgradeCodex = useMutation({
    mutationFn: () => api.upgradeCodexRuntime(token ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "codex-cli"] }),
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to start Codex CLI upgrade"),
  });
  const setRunnerMode = useMutation({
    mutationFn: (maintenanceEnabled: boolean) => api.setHostRunnerMode(token ?? "", maintenanceEnabled),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["host-runner", "mode"] });
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
      queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "codex-cli"] });
      queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to update host runner mode"),
  });
  const startSandboxDaemon = useMutation({
    mutationFn: () => api.startDockerSandboxDaemon(token ?? ""),
    onSuccess: () => {
      window.setTimeout(() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] }), 1500);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to start sbx daemon"),
  });
  const setSandboxPolicy = useMutation({
    mutationFn: (policy: "allow-all" | "balanced" | "deny-all") => api.setDockerSandboxPolicy(token ?? "", policy),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox", "policy"] });
      queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] });
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to update Docker Sandbox policy"),
  });
  // Revoking access is the one mutation on this page that had no error handler,
  // so a refused revoke left the row in place with no message — the user could
  // not tell whether access had actually been removed. For a security control
  // that failure mode is worse than the error itself.
  const deleteWorkspace = useMutation({
    mutationFn: (id: string) => api.deleteRuntimeWorkspace(token ?? "", id),
    onSuccess: () => {
      setSelectedWorkspaceId("");
      setError("");
      queryClient.invalidateQueries({ queryKey: ["runtime-workspaces"] });
    },
    onError: (err) =>
      setError(err instanceof Error
        ? `Could not revoke access: ${err.message}`
        : "Could not revoke access — the path is still approved."),
  });
  const discoverRepositories = useMutation({
    mutationFn: () => api.discoverRepositories(token ?? "", { root_path: discoveryRoot, max_depth: 3, max_results: 50 }),
    onSuccess: () => {
      setSelectedDiscoveredPaths([]);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to discover repositories"),
  });
  const approveSelectedRepositories = useMutation({
    mutationFn: async () => {
      const repositories = discoverRepositories.data?.repositories ?? [];
      const selected = repositories.filter((repo) => selectedDiscoveredPaths.includes(repo.path));
      // allSettled, not all: with Promise.all a rejection part-way through left
      // the earlier repositories approved server-side while the error implied
      // nothing had happened -- on an access-control list, the user's belief
      // about what agents can reach would diverge from reality.
      const results = await Promise.allSettled(
        selected.map((repo) => api.createRuntimeWorkspace(token ?? "", { name: repo.name, path: repo.path })),
      );
      const ok = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
      const failed = selected.filter((_, i) => results[i].status === "rejected").map((r) => r.path);
      return { ok, failed };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok[0]) setSelectedWorkspaceId(ok[0].id);
      setSelectedDiscoveredPaths([]);
      queryClient.invalidateQueries({ queryKey: ["runtime-workspaces"] });
      setError(
        failed.length
          ? `Approved ${ok.length} of ${ok.length + failed.length}. Failed: ${failed.join(", ")}`
          : "",
      );
    },
    onError: (err) => setError(err instanceof Error ? err.message : "Unable to approve selected repositories"),
  });
  const createRuntimeRun = useMutation({
    mutationFn: () =>
      api.createCodexRuntimeRun(token ?? "", {
        workspace_id: selectedWorkspaceId,
        prompt: runtimePrompt,
        mode: "read-only",
        timeout_seconds: 180,
        agent: sandboxAgent,
      }),
    onMutate: () => {
      setActiveRunStartedAt(new Date().toLocaleTimeString());
      setTestOpen(true);
      setOutputExpanded(true);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onSuccess: () => {
      setActiveRunStartedAt(null);
      setOutputExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["runtime-runs", "codex-cli"] });
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onError: (err) => {
      setActiveRunStartedAt(null);
      setOutputExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
      setError(err instanceof Error ? err.message : "Unable to run Codex runtime test");
    },
  });

  const createCliRuntimeRun = useMutation({
    mutationFn: () =>
      api.createCodexRuntimeRun(token ?? "", {
        workspace_id: selectedWorkspaceId,
        prompt: runtimePrompt,
        mode: "read-only",
        timeout_seconds: 180,
        agent: cliAgent,
        runtime: "direct",
      }),
    onMutate: () => {
      setCliActiveRunStartedAt(new Date().toLocaleTimeString());
      setTestOpen(true);
      setCliOutputExpanded(true);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onSuccess: () => {
      setCliActiveRunStartedAt(null);
      setCliOutputExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["runtime-runs", "codex-cli"] });
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onError: (err) => {
      setCliActiveRunStartedAt(null);
      setCliOutputExpanded(false);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
      setError(err instanceof Error ? err.message : "Unable to run Direct CLI test");
    },
  });

  const copyCommand = async (value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedCommand(value);
    window.setTimeout(() => setCopiedCommand(""), 1800);
  };

  const codexBadge = runtimeBadge(codexRuntime);
  const dockerSandboxBadge = runtimeBadge(dockerSandboxRuntime);
  const sandboxReady = dockerSandboxRuntime?.status === "ready";
  const hostRunnerOffline = dockerSandboxRuntime?.status === "host_runner_unavailable";
  const canInstallCodex = Boolean(canUseBackend && codexRuntime?.status === "missing" && codexRuntime.install_supported);
  const canUpgradeCodex = Boolean(canUseBackend && codexRuntime?.installed && codexRuntime?.upgrade_supported);
  const maintenanceEnabled = runnerMode?.maintenance_enabled ?? codexRuntime?.install_enabled ?? false;
  const recentRunnerLogs = runnerLogs?.logs ?? [];
  const activeRuntimeWorkspaces = runtimeWorkspaces.filter((workspace) => workspace.is_active);
  const latestRuntimeRun = runtimeRuns[0];
  const runtimeRunInProgress = Boolean(activeRunStartedAt) || createRuntimeRun.isPending;
  const liveProgressLines = runtimeRunInProgress
    ? recentRunnerLogs
        .filter((l) => l.level !== "debug")
        .slice(-20)
        .map((l) => l.message)
    : [];
  const agentRows = directCliRuntime?.agent_status ?? [];

  // "3 of 4 ready" in the chain — the AGENTS, matching the table directly below
  // it. This previously counted runtime adapters (codex-cli, docker-sandbox,
  // direct-cli), so the chain said one number while the table under it listed a
  // different set of things under the same word.
  //
  // "Ready" here means USABLE — installed, so it can run once whatever is in the
  // way clears. The mockup's own sample reads "3 of 4" against one uninstalled
  // agent, one rate-limited and one needing a login, which is the useful
  // reading: a quota resets and a login takes a moment, but an agent that is not
  // installed cannot run at all. Counting only fully-green agents would say
  // "1 of 4" and imply three are broken.
  //
  // The per-row states below stay strict — that is where you see WHICH thing is
  // in the way. The chain answers "how much of my fleet is real".
  const agentReadiness = {
    ready: agentRows.filter((a) => a.installed).length,
    total: agentRows.length,
  };

  /** What an approved path is actually used for. An approved repository nobody
   *  runs is still granted access, so saying "unused" is the useful signal —
   *  it is a candidate for revoking. */
  const workspaceUsage = (path: string) => {
    const n = allWorkflows.filter((w) => w.workspace_path === path).length;
    if (n) return `used by ${n} workflow${n === 1 ? "" : "s"}`;
    return path.includes("/.specter/imports/") ? "imported · unused" : "unused";
  };

  const approvedWorkspacePaths = new Set(activeRuntimeWorkspaces.map((workspace) => workspace.path));
  const discoveredRepositories = discoverRepositories.data?.repositories ?? [];
  const completedRuntimeRuns = runtimeRuns.filter((run) => run.status === "completed").length;
  const preferredRuntime =
    dockerSandboxRuntime?.status === "ready"
      ? "Docker"
      : codexRuntime?.status === "ready"
        ? "Codex"
        : codexRuntime?.status === "host_runner_unavailable" || dockerSandboxRuntime?.status === "host_runner_unavailable"
          ? "Offline"
          : "Setup";
  const runtimeTile =
    preferredRuntime === "Docker" || preferredRuntime === "Codex"
      ? { label: "Runtime", value: preferredRuntime, className: "border-emerald-200 bg-emerald-50 text-emerald-900", labelClassName: "text-emerald-700" }
      : preferredRuntime === "Offline"
        ? { label: "Runtime", value: "Offline", className: "border-slate-200 bg-slate-100 text-slate-800", labelClassName: "text-slate-500" }
        : { label: "Runtime", value: "Setup", className: "border-amber-200 bg-amber-50 text-amber-900", labelClassName: "text-amber-700" };
  const modeTile = maintenanceEnabled
    ? { label: "Mode", value: "Maint.", className: "border-amber-200 bg-amber-50 text-amber-900", labelClassName: "text-amber-700" }
    : { label: "Mode", value: "Safe", className: "border-sky-200 bg-sky-50 text-sky-900", labelClassName: "text-sky-700" };
  const summaryTiles = [
    runtimeTile,
    modeTile,
    { label: "Repos", value: activeRuntimeWorkspaces.length, className: "border-slate-100 bg-white text-slate-950", labelClassName: "text-slate-500" },
    { label: "Runs", value: completedRuntimeRuns, className: "border-slate-100 bg-white text-slate-950", labelClassName: "text-slate-500" },
  ];

  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [recentRunnerLogs.length]);

  // Auto-scroll live output to bottom as new lines arrive
  useEffect(() => {
    if (liveOutputRef.current) {
      liveOutputRef.current.scrollTop = liveOutputRef.current.scrollHeight;
    }
  }, [liveProgressLines.length]);

  const cliRunInProgress = Boolean(cliActiveRunStartedAt) || createCliRuntimeRun.isPending;
  const cliLiveProgressLines = cliRunInProgress
    ? recentRunnerLogs.filter((l) => l.level !== "debug").slice(-20).map((l) => l.message)
    : [];
  const latestCliRun = createCliRuntimeRun.data ?? null;

  useEffect(() => {
    if (cliLiveOutputRef.current) {
      cliLiveOutputRef.current.scrollTop = cliLiveOutputRef.current.scrollHeight;
    }
  }, [cliLiveProgressLines.length]);

  return (
    <div className="space-y-5">
      {/* The page header, per the design: a title and one line saying what the
          page is for. The five tinted stat tiles that used to sit here restated
          exactly what the dependency chain below now shows — host runner,
          sandbox, direct CLI, repo count — in a second visual language. */}
      <div className="sp-frame">
        <div className="sp-hdr">
          <h1>Runtimes</h1>
          <p>Where agents run, and what they can reach</p>
        </div>

      {error && (
        <Alert variant="destructive" className="rounded-[8px]">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* The dependency chain, per the design. The host runner is the substrate
          everything else sits on, yet it used to render below and smaller than
          the cards that depend on it — so the ordering had to be inferred. Here
          it reads left to right: runner → sandbox → agents → approved repos. */}
      <DependencyChain
        hostRunnerOnline={!hostRunnerOffline}
        hostRunnerVersion={hostRunnerVersion?.version ?? null}
        sandboxReady={sandboxReady}
        sandboxLabel={dockerSandboxBadge.label}
        agentsReady={agentReadiness.ready}
        agentsTotal={agentReadiness.total}
        approvedPaths={activeRuntimeWorkspaces.length}
        />
      </div>

      {/* Underline tabs, per the design — not shadcn's pill group. The mockup
          specifies a bottom-border indicator on a flat bar; the pill variant
          carried its own radius, background and font-size, none of which
          matched. `.sp-tb` / `.sp-tb-on` are the shared classes. */}
      <Tabs defaultValue="infrastructure">
        <TabsList className="sp-tabs sp-tabs-lg h-auto justify-start rounded-none bg-transparent p-0">
          <TabsTrigger value="infrastructure" className="sp-tb rounded-none">
            Runtimes
          </TabsTrigger>
          <TabsTrigger value="access" className="sp-tb rounded-none">
            Access
          </TabsTrigger>
          <TabsTrigger value="logs" className="sp-tb rounded-none">
            <span className="flex items-center gap-2">
              Console
              {!hostRunnerOffline && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
              {runnerLogs?.total ? <span className="text-[10px] text-slate-400">{runnerLogs.total}</span> : null}
            </span>
          </TabsTrigger>
          <TabsTrigger value="models" className="sp-tb rounded-none">
            Models
          </TabsTrigger>
        </TabsList>

        <TabsContent value="infrastructure" className="mt-4 space-y-4">
        {/* Agent readiness. THREE states, not two: "not installed", "needs
            login" and "ready" are different problems with different fixes, and
            collapsing the first two into one amber "setup needed" is what the
            design set out to correct. Each row names the fix. */}
        <div className="sp-sec">
          <h2>Agents</h2>
          <div className="sp-sub">Each shows what is wrong and the exact command that fixes it.</div>
          <table className="sp-table w-full">
            <thead>
              <tr><th>Agent</th><th>Sandbox</th><th>Direct CLI</th><th>Version</th><th /></tr>
            </thead>
            <tbody>
              {agentRows.length === 0 && (
                <tr><td colSpan={5} className="text-slate-400">No agent status reported by the host runner.</td></tr>
              )}
              {agentRows.map((ag) => (
                <tr key={ag.key}>
                  <td className="sp-ag">{ag.display_name}</td>
                  {/* Sandbox: the adapter reports daemon health, not per-agent
                      state, so readiness is derived — the sandbox runs these
                      same host binaries, so "installed AND daemon up" is the
                      real condition. Direct CLI needs no daemon. */}
                  <td><AgentState installed={ag.installed} authenticated={ag.authenticated} runtimeUp={sandboxReady} rateLimited={ag.rate_limited} /></td>
                  <td><AgentState installed={ag.installed} authenticated={ag.authenticated} runtimeUp rateLimited={ag.rate_limited} /></td>
                  <td style={ag.version ? undefined : { color: "#94a3b8" }}>{ag.version ?? "—"}</td>
                  <td>
                    {!ag.installed && ag.docs_url && (
                      <a className="sp-fix" href={ag.docs_url} target="_blank" rel="noreferrer">Show install command →</a>
                    )}
                    {/* Show the command, not a description of it. The design
                        says "Show login command →" because the fix is a line
                        you paste, and auth_command carries it. */}
                    {/* Quota reset time when the provider gives one. */}
                    {ag.rate_limited && ag.rate_limit_resets_at && (
                      <span className="sp-fix">
                        quota resets {new Date(ag.rate_limit_resets_at).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })} →
                      </span>
                    )}
                    {ag.installed && !ag.authenticated && (
                      ag.auth_command ? (
                        <button
                          type="button"
                          className="sp-fix"
                          title={ag.auth_command}
                          onClick={() => {
                            void navigator.clipboard?.writeText(ag.auth_command ?? "");
                            toast({ title: "Login command copied", description: ag.auth_command ?? "" });
                          }}
                        >
                          Show login command →
                        </button>
                      ) : (
                        <span className="sp-fix" title={ag.auth_note}>{ag.auth_note || "Sign-in required"} →</span>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>


      {/* ── Row 1: Docker Sandbox + Direct CLI ── */}
      <div className="grid gap-4 xl:grid-cols-2">

        {/* ── Docker Sandbox ── */}
        <Card className="sp-frame">
          <CardContent className="p-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[8px] bg-emerald-100 text-emerald-800">
                  <Box className="h-6 w-6" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-black text-slate-950">Docker Sandbox</h3>
                    <Badge className="rounded-full bg-slate-900 text-white hover:bg-slate-900">Preferred</Badge>
                    <Badge className={`rounded-full ${dockerSandboxBadge.className} hover:bg-current/0`}>
                      {sandboxRuntimeLoading && canUseBackend ? "Checking…" : dockerSandboxBadge.label}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-sm font-semibold text-slate-500">{sandboxStatusLine(dockerSandboxRuntime)}</p>
                  {dockerSandboxRuntime?.executable_path && (
                    <p className="mt-0.5 break-all text-xs text-slate-400">{shortPath(dockerSandboxRuntime.executable_path)}</p>
                  )}
                </div>
              </div>
              <Button
                type="button" size="sm" variant="outline" className="rounded-[6px] bg-white shrink-0"
                disabled={!canUseBackend || sandboxRuntimeLoading}
                onClick={() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] })}
              >
                {sandboxRuntimeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            </div>

            {/* Daemon unavailable banner */}
            {dockerSandboxRuntime?.sandbox_health_status === "daemon_unavailable" && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-[8px] border border-amber-100 bg-amber-50 px-3 py-2.5">
                <p className="text-xs font-semibold text-amber-800">
                  {startSandboxDaemon.data?.message ?? "sbx daemon is not running."}
                </p>
                <Button size="sm" variant="outline" className="rounded-[6px] bg-white text-xs shrink-0"
                  disabled={!canUseBackend || hostRunnerOffline || startSandboxDaemon.isPending}
                  onClick={() => startSandboxDaemon.mutate()}
                >
                  {startSandboxDaemon.isPending && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
                  {startSandboxDaemon.isPending ? "Starting…" : "Start daemon"}
                </Button>
              </div>
            )}

            {/* Agent status table */}
            {(() => {
              const agentAuth: { key: string; authenticated: boolean }[] = (dockerSandboxRuntime as any)?.agent_auth ?? [];
              return (
                <div className="mt-4 rounded-[8px] border border-slate-100 bg-slate-50 overflow-hidden">
                  {Object.entries(SANDBOX_AGENTS).map(([key, ag], idx) => {
                    const auth = agentAuth.find(a => a.key === key);
                    const authenticated = auth?.authenticated ?? false;
                    const isSelected = sandboxAgent === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => { setSandboxAgent(key); try { localStorage.setItem("specter_sandbox_agent", key); } catch {} }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-white/60 ${idx !== 0 ? "border-t border-slate-100" : ""} ${isSelected ? "bg-white" : ""}`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className={`text-xs font-black ${authenticated ? "text-emerald-500" : "text-amber-400"}`}>
                            {authenticated ? "✓" : "○"}
                          </span>
                          <span className={`text-sm font-bold ${isSelected ? "text-slate-950" : "text-slate-600"}`}>{ag.label}</span>
                          {isSelected && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-black text-white">selected</span>}
                        </div>
                        <span className={`text-[10px] font-semibold ${authenticated ? "text-emerald-600" : "text-amber-500"}`}>
                          {authenticated ? "Ready" : "Setup needed"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {/* Network policy + template row */}
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap gap-1.5">
                <Badge className="rounded-full bg-emerald-50 text-emerald-800 hover:bg-emerald-50">microVM isolation</Badge>
                <Badge className="rounded-full bg-slate-100 text-slate-600 hover:bg-slate-100 font-mono text-[10px]">
                  {SANDBOX_AGENTS[sandboxAgent]?.template ?? dockerSandboxRuntime?.base_image ?? "docker/sandbox-templates:codex"}
                </Badge>
              </div>
              <Select
                value={["balanced", "deny-all", "allow-all"].includes(sandboxPolicy?.current_policy ?? "") ? sandboxPolicy!.current_policy : undefined}
                onValueChange={(value) => setSandboxPolicy.mutate(value as "allow-all" | "balanced" | "deny-all")}
                disabled={!canUseBackend || !sandboxReady || setSandboxPolicy.isPending}
              >
                <SelectTrigger className="h-7 w-36 rounded-[6px] bg-white text-xs">
                  <SelectValue placeholder="Network policy" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="balanced">Balanced</SelectItem>
                  <SelectItem value="deny-all">Deny all</SelectItem>
                  <SelectItem value="allow-all">Allow all</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="rounded-[8px] bg-white">Setup</Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl rounded-[10px]">
                  <DialogHeader>
                    <DialogTitle>Docker Sandbox Setup</DialogTitle>
                    <DialogDescription>
                      Install sbx once, then complete a one-time login for each agent you want to use.
                    </DialogDescription>
                  </DialogHeader>
                  <div className="space-y-5">
                    {/* Installation */}
                    <div>
                      <p className="mb-2 text-xs font-black uppercase text-slate-500">1 · Install sbx</p>
                      <div className="space-y-2">
                        <CommandCopy command={dockerSandboxRuntime?.install_guidance?.macos ?? dockerSandboxMacInstallCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                        <CommandCopy command={dockerSandboxRuntime?.install_guidance?.windows ?? dockerSandboxWindowsInstallCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                      </div>
                    </div>
                    {/* Per-agent auth */}
                    <div>
                      <p className="mb-2 text-xs font-black uppercase text-slate-500">2 · Authenticate agents</p>
                      <div className="space-y-3">
                        {(() => {
                          const agentAuth: { key: string; display_name: string; authenticated: boolean }[] = (dockerSandboxRuntime as any)?.agent_auth ?? [];
                          const agentInstructions: Record<string, { note: string; command: string }> = {
                            codex: {
                              note: "OAuth via OpenAI — runs in your browser.",
                              command: "sbx secret set -g openai --oauth",
                            },
                            claude: {
                              note: "One-time interactive login inside a sandbox. Type /login when prompted.",
                              command: "sbx run --name claude-login claude ~/Desktop",
                            },
                            cursor: {
                              note: "One-time interactive login inside a sandbox. Sign in via browser when prompted.",
                              command: "sbx run --name cursor-login cursor ~/Desktop",
                            },
                          };
                          return Object.entries(SANDBOX_AGENTS).map(([key, ag]) => {
                            const auth = agentAuth.find(a => a.key === key);
                            const instructions = agentInstructions[key];
                            const authenticated = auth?.authenticated ?? false;
                            return (
                              <div key={key} className="rounded-[8px] border border-slate-100 bg-slate-50 p-3 space-y-2">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm ${authenticated ? "text-emerald-500" : "text-amber-400"}`}>
                                    {authenticated ? "✓" : "○"}
                                  </span>
                                  <p className="text-sm font-black text-slate-900">{ag.label}</p>
                                  {authenticated && (
                                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-700">Ready</span>
                                  )}
                                </div>
                                {!authenticated && instructions && (
                                  <>
                                    <p className="text-xs text-slate-500 pl-5">{instructions.note}</p>
                                    <CommandCopy command={instructions.command} copiedCommand={copiedCommand} onCopy={copyCommand} />
                                  </>
                                )}
                              </div>
                            );
                          });
                        })()}
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardContent>
        </Card>

      </div>

      {/* ── Host Runner ── */}
      <div className="grid gap-4 xl:grid-cols-3">

        {/* ── Host Runner ── */}
        <Card className="sp-frame">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-slate-100 text-slate-900">
                  <TerminalSquare className="h-5 w-5" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-base font-black text-slate-950">Host Runner</h3>
                    <Badge className={`rounded-full ${hostRunnerOffline ? "bg-slate-100 text-slate-600" : "bg-emerald-100 text-emerald-800"} hover:bg-current/0`}>
                      {hostRunnerOffline ? "Offline" : "Online"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-xs font-semibold text-slate-500">
                    {hostRunnerOffline ? "Not reachable on localhost:8765" : `localhost:8765 · ${hostRunnerVersion?.version ? `v${hostRunnerVersion.version}` : ""}`}
                  </p>
                </div>
              </div>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" size="sm" variant="outline" className="rounded-[6px] bg-white text-xs">Start</Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg rounded-[10px]">
                  <DialogHeader>
                    <DialogTitle>Start Host Runner</DialogTitle>
                    <DialogDescription>Run once in your terminal from the repo directory.</DialogDescription>
                  </DialogHeader>
                  <CommandCopy command={runnerSafeCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  <p className="text-xs text-slate-400">Or install as a launchd service below so it starts automatically.</p>
                </DialogContent>
              </Dialog>
            </div>
            <div className="mt-3 rounded-[8px] border border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <div className={`h-2 w-2 rounded-full ${launchdSvc?.running ? "bg-emerald-500" : "bg-slate-300"}`} />
                  <div>
                    <p className="text-xs font-black text-slate-950">Auto-start</p>
                    <p className="text-[10px] font-semibold text-slate-500">
                      {launchdSvc?.installed ? (launchdSvc.running ? "Running via launchd" : "Installed · not running") : "Not installed"}
                    </p>
                  </div>
                </div>
                <div className="flex gap-1.5">
                  {!launchdSvc?.installed ? (
                    <Dialog>
                      <DialogTrigger asChild>
                        <Button type="button" size="sm" className="rounded-[6px] bg-slate-900 text-xs hover:bg-slate-800">Install</Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg rounded-[10px]">
                        <DialogHeader>
                          <DialogTitle>Install auto-start service</DialogTitle>
                          <DialogDescription>Starts automatically on login and restarts on crash.</DialogDescription>
                        </DialogHeader>
                        <CommandCopy command="python3 scripts/specter_host_runner.py --install-service" copiedCommand={copiedCommand} onCopy={copyCommand} />
                      </DialogContent>
                    </Dialog>
                  ) : (
                    <>
                      <Button type="button" size="sm" variant="outline" className="rounded-[6px] bg-white text-xs"
                        disabled={!canUseBackend || restartLaunchd.isPending} onClick={() => restartLaunchd.mutate()}>
                        {restartLaunchd.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="rounded-[6px] bg-white text-xs text-red-600"
                        disabled={!canUseBackend || uninstallLaunchd.isPending} onClick={() => uninstallLaunchd.mutate()}>
                        Remove
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>


      </div>

      {/* ── Unified Test Card ── */}
      {(() => {
        const isSandbox = testRuntime === "sandbox";
        const isRunning = isSandbox ? runtimeRunInProgress : cliRunInProgress;
        const latestRun = isSandbox ? latestRuntimeRun : latestCliRun;
        const isExpanded = isSandbox ? outputExpanded : cliOutputExpanded;
        const setExpanded = isSandbox ? setOutputExpanded : setCliOutputExpanded;
        const liveLines = isSandbox ? liveProgressLines : cliLiveProgressLines;
        const liveRef = isSandbox ? liveOutputRef : cliLiveOutputRef;
        const startedAt = isSandbox ? activeRunStartedAt : cliActiveRunStartedAt;
        const rawMode = isSandbox ? showRaw : cliShowRaw;
        const setRawMode = isSandbox ? setShowRaw : setCliShowRaw;
        const agentLabel = isSandbox
          ? (SANDBOX_AGENTS[sandboxAgent]?.label ?? sandboxAgent)
          : ((directCliRuntime?.agent_status ?? []).find(a => a.key === cliAgent)?.display_name ?? cliAgent);
        const canRun = isSandbox
          ? Boolean(selectedWorkspaceId && runtimePrompt.trim() && canUseBackend && sandboxReady && !createRuntimeRun.isPending)
          : Boolean(selectedWorkspaceId && runtimePrompt.trim() && canUseBackend && directCliRuntime?.available && !createCliRuntimeRun.isPending);

        return (
          <Card className="sp-frame">
            <CardContent className="p-5">
              {/* Header */}
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h3 className="text-xl font-black text-slate-950">Test run</h3>
                  <p className="text-sm font-semibold text-slate-500">
                    {isRunning ? "Running" : latestRun?.status ?? "Idle"}
                    {" · "}{agentLabel}
                  </p>
                </div>
                <Button type="button" variant="outline" className="w-fit rounded-[8px] bg-white" onClick={() => setTestOpen((o) => !o)}>
                  {testOpen ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                  {testOpen ? "Hide" : "Show"}
                </Button>
              </div>

              {testOpen && (
                <>
                  <div className="mt-4 grid gap-3">
                    {/* Runtime + agent selector row */}
                    <div className="flex gap-2">
                      {/* Runtime toggle */}
                      <div className="flex rounded-[8px] border border-slate-200 bg-slate-50 p-0.5 gap-0.5">
                        <button
                          type="button"
                          onClick={() => setTestRuntime("sandbox")}
                          className={`rounded-[6px] px-3 py-1.5 text-xs font-black transition-colors ${isSandbox ? "bg-white shadow-sm text-slate-950" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          Sandbox
                        </button>
                        <button
                          type="button"
                          onClick={() => setTestRuntime("direct")}
                          className={`rounded-[6px] px-3 py-1.5 text-xs font-black transition-colors ${!isSandbox ? "bg-white shadow-sm text-slate-950" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          Direct CLI
                        </button>
                      </div>
                      {/* Agent selector */}
                      {isSandbox ? (
                        <Select value={sandboxAgent} onValueChange={setSandboxAgent}>
                          <SelectTrigger className="rounded-[8px] h-9 text-xs flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(SANDBOX_AGENTS).map(([k, v]) => (
                              <SelectItem key={k} value={k}>{v.label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Select value={cliAgent} onValueChange={(v) => { setCliAgent(v); try { localStorage.setItem("specter_cli_agent", v); } catch {} }}>
                          <SelectTrigger className="rounded-[8px] h-9 text-xs flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {(directCliRuntime?.agent_status ?? []).map((ag) => (
                              <SelectItem key={ag.key} value={ag.key} disabled={!ag.authenticated}>
                                {ag.display_name}{!ag.authenticated ? " (not ready)" : ""}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </div>

                    {/* Workspace */}
                    <div className="space-y-2">
                      <Label>Workspace</Label>
                      <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
                        <SelectTrigger className="rounded-[8px]">
                          <SelectValue placeholder="Select repository" />
                        </SelectTrigger>
                        <SelectContent>
                          {activeRuntimeWorkspaces.map((workspace) => (
                            <SelectItem key={workspace.id} value={workspace.id}>{workspace.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Prompt */}
                    <div className="space-y-2">
                      <Label>Prompt</Label>
                      <Textarea className="min-h-24 rounded-[8px]" value={runtimePrompt} onChange={(e) => setRuntimePrompt(e.target.value)} />
                    </div>

                    {/* Run button */}
                    <Button
                      type="button"
                      disabled={!canRun}
                      onClick={() => isSandbox ? createRuntimeRun.mutate() : createCliRuntimeRun.mutate()}
                      className={`rounded-[8px] ${isSandbox ? "bg-emerald-700 hover:bg-emerald-800" : "bg-amber-700 hover:bg-amber-800"}`}
                    >
                      {(isSandbox ? createRuntimeRun.isPending : createCliRuntimeRun.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {(isSandbox ? createRuntimeRun.isPending : createCliRuntimeRun.isPending) ? "Running…" : `Run with ${agentLabel}`}
                    </Button>
                  </div>

                  {/* Output panel */}
                  <div className={isExpanded ? "fixed inset-0 z-50 flex flex-col bg-slate-950 text-white" : "mt-4 rounded-[8px] border border-slate-100 bg-slate-950 p-4 text-white"}>
                    <div className={`flex flex-wrap items-center justify-between gap-2 ${isExpanded ? "px-5 pt-5 pb-3 border-b border-white/10" : "mb-2"}`}>
                      <div className="flex items-center gap-2">
                        <p className="text-xs font-black uppercase text-slate-300">
                          {isRunning ? agentLabel : "Latest run"}
                        </p>
                        {isRunning ? (
                          <Badge className="rounded-full bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/20">
                            <Loader2 className="mr-1 h-2.5 w-2.5 animate-spin" />Running
                          </Badge>
                        ) : latestRun ? (
                          <Badge className="rounded-full bg-white/10 text-white hover:bg-white/10">{latestRun.status}</Badge>
                        ) : null}
                      </div>
                      <button
                        onClick={() => setExpanded((e) => !e)}
                        className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition-colors"
                        title={isExpanded ? "Minimize" : "Expand"}
                      >
                        {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
                      </button>
                    </div>
                    <div className={isExpanded ? "flex-1 overflow-auto px-5 py-4" : ""}>
                      {isRunning ? (
                        <div className={isExpanded ? "h-full" : "rounded-[8px] bg-emerald-500/10 p-3"}>
                          {isExpanded && <p className="text-xs font-semibold text-emerald-400 mb-3">Started {startedAt ?? "now"}</p>}
                          <pre ref={liveRef} className={isExpanded ? "h-full overflow-auto whitespace-pre-wrap text-sm leading-6 text-emerald-100/90 font-mono" : "max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-emerald-100/80 font-mono"}>
                            {liveLines.join("\n") || "Starting…"}
                          </pre>
                        </div>
                      ) : latestRun ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-semibold text-slate-400">{latestRun.workspace_path}</p>
                            {latestRun.summary && (
                              <button onClick={() => setRawMode((r) => !r)} className="shrink-0 text-[10px] font-semibold text-slate-500 hover:text-slate-300 transition-colors">
                                {rawMode ? "Rendered" : "Raw"}
                              </button>
                            )}
                          </div>
                          {rawMode || !latestRun.summary ? (
                            <pre className={`overflow-auto whitespace-pre-wrap rounded-[8px] bg-white/5 p-3 text-xs leading-5 text-slate-300 font-mono ${isExpanded ? "h-full" : "max-h-60"}`}>
                              {latestRun.summary || latestRun.stderr || latestRun.error || "No output captured."}
                            </pre>
                          ) : (
                            <div
                              className={`overflow-auto rounded-[8px] bg-white/5 p-4 prose prose-invert prose-sm max-w-none
                                prose-headings:text-slate-100 prose-headings:font-black
                                prose-p:text-slate-300 prose-p:leading-6
                                prose-code:text-emerald-300 prose-code:bg-white/10 prose-code:rounded prose-code:px-1 prose-code:text-xs
                                prose-pre:bg-white/10 prose-pre:text-slate-200 prose-pre:text-xs
                                prose-strong:text-slate-100 prose-li:text-slate-300
                                prose-a:text-sky-400 hover:prose-a:text-sky-300
                                ${isExpanded ? "h-full" : "max-h-96"}`}
                              dangerouslySetInnerHTML={{ __html: md.render(latestRun.summary) }}
                            />
                          )}
                        </div>
                      ) : (
                        <p className="text-sm font-semibold text-slate-400">No runs yet.</p>
                      )}
                    </div>
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}
        </TabsContent>

        {/* Approving a repository grants an agent filesystem access to it. The
            previous copy said "Add" and "Approved", which reads as list
            management rather than granting access. */}

        <TabsContent value="logs" className="mt-4">
          <div className="rounded-[8px] bg-slate-950 text-white">
            {/* toolbar */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-2.5">
              <div className="flex items-center gap-3">
                {!hostRunnerOffline && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
                <span className="font-mono text-[11px] text-slate-400">
                  {hostRunnerOffline ? "offline" : `${runnerLogs?.total ?? 0} events · #${logSince}`}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  {(["all", "debug", "info", "warn", "error"] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLogLevelFilter(l)}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase transition-colors ${logLevelFilter === l ? "bg-white/15 text-white" : "text-slate-500 hover:text-slate-300"}`}
                    >
                      {l}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => queryClient.invalidateQueries({ queryKey: ["host-runner", "logs", logLevelFilter] })}
                  className="rounded p-1 text-slate-500 hover:text-slate-300"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
              </div>
            </div>
            {/* log rows */}
            <div className="overflow-auto font-mono text-[11px] leading-5" style={{ height: "calc(100vh - 18rem)" }}>
              {recentRunnerLogs.length ? (
                <>
                  {recentRunnerLogs.map((entry) => {
                    const levelColor =
                      entry.level === "error" ? "text-red-400" :
                      entry.level === "warn"  ? "text-amber-400" :
                      entry.level === "info"  ? "text-emerald-400" :
                      "text-slate-500";
                    const msgColor =
                      entry.level === "error" ? "text-red-200" :
                      entry.level === "warn"  ? "text-amber-200" :
                      entry.level === "info"  ? "text-slate-100" :
                      "text-slate-400";
                    const metadata = entry.metadata ? Object.entries(entry.metadata) : [];
                    return (
                      <div
                        key={entry.seq ?? `${entry.timestamp}-${entry.message}`}
                        className="flex items-baseline gap-4 border-b border-white/5 px-4 py-2 hover:bg-white/5"
                      >
                        <span className="w-8 shrink-0 text-right text-slate-600">#{entry.seq}</span>
                        <span className="w-24 shrink-0 whitespace-nowrap text-slate-600">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                        <span className={`w-10 shrink-0 uppercase ${levelColor}`}>{entry.level}</span>
                        <span className={`min-w-0 break-all ${msgColor}`}>
                          {entry.message}
                          {metadata.length > 0 && (
                            <span className="ml-2 text-slate-600">
                              {metadata.map(([k, v]) => `${k}=${String(v).slice(0, 80)}`).join(" ")}
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                  <div ref={logsEndRef} />
                </>
              ) : (
                <div className="flex h-32 items-center justify-center text-slate-500">
                  {hostRunnerOffline ? "Start the host runner to see logs." : `No entries${logLevelFilter !== "all" ? ` · level=${logLevelFilter}` : ""}`}
                </div>
              )}
            </div>
          </div>
        </TabsContent>

        {/* The page called "Models" now contains model settings. Selection used
            to live only in a header dropdown, so the discoverable path led to a
            page about Docker. This writes the same preference the header reads,
            so the two stay in step. */}
        <TabsContent value="models" className="mt-4">
          <div className="sp-sec">
            <h2>Default model</h2>
            <div className="sp-sub">
              Used to seed new agent nodes. Each workflow node can still override it.
            </div>

            {modelsQuery.isLoading && <p className="text-sm text-slate-500">Loading models…</p>}

            {!modelsQuery.isLoading && !Object.keys(agentModelSets).length && (
              <p className="text-sm text-slate-500">
                No models reported. The host runner asks each installed CLI what it
                supports, so an agent has to be installed and signed in before its
                models appear here.
              </p>
            )}

            {Object.entries(agentModelSets).map(([agentKey, set]) => (
              <div key={agentKey} style={{ marginBottom: 14 }}>
                <div className="sp-ag" style={{ marginBottom: 5 }}>
                  {agentKey}
                  <span style={{ color: "#94a3b8", fontWeight: 400, fontSize: 11, marginLeft: 7 }}>
                    {set.models?.length ?? 0} model{set.models?.length === 1 ? "" : "s"}
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(set.models ?? []).map((model) => {
                    const active = preference.agent === agentKey && preference.model === model.slug;
                    return (
                      <button
                        key={model.slug}
                        type="button"
                        className={active ? "sp-chip sp-chip-on" : "sp-chip"}
                        title={model.slug}
                        onClick={() => setPreference({ agent: agentKey, model: model.slug })}
                      >
                        {model.display_name}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {preference.model && (
              <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 4 }}>
                New nodes default to <b style={{ color: "#0f172a" }}>{preference.model}</b> on{" "}
                {preference.agent}.
              </p>
            )}
          </div>
        </TabsContent>
        {/* Access is its own tab panel. It used to sit outside <Tabs>,
            so it rendered under Console and Models as well. */}
        <TabsContent value="access" className="mt-4">
        <div className="sp-frame">
          <div className="sp-hdr">
            <h1>Access</h1>
            <p>Repositories agents are allowed to read and write</p>
          </div>
          <div className="sp-sec">
            <div className="sp-warnbox">
              <div className="t">⚠ Approving a repository grants agent access to it</div>
              <div className="b">
                Agents can read every file in an approved path, and in <b>Direct CLI</b> mode
                they run on this host with no isolation — including any <code>.env</code>,
                credentials or client work inside. Approve only repositories you would hand
                to a contractor.
              </div>
            </div>

            <h2>Approved · {activeRuntimeWorkspaces.length} path{activeRuntimeWorkspaces.length === 1 ? "" : "s"}</h2>
            <div className="sp-sub">Shown by default. This is the answer to “what can agents touch?”</div>

            {activeRuntimeWorkspaces.length === 0 && (
              <p className="text-sm text-slate-500">
                No repositories approved yet — nothing can run until one is.
              </p>
            )}

            {activeRuntimeWorkspaces.map((workspace) => (
              <div className="sp-pathrow" key={workspace.id}>
                <code title={workspace.path}>{workspace.path}</code>
                <span style={{ color: "#94a3b8", fontSize: 11 }}>{workspaceUsage(workspace.path)}</span>
                <button
                  type="button"
                  className="sp-rm"
                  disabled={!canUseBackend || deleteWorkspace.isPending}
                  onClick={() => deleteWorkspace.mutate(workspace.id)}
                >
                  Revoke
                </button>
              </div>
            ))}

            <h2 style={{ marginTop: 17 }}>Scan for repositories</h2>
            <div className="sp-sub">
              {discoveredRepositories.length
                ? `Found ${discoveredRepositories.length} under this root. Review before approving — there is no bulk approve.`
                : "Review before approving — there is no bulk approve."}
            </div>
            <div className="sp-pathrow" style={discoveredRepositories.length ? undefined : { borderBottom: "none" }}>
              <input
                className="flex-1 border-0 bg-transparent font-mono text-[11px] outline-none"
                value={discoveryRoot}
                onChange={(e) => setDiscoveryRoot(e.target.value)}
                placeholder="Absolute path to scan, e.g. ~/code"
              />
              <button
                type="button"
                className="sp-rm"
                style={{ color: "#334155", borderColor: "#dde3ea" }}
                disabled={!canUseBackend || !discoveryRoot.trim() || discoverRepositories.isPending || hostRunnerOffline}
                onClick={() => discoverRepositories.mutate()}
              >
                {discoverRepositories.isPending ? "Scanning…" : "Scan"}
              </button>
            </div>

            {/* Scan results. Each path is approved on its own — the confirm names
                the single repository, so nobody grants access to fifty at once and
                discovers afterwards which ones actually took. */}
            {discoveredRepositories.map((repo) => {
              const already = approvedWorkspacePaths.has(repo.path);
              return (
                <div className="sp-pathrow" key={repo.path}>
                  <code title={repo.path}>{repo.path}</code>
                  {already && <span style={{ color: "#16a34a", fontSize: 11 }}>already approved</span>}
                  {!already && (
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <button
                          type="button"
                          className="sp-rm"
                          style={{ color: "#334155", borderColor: "#dde3ea" }}
                          disabled={!canUseBackend || approveSelectedRepositories.isPending}
                        >
                          Approve…
                        </button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="rounded-[10px]">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Grant agent access to this repository?</AlertDialogTitle>
                          <AlertDialogDescription asChild>
                            <div>
                              <p className="font-mono text-xs text-slate-700">{repo.path}</p>
                              <p className="mt-2">
                                Agents will be able to read every file inside it, and in Direct CLI
                                mode they run on this host with no isolation.
                              </p>
                            </div>
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className="rounded-[6px]">Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            className="rounded-[6px] bg-slate-900 hover:bg-slate-800"
                            onClick={() => {
                              setSelectedDiscoveredPaths([repo.path]);
                              approveSelectedRepositories.mutate();
                            }}
                          >
                            Grant access
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        </TabsContent>
      </Tabs>

      {/* Access is its own frame below Runtimes, not a tab — the design shows
          both at once on purpose. "What can agents reach?" is a question you
          ask while looking at whether they are ready, and hiding it behind a
          tab means the security control is only seen by someone who goes
          looking for it. */}
    </div>
  );
}

function CommandCopy({
  command,
  copiedCommand,
  onCopy,
}: {
  command: string;
  copiedCommand: string;
  onCopy: (command: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[8px] bg-slate-950 p-4 text-white sm:flex-row sm:items-center sm:justify-between">
      <code className="break-all text-sm font-bold">{command}</code>
      <Button type="button" onClick={() => onCopy(command)} variant="outline" className="rounded-[8px] border-white/20 bg-white text-slate-950 hover:bg-slate-100">
        {copiedCommand === command ? <CheckCircle2 className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
        {copiedCommand === command ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
