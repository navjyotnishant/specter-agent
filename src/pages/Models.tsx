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

export default function Models() {
  const token = getStoredToken();
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [copiedCommand, setCopiedCommand] = useState("");
  const [logLevelFilter, setLogLevelFilter] = useState<string>("all");
  const [logSince, setLogSince] = useState(0);
  const [sandboxAgent, setSandboxAgent] = useState<string>(() => {
    try { return localStorage.getItem("specter_sandbox_agent") ?? "codex"; } catch { return "codex"; }
  });
  const [discoveryRoot, setDiscoveryRoot] = useState("/Users/navjyotnishant/Desktop/github");
  const [selectedDiscoveredPaths, setSelectedDiscoveredPaths] = useState<string[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState("");
  const [runtimePrompt, setRuntimePrompt] = useState(defaultRuntimePrompt);
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<string | null>(null);
  const [directoryScanOpen, setDirectoryScanOpen] = useState(false);
  const [approvedOpen, setApprovedOpen] = useState(false);
  const [testOpen, setTestOpen] = useState(false);
  const [testRuntime, setTestRuntime] = useState<"sandbox" | "direct">("sandbox");
  const [outputExpanded, setOutputExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const liveOutputRef = useRef<HTMLPreElement>(null);
  const md = useMemo(() => new MarkdownIt({ linkify: true, breaks: true }), []);

  // Direct CLI state
  const [cliAgent, setCliAgent] = useState<string>(() => {
    try { return localStorage.getItem("specter_cli_agent") ?? "codex"; } catch { return "codex"; }
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
  const deleteWorkspace = useMutation({
    mutationFn: (id: string) => api.deleteRuntimeWorkspace(token ?? "", id),
    onSuccess: () => {
      setSelectedWorkspaceId("");
      queryClient.invalidateQueries({ queryKey: ["runtime-workspaces"] });
    },
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
      return Promise.all(selected.map((repo) => api.createRuntimeWorkspace(token ?? "", { name: repo.name, path: repo.path })));
    },
    onSuccess: (workspaces) => {
      if (workspaces[0]) setSelectedWorkspaceId(workspaces[0].id);
      setSelectedDiscoveredPaths([]);
      queryClient.invalidateQueries({ queryKey: ["runtime-workspaces"] });
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
  const approvedWorkspacePaths = new Set(activeRuntimeWorkspaces.map((workspace) => workspace.path));
  const discoveredRepositories = discoverRepositories.data?.repositories ?? [];
  const selectableDiscoveredPaths = discoveredRepositories.filter((repo) => !approvedWorkspacePaths.has(repo.path)).map((repo) => repo.path);
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
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <Badge className="mb-2 rounded-full bg-slate-900 text-white hover:bg-slate-900">Local execution</Badge>
          <h2 className="text-3xl font-black text-slate-950">Models</h2>
        </div>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          {/* Host runner status */}
          <div className={`rounded-2xl border px-4 py-3 text-center shadow-sm ${hostRunnerOffline ? "border-slate-200 bg-slate-100 text-slate-800" : "border-emerald-200 bg-emerald-50 text-emerald-900"}`}>
            <p className="text-xl font-black">{hostRunnerOffline ? "Offline" : "Online"}</p>
            <p className={`text-xs font-bold uppercase ${hostRunnerOffline ? "text-slate-500" : "text-emerald-700"}`}>Host Runner</p>
          </div>
          {/* Docker Sandbox status */}
          <div className={`rounded-2xl border px-4 py-3 text-center shadow-sm ${sandboxReady ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
            <p className="text-xl font-black">{sandboxReady ? "Ready" : "Setup"}</p>
            <p className={`text-xs font-bold uppercase ${sandboxReady ? "text-emerald-700" : "text-amber-700"}`}>Sandbox</p>
          </div>
          {/* Direct CLI status */}
          <div className={`rounded-2xl border px-4 py-3 text-center shadow-sm ${directCliRuntime?.available ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
            <p className="text-xl font-black">{directCliRuntime?.available ? "Ready" : "Setup"}</p>
            <p className={`text-xs font-bold uppercase ${directCliRuntime?.available ? "text-emerald-700" : "text-amber-700"}`}>Direct CLI</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 text-center shadow-sm text-slate-950">
            <p className="text-xl font-black">{activeRuntimeWorkspaces.length}</p>
            <p className="text-xs font-bold uppercase text-slate-500">Repos</p>
          </div>
          <div className="rounded-2xl border border-slate-100 bg-white px-4 py-3 text-center shadow-sm text-slate-950">
            <p className="text-xl font-black">{completedRuntimeRuns}</p>
            <p className="text-xs font-bold uppercase text-slate-500">Runs</p>
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Tabs defaultValue="infrastructure">
        <TabsList className="rounded-2xl bg-slate-100 p-1">
          <TabsTrigger value="infrastructure" className="rounded-xl px-5 font-semibold data-[state=active]:bg-white data-[state=active]:shadow-sm">
            Infrastructure
          </TabsTrigger>
          <TabsTrigger value="logs" className="rounded-xl px-5 font-semibold data-[state=active]:bg-white data-[state=active]:shadow-sm">
            <span className="flex items-center gap-2">
              Logs
              {!hostRunnerOffline && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />}
              {runnerLogs?.total ? <span className="text-[10px] text-slate-400">{runnerLogs.total}</span> : null}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="infrastructure" className="mt-4 space-y-4">

      {/* ── Row 1: Docker Sandbox + Direct CLI ── */}
      <div className="grid gap-4 xl:grid-cols-2">

        {/* ── Docker Sandbox ── */}
        <Card className="rounded-[1.5rem] border-emerald-100 bg-white/90 shadow-sm">
          <CardContent className="p-5">
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
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
                type="button" size="sm" variant="outline" className="rounded-xl bg-white shrink-0"
                disabled={!canUseBackend || sandboxRuntimeLoading}
                onClick={() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] })}
              >
                {sandboxRuntimeLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            </div>

            {/* Daemon unavailable banner */}
            {dockerSandboxRuntime?.sandbox_health_status === "daemon_unavailable" && (
              <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-amber-100 bg-amber-50 px-3 py-2.5">
                <p className="text-xs font-semibold text-amber-800">
                  {startSandboxDaemon.data?.message ?? "sbx daemon is not running."}
                </p>
                <Button size="sm" variant="outline" className="rounded-xl bg-white text-xs shrink-0"
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
                <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 overflow-hidden">
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
                <SelectTrigger className="h-7 w-36 rounded-xl bg-white text-xs">
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
                  <Button type="button" variant="outline" className="rounded-2xl bg-white">Setup</Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl rounded-3xl">
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
                              <div key={key} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 space-y-2">
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

        {/* ── Direct CLI ── */}
        <Card className="rounded-[1.5rem] border-amber-100 bg-white/90 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-amber-100 text-amber-800">
                  <TerminalSquare className="h-6 w-6" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-black text-slate-950">Direct CLI</h3>
                    <Badge className="rounded-full bg-amber-100 text-amber-800 hover:bg-amber-100">No isolation</Badge>
                    <Badge className={`rounded-full ${directCliRuntime?.available ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-800"} hover:bg-current/0`}>
                      {directCliLoading && canUseBackend ? "Checking…" : directCliRuntime?.available ? "Ready" : "Setup needed"}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-sm font-semibold text-slate-500">Runs agents directly on your host · no microVM overhead · fast path</p>
                </div>
              </div>
              <Button
                type="button" size="sm" variant="outline" className="rounded-xl bg-white shrink-0"
                disabled={!canUseBackend || directCliLoading}
                onClick={() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "direct-cli"] })}
              >
                {directCliLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              </Button>
            </div>

            {/* Agent status table */}
            <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 overflow-hidden">
              {(directCliRuntime?.agent_status ?? []).length === 0 && (
                <p className="px-3 py-3 text-sm font-semibold text-slate-500">Start the host runner to see agent status.</p>
              )}
              {(directCliRuntime?.agent_status ?? []).map((ag, idx) => {
                const isSelected = cliAgent === ag.key;
                return (
                  <button
                    key={ag.key}
                    type="button"
                    onClick={() => { setCliAgent(ag.key); try { localStorage.setItem("specter_cli_agent", ag.key); } catch {} }}
                    className={`w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-white/60 ${idx !== 0 ? "border-t border-slate-100" : ""} ${isSelected ? "bg-white" : ""}`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`text-xs font-black ${ag.authenticated ? "text-emerald-500" : ag.installed ? "text-amber-400" : "text-red-400"}`}>
                        {ag.authenticated ? "✓" : ag.installed ? "○" : "✕"}
                      </span>
                      <span className={`text-sm font-bold ${isSelected ? "text-slate-950" : "text-slate-600"}`}>{ag.display_name}</span>
                      {isSelected && <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[10px] font-black text-white">selected</span>}
                      {ag.version && <span className="text-[10px] text-slate-400 font-mono">{ag.version.split(" ")[0]}</span>}
                    </div>
                    <span className={`text-[10px] font-semibold ${ag.authenticated ? "text-emerald-600" : ag.installed ? "text-amber-500" : "text-red-500"}`}>
                      {ag.authenticated ? "Ready" : ag.installed ? "Login needed" : "Not installed"}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="rounded-2xl bg-white">Setup</Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl rounded-3xl">
                  <DialogHeader>
                    <DialogTitle>Direct CLI Setup</DialogTitle>
                    <DialogDescription>Install each agent CLI and authenticate once. Agents run directly on your host machine.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    {(directCliRuntime?.agent_status ?? []).map((ag) => {
                      const authInstructions: Record<string, { install: string; login: string }> = {
                        codex: { install: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", login: "codex  # sign in when prompted" },
                        claude: { install: "npm install -g @anthropic-ai/claude-code", login: "claude /login" },
                        cursor: { install: "# Install Cursor from cursor.com, then enable cursor-agent in PATH", login: "# Sign in to Cursor via the app" },
                      };
                      const instr = authInstructions[ag.key];
                      return (
                        <div key={ag.key} className="rounded-2xl border border-slate-100 bg-slate-50 p-3 space-y-2">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm ${ag.authenticated ? "text-emerald-500" : ag.installed ? "text-amber-400" : "text-red-400"}`}>
                              {ag.authenticated ? "✓" : ag.installed ? "○" : "✕"}
                            </span>
                            <p className="text-sm font-black text-slate-900">{ag.display_name}</p>
                            {ag.authenticated && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-black text-emerald-700">Ready</span>}
                            {ag.version && <span className="ml-auto text-[10px] text-slate-400 font-mono">{ag.version}</span>}
                          </div>
                          {!ag.installed && instr && (
                            <>
                              <p className="text-xs text-slate-500 pl-5">Install:</p>
                              <CommandCopy command={instr.install} copiedCommand={copiedCommand} onCopy={copyCommand} />
                            </>
                          )}
                          {ag.installed && !ag.authenticated && instr && (
                            <>
                              <p className="text-xs text-slate-500 pl-5">{ag.auth_note}</p>
                              <CommandCopy command={instr.login} copiedCommand={copiedCommand} onCopy={copyCommand} />
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Row 2: Host Runner + Directory Scan + Approved ── */}
      <div className="grid gap-4 xl:grid-cols-3">

        {/* ── Host Runner ── */}
        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-900">
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
                  <Button type="button" size="sm" variant="outline" className="rounded-xl bg-white text-xs">Start</Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg rounded-3xl">
                  <DialogHeader>
                    <DialogTitle>Start Host Runner</DialogTitle>
                    <DialogDescription>Run once in your terminal from the repo directory.</DialogDescription>
                  </DialogHeader>
                  <CommandCopy command={runnerSafeCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  <p className="text-xs text-slate-400">Or install as a launchd service below so it starts automatically.</p>
                </DialogContent>
              </Dialog>
            </div>
            <div className="mt-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
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
                        <Button type="button" size="sm" className="rounded-xl bg-slate-900 text-xs hover:bg-slate-800">Install</Button>
                      </DialogTrigger>
                      <DialogContent className="max-w-lg rounded-3xl">
                        <DialogHeader>
                          <DialogTitle>Install auto-start service</DialogTitle>
                          <DialogDescription>Starts automatically on login and restarts on crash.</DialogDescription>
                        </DialogHeader>
                        <CommandCopy command="python3 scripts/specter_host_runner.py --install-service" copiedCommand={copiedCommand} onCopy={copyCommand} />
                      </DialogContent>
                    </Dialog>
                  ) : (
                    <>
                      <Button type="button" size="sm" variant="outline" className="rounded-xl bg-white text-xs"
                        disabled={!canUseBackend || restartLaunchd.isPending} onClick={() => restartLaunchd.mutate()}>
                        {restartLaunchd.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="rounded-xl bg-white text-xs text-red-600"
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

        {/* ── Directory Scan ── */}
        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                  <FolderSearch className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-base font-black text-slate-950">Directory scan</h3>
                  <p className="text-xs font-semibold text-slate-500">Discover repositories</p>
                </div>
              </div>
              <Button type="button" variant="outline" className="w-fit rounded-2xl bg-white" onClick={() => setDirectoryScanOpen((open) => !open)}>
                {directoryScanOpen ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                {directoryScanOpen ? "Hide" : "Show"}
              </Button>
            </div>
            {directoryScanOpen && (
              <>
                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <Input className="rounded-2xl bg-white" value={discoveryRoot} onChange={(event) => setDiscoveryRoot(event.target.value)} />
                  <Button type="button" disabled={!canUseBackend || discoverRepositories.isPending || hostRunnerOffline} onClick={() => discoverRepositories.mutate()} className="rounded-2xl bg-cyan-800 hover:bg-cyan-900">
                    {discoverRepositories.isPending && <Loader2 className="mr-2 h-4 w-4" />}
                    {discoverRepositories.isPending ? "Scanning" : "Scan"}
                  </Button>
                </div>
                {discoverRepositories.data && (
                  <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-black text-slate-950">{discoveredRepositories.length} found</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!selectableDiscoveredPaths.length} onClick={() => setSelectedDiscoveredPaths(selectableDiscoveredPaths)} variant="outline" className="rounded-xl bg-white">Select all</Button>
                        <Button size="sm" disabled={!selectedDiscoveredPaths.length} onClick={() => setSelectedDiscoveredPaths([])} variant="outline" className="rounded-xl bg-white">Deselect</Button>
                        <Button size="sm" disabled={!selectedDiscoveredPaths.length || approveSelectedRepositories.isPending} onClick={() => approveSelectedRepositories.mutate()} className="rounded-xl bg-slate-900 hover:bg-slate-800">Add</Button>
                      </div>
                    </div>
                    <div className="mt-3 max-h-56 space-y-2 overflow-auto pr-1">
                      {discoveredRepositories.length ? discoveredRepositories.map((repo) => {
                        const approved = approvedWorkspacePaths.has(repo.path);
                        const checked = selectedDiscoveredPaths.includes(repo.path);
                        return (
                          <label key={repo.path} className="flex cursor-pointer gap-3 rounded-2xl bg-white p-3">
                            <Checkbox checked={approved || checked} disabled={approved}
                              onCheckedChange={(value) => setSelectedDiscoveredPaths((paths) => value ? [...new Set([...paths, repo.path])] : paths.filter((path) => path !== repo.path))} />
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="font-black text-slate-950">{repo.name}</p>
                                {approved && <Badge className="rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Approved</Badge>}
                              </div>
                              <p className="mt-1 break-all text-xs font-semibold leading-5 text-slate-500">{repo.path}</p>
                            </div>
                          </label>
                        );
                      }) : <p className="text-sm font-semibold text-slate-500">No repositories found.</p>}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {/* ── Approved ── */}
        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-2xl bg-slate-100 text-slate-900">
                  <ShieldCheck className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-base font-black text-slate-950">Approved</h3>
                  <p className="text-xs font-semibold text-slate-500">{activeRuntimeWorkspaces.length} repositories</p>
                </div>
              </div>
              <Button type="button" variant="outline" className="rounded-2xl bg-white" onClick={() => setApprovedOpen((open) => !open)}>
                {approvedOpen ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                {approvedOpen ? "Hide" : "Show"}
              </Button>
            </div>
            {approvedOpen && (
              <div className="mt-4 max-h-72 space-y-2 overflow-auto pr-1">
                {activeRuntimeWorkspaces.length ? activeRuntimeWorkspaces.map((workspace) => (
                  <div key={workspace.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-black text-slate-950">{workspace.name}</p>
                        <p className="mt-1 break-all text-xs font-semibold leading-5 text-slate-500">{workspace.path}</p>
                      </div>
                      <Button type="button" size="sm" variant="outline" disabled={deleteWorkspace.isPending} onClick={() => deleteWorkspace.mutate(workspace.id)} className="rounded-xl bg-white">Remove</Button>
                    </div>
                  </div>
                )) : <p className="rounded-2xl bg-slate-50 p-3 text-sm font-semibold text-slate-500">No approved repositories.</p>}
              </div>
            )}
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
          <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
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
                <Button type="button" variant="outline" className="w-fit rounded-2xl bg-white" onClick={() => setTestOpen((o) => !o)}>
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
                      <div className="flex rounded-2xl border border-slate-200 bg-slate-50 p-0.5 gap-0.5">
                        <button
                          type="button"
                          onClick={() => setTestRuntime("sandbox")}
                          className={`rounded-xl px-3 py-1.5 text-xs font-black transition-colors ${isSandbox ? "bg-white shadow-sm text-slate-950" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          Sandbox
                        </button>
                        <button
                          type="button"
                          onClick={() => setTestRuntime("direct")}
                          className={`rounded-xl px-3 py-1.5 text-xs font-black transition-colors ${!isSandbox ? "bg-white shadow-sm text-slate-950" : "text-slate-500 hover:text-slate-700"}`}
                        >
                          Direct CLI
                        </button>
                      </div>
                      {/* Agent selector */}
                      {isSandbox ? (
                        <Select value={sandboxAgent} onValueChange={setSandboxAgent}>
                          <SelectTrigger className="rounded-2xl h-9 text-xs flex-1">
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
                          <SelectTrigger className="rounded-2xl h-9 text-xs flex-1">
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
                        <SelectTrigger className="rounded-2xl">
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
                      <Textarea className="min-h-24 rounded-2xl" value={runtimePrompt} onChange={(e) => setRuntimePrompt(e.target.value)} />
                    </div>

                    {/* Run button */}
                    <Button
                      type="button"
                      disabled={!canRun}
                      onClick={() => isSandbox ? createRuntimeRun.mutate() : createCliRuntimeRun.mutate()}
                      className={`rounded-2xl ${isSandbox ? "bg-emerald-700 hover:bg-emerald-800" : "bg-amber-700 hover:bg-amber-800"}`}
                    >
                      {(isSandbox ? createRuntimeRun.isPending : createCliRuntimeRun.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {(isSandbox ? createRuntimeRun.isPending : createCliRuntimeRun.isPending) ? "Running…" : `Run with ${agentLabel}`}
                    </Button>
                  </div>

                  {/* Output panel */}
                  <div className={isExpanded ? "fixed inset-0 z-50 flex flex-col bg-slate-950 text-white" : "mt-4 rounded-2xl border border-slate-100 bg-slate-950 p-4 text-white"}>
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
                        <div className={isExpanded ? "h-full" : "rounded-2xl bg-emerald-500/10 p-3"}>
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
                            <pre className={`overflow-auto whitespace-pre-wrap rounded-2xl bg-white/5 p-3 text-xs leading-5 text-slate-300 font-mono ${isExpanded ? "h-full" : "max-h-60"}`}>
                              {latestRun.summary || latestRun.stderr || latestRun.error || "No output captured."}
                            </pre>
                          ) : (
                            <div
                              className={`overflow-auto rounded-2xl bg-white/5 p-4 prose prose-invert prose-sm max-w-none
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

        <TabsContent value="logs" className="mt-4">
          <div className="rounded-2xl bg-slate-950 text-white">
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
      </Tabs>
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
    <div className="flex flex-col gap-3 rounded-2xl bg-slate-950 p-4 text-white sm:flex-row sm:items-center sm:justify-between">
      <code className="break-all text-sm font-bold">{command}</code>
      <Button type="button" onClick={() => onCopy(command)} variant="outline" className="rounded-2xl border-white/20 bg-white text-slate-950 hover:bg-slate-100">
        {copiedCommand === command ? <CheckCircle2 className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
        {copiedCommand === command ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
