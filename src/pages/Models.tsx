import { useState } from "react";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const codexSigninCommand = "codex";
const dockerSandboxMacInstallCommand = "brew install docker/tap/sbx";
const dockerSandboxWindowsInstallCommand = "winget install Docker.sbx";
const runnerSafeCommand = "python3 scripts/specter_host_runner.py";

const SANDBOX_AGENTS: Record<string, { label: string; authCommand: string; template: string }> = {
  codex:  { label: "Codex",       authCommand: "sbx secret set -g openai --oauth", template: "docker/sandbox-templates:codex" },
  claude: { label: "Claude Code", authCommand: "sbx secret set -g anthropic",      template: "docker/sandbox-templates:claude-code" },
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

  const canUseBackend = Boolean(token && token !== "preview-mode");
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
  const { data: runnerMode } = useQuery({
    queryKey: ["host-runner", "mode"],
    queryFn: () => api.hostRunnerMode(token ?? ""),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
  });
  const { data: runnerLogs } = useQuery({
    queryKey: ["host-runner", "logs"],
    queryFn: () => api.hostRunnerLogs(token ?? ""),
    enabled: canUseBackend && dockerSandboxRuntime?.status !== "host_runner_unavailable",
    retry: false,
    refetchInterval: activeRunStartedAt ? 1000 : 5000,
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
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onSuccess: () => {
      setActiveRunStartedAt(null);
      queryClient.invalidateQueries({ queryKey: ["runtime-runs", "codex-cli"] });
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
    },
    onError: (err) => {
      setActiveRunStartedAt(null);
      queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] });
      setError(err instanceof Error ? err.message : "Unable to run Codex runtime test");
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
  const recentRunnerLogs = runnerLogs?.logs?.slice(-20).reverse() ?? [];
  const activeRuntimeWorkspaces = runtimeWorkspaces.filter((workspace) => workspace.is_active);
  const latestRuntimeRun = runtimeRuns[0];
  const runtimeRunInProgress = Boolean(activeRunStartedAt) || createRuntimeRun.isPending;
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

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <Badge className="mb-2 rounded-full bg-slate-900 text-white hover:bg-slate-900">Local execution</Badge>
          <h2 className="text-3xl font-black text-slate-950">Models</h2>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {summaryTiles.map((tile) => (
            <div key={tile.label} className={`rounded-2xl border px-4 py-3 text-center shadow-sm ${tile.className}`}>
              <p className="text-xl font-black">{tile.value}</p>
              <p className={`text-xs font-bold uppercase ${tile.labelClassName}`}>{tile.label}</p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="rounded-2xl">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
        <Card className="rounded-[1.5rem] border-emerald-100 bg-white/90 shadow-sm">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-800">
                  <Box className="h-6 w-6" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-black text-slate-950">Docker Sandbox</h3>
                    <Badge className="rounded-full bg-slate-900 text-white hover:bg-slate-900">Preferred</Badge>
                    <Badge className={`rounded-full ${dockerSandboxBadge.className} hover:bg-current/0`}>
                      {sandboxRuntimeLoading && canUseBackend ? "Checking" : dockerSandboxBadge.label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-600">{sandboxStatusLine(dockerSandboxRuntime)}</p>
                  {dockerSandboxRuntime?.executable_path && (
                    <p className="mt-1 break-all text-xs font-semibold text-slate-400">{shortPath(dockerSandboxRuntime.executable_path)}</p>
                  )}
                </div>
              </div>
              <Button
                type="button"
                disabled={!canUseBackend}
                onClick={() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "docker-sandbox"] })}
                variant="outline"
                className="rounded-2xl bg-white"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Re-check
              </Button>
            </div>

            {/* Agent selector */}
            <div className="mt-4 flex gap-1 rounded-2xl border border-slate-100 bg-slate-50 p-1">
              {Object.entries(SANDBOX_AGENTS).map(([key, ag]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setSandboxAgent(key);
                    try { localStorage.setItem("specter_sandbox_agent", key); } catch {}
                  }}
                  style={{
                    flex: 1, padding: "6px 10px", borderRadius: 12, fontSize: 12, fontWeight: 700,
                    border: "none", cursor: "pointer", transition: "all 0.15s",
                    background: sandboxAgent === key ? "white" : "transparent",
                    color: sandboxAgent === key ? "#0f172a" : "#64748b",
                    boxShadow: sandboxAgent === key ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                  }}
                >
                  {ag.label}
                </button>
              ))}
            </div>

            <div className="mt-4 grid gap-3 rounded-2xl border border-emerald-100 bg-emerald-50/70 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="rounded-full bg-white text-emerald-800 hover:bg-white">microVM isolation</Badge>
                <Badge className="rounded-full bg-white text-emerald-800 hover:bg-white">
                  {SANDBOX_AGENTS[sandboxAgent]?.template ?? dockerSandboxRuntime?.base_image ?? "docker/sandbox-templates:codex"}
                </Badge>
              </div>
              <p className="text-sm font-semibold leading-6 text-emerald-950">
                {SANDBOX_AGENTS[sandboxAgent]?.label ?? "Agent"} tasks will run inside a disposable Docker Sandbox while Specter keeps approvals, workspace allowlists, logs, and evidence in the app.
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-slate-100 bg-white p-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-black text-slate-950">Network policy</p>
                  <p className="text-xs font-semibold leading-5 text-slate-500">
                    {sandboxPolicyDescriptions[sandboxPolicy?.current_policy ?? ""] ?? sandboxPolicy?.message ?? "Current policy unavailable."}
                  </p>
                </div>
                <Select
                  value={sandboxPolicy?.current_policy && ["balanced", "deny-all", "allow-all"].includes(sandboxPolicy.current_policy) ? sandboxPolicy.current_policy : ""}
                  onValueChange={(value) => setSandboxPolicy.mutate(value as "allow-all" | "balanced" | "deny-all")}
                  disabled={!canUseBackend || hostRunnerOffline || setSandboxPolicy.isPending}
                >
                  <SelectTrigger className="w-full rounded-2xl bg-white sm:w-44">
                    <SelectValue placeholder="Select policy" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="balanced">Balanced</SelectItem>
                    <SelectItem value="deny-all">Deny all</SelectItem>
                    <SelectItem value="allow-all">Allow all</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Dialog>
              <DialogTrigger asChild>
                <Button type="button" variant="outline" className="mt-4 rounded-2xl bg-white">
                  Setup commands
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl rounded-3xl">
                <DialogHeader>
                  <DialogTitle>Docker Sandbox Setup</DialogTitle>
                  <DialogDescription>
                    Install sbx once on the host, then authenticate {SANDBOX_AGENTS[sandboxAgent]?.label ?? "the agent"} for sandboxed runs.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3">
                  <CommandCopy command={dockerSandboxRuntime?.install_guidance?.macos ?? dockerSandboxMacInstallCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  <CommandCopy command={dockerSandboxRuntime?.install_guidance?.windows ?? dockerSandboxWindowsInstallCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  <CommandCopy command={SANDBOX_AGENTS[sandboxAgent]?.authCommand ?? "sbx secret set -g openai --oauth"} copiedCommand={copiedCommand} onCopy={copyCommand} />
                </div>
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>

        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-slate-100 text-slate-900">
                  <TerminalSquare className="h-6 w-6" />
                </span>
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-xl font-black text-slate-950">Codex CLI</h3>
                    <Badge className="rounded-full bg-slate-100 text-slate-700 hover:bg-slate-100">Fallback</Badge>
                    <Badge className={`rounded-full ${codexBadge.className} hover:bg-current/0`}>
                      {runtimeLoading && canUseBackend ? "Checking" : codexBadge.label}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm font-semibold text-slate-600">{statusLine(codexRuntime)}</p>
                  {codexRuntime?.executable_path && (
                    <p className="mt-1 break-all text-xs font-semibold text-slate-400">{shortPath(codexRuntime.executable_path)}</p>
                  )}
                </div>
              </div>
              <Button
                type="button"
                disabled={!canUseBackend}
                onClick={() => queryClient.invalidateQueries({ queryKey: ["runtime-adapter", "codex-cli"] })}
                variant="outline"
                className="rounded-2xl bg-white"
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Re-check
              </Button>
            </div>

            <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-emerald-700" />
                <div>
                  <p className="text-sm font-black text-slate-950">Maintenance mode</p>
                  <p className="text-xs font-semibold text-slate-500">{maintenanceEnabled ? "Install and upgrade enabled" : "Safe mode"}</p>
                </div>
              </div>
              <Switch
                checked={maintenanceEnabled}
                disabled={!canUseBackend || hostRunnerOffline || setRunnerMode.isPending}
                onCheckedChange={(checked) => setRunnerMode.mutate(checked)}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={!canInstallCodex || installCodex.isPending || !codexRuntime?.install_enabled}
                onClick={() => installCodex.mutate()}
                className="rounded-2xl bg-slate-900 hover:bg-slate-800"
              >
                {installCodex.isPending && <Loader2 className="mr-2 h-4 w-4" />}
                Install
              </Button>
              <Button
                type="button"
                disabled={!canUpgradeCodex || upgradeCodex.isPending || !codexRuntime?.upgrade_enabled}
                onClick={() => upgradeCodex.mutate()}
                variant={codexRuntime?.outdated ? "default" : "outline"}
                className={`rounded-2xl ${codexRuntime?.outdated ? "bg-emerald-700 hover:bg-emerald-800" : "bg-white"}`}
              >
                {upgradeCodex.isPending ? <Loader2 className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                Upgrade
              </Button>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="rounded-2xl bg-white">
                    <KeyRound className="mr-2 h-4 w-4" />
                    Sign in
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg rounded-3xl">
                  <DialogHeader>
                    <DialogTitle>Authenticate Codex CLI</DialogTitle>
                    <DialogDescription>Run this on the host machine, then re-check.</DialogDescription>
                  </DialogHeader>
                  <CommandCopy command={codexSigninCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  <p className="text-sm font-semibold text-slate-500">Credentials stay in the official Codex CLI session.</p>
                </DialogContent>
              </Dialog>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="rounded-2xl bg-white">
                    Runner
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-2xl rounded-3xl">
                  <DialogHeader>
                    <DialogTitle>Host Runner</DialogTitle>
                    <DialogDescription>Start once from the host terminal.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3">
                    <CommandCopy command={runnerSafeCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                    <CommandCopy command={runnerMaintenanceCommand} copiedCommand={copiedCommand} onCopy={copyCommand} />
                  </div>
                </DialogContent>
              </Dialog>
              <Dialog>
                <DialogTrigger asChild>
                  <Button type="button" variant="outline" className="rounded-2xl bg-white">
                    Logs
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-3xl rounded-3xl">
                  <DialogHeader>
                    <DialogTitle>Runner Logs</DialogTitle>
                    <DialogDescription>Latest host runner events.</DialogDescription>
                  </DialogHeader>
                  <div className="max-h-[28rem] space-y-2 overflow-auto rounded-2xl bg-slate-950 p-3 text-white">
                    {recentRunnerLogs.length ? (
                      recentRunnerLogs.map((entry) => (
                        <div key={`${entry.timestamp}-${entry.message}`} className="rounded-xl bg-white/5 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <Badge className="rounded-full bg-white/10 text-white hover:bg-white/10">{entry.level}</Badge>
                            <span className="text-[11px] font-semibold text-slate-400">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                          </div>
                          <p className="mt-1 text-xs font-semibold leading-5 text-slate-200">{entry.message}</p>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm font-semibold text-slate-400">No log entries.</p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      className="rounded-2xl bg-white"
                      onClick={() => queryClient.invalidateQueries({ queryKey: ["host-runner", "logs"] })}
                    >
                      Refresh
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-cyan-100 text-cyan-800">
                  <FolderSearch className="h-5 w-5" />
                </span>
                <div>
                  <h3 className="text-xl font-black text-slate-950">Directory scan</h3>
                  <p className="text-sm font-semibold text-slate-500">Choose a parent directory</p>
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
                  <Button
                    type="button"
                    disabled={!canUseBackend || discoverRepositories.isPending || hostRunnerOffline}
                    onClick={() => discoverRepositories.mutate()}
                    className="rounded-2xl bg-cyan-800 hover:bg-cyan-900"
                  >
                    {discoverRepositories.isPending && <Loader2 className="mr-2 h-4 w-4" />}
                    {discoverRepositories.isPending ? "Scanning" : "Scan"}
                  </Button>
                </div>

                {discoverRepositories.data && (
                  <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-black text-slate-950">{discoveredRepositories.length} found</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={!selectableDiscoveredPaths.length} onClick={() => setSelectedDiscoveredPaths(selectableDiscoveredPaths)} variant="outline" className="rounded-xl bg-white">
                          Select all
                        </Button>
                        <Button size="sm" disabled={!selectedDiscoveredPaths.length} onClick={() => setSelectedDiscoveredPaths([])} variant="outline" className="rounded-xl bg-white">
                          Deselect
                        </Button>
                        <Button size="sm" disabled={!selectedDiscoveredPaths.length || approveSelectedRepositories.isPending} onClick={() => approveSelectedRepositories.mutate()} className="rounded-xl bg-slate-900 hover:bg-slate-800">
                          Add
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 max-h-56 space-y-2 overflow-auto pr-1">
                      {discoveredRepositories.length ? (
                        discoveredRepositories.map((repo) => {
                          const approved = approvedWorkspacePaths.has(repo.path);
                          const checked = selectedDiscoveredPaths.includes(repo.path);
                          return (
                            <label key={repo.path} className="flex cursor-pointer gap-3 rounded-2xl bg-white p-3">
                              <Checkbox
                                checked={approved || checked}
                                disabled={approved}
                                onCheckedChange={(value) => {
                                  setSelectedDiscoveredPaths((paths) =>
                                    value ? [...new Set([...paths, repo.path])] : paths.filter((path) => path !== repo.path),
                                  );
                                }}
                              />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-2">
                                  <p className="font-black text-slate-950">{repo.name}</p>
                                  {approved && <Badge className="rounded-full bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Approved</Badge>}
                                </div>
                                <p className="mt-1 break-all text-xs font-semibold leading-5 text-slate-500">{repo.path}</p>
                              </div>
                            </label>
                          );
                        })
                      ) : (
                        <p className="text-sm font-semibold text-slate-500">No repositories found.</p>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-[0.8fr_1.2fr]">
        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-xl font-black text-slate-950">Approved</h3>
                <p className="text-sm font-semibold text-slate-500">{activeRuntimeWorkspaces.length} repositories</p>
              </div>
              <Button type="button" variant="outline" className="rounded-2xl bg-white" onClick={() => setApprovedOpen((open) => !open)}>
                {approvedOpen ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                {approvedOpen ? "Hide" : "Show"}
              </Button>
            </div>
            {approvedOpen && (
              <div className="mt-4 max-h-72 space-y-2 overflow-auto pr-1">
                {activeRuntimeWorkspaces.length ? (
                  activeRuntimeWorkspaces.map((workspace) => (
                    <div key={workspace.id} className="rounded-2xl border border-slate-100 bg-slate-50 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="font-black text-slate-950">{workspace.name}</p>
                          <p className="mt-1 break-all text-xs font-semibold leading-5 text-slate-500">{workspace.path}</p>
                        </div>
                        <Button type="button" size="sm" variant="outline" disabled={deleteWorkspace.isPending} onClick={() => deleteWorkspace.mutate(workspace.id)} className="rounded-xl bg-white">
                          Remove
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className="rounded-2xl bg-slate-50 p-3 text-sm font-semibold text-slate-500">No approved repositories.</p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-[1.5rem] border-white/80 bg-white/85 shadow-sm">
          <CardContent className="p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-xl font-black text-slate-950">Sandbox test</h3>
                <p className="text-sm font-semibold text-slate-500">{runtimeRunInProgress ? "Running" : latestRuntimeRun?.status ?? "Idle"}</p>
              </div>
              <Button type="button" variant="outline" className="w-fit rounded-2xl bg-white" onClick={() => setTestOpen((open) => !open)}>
                {testOpen ? <ChevronDown className="mr-2 h-4 w-4" /> : <ChevronRight className="mr-2 h-4 w-4" />}
                {testOpen ? "Hide" : "Show"}
              </Button>
            </div>
            {testOpen && (
              <>
                <div className="mt-4 grid gap-3">
                  <div className="space-y-2">
                    <Label>Workspace</Label>
                    <Select value={selectedWorkspaceId} onValueChange={setSelectedWorkspaceId}>
                      <SelectTrigger className="rounded-2xl">
                        <SelectValue placeholder="Select repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {activeRuntimeWorkspaces.map((workspace) => (
                          <SelectItem key={workspace.id} value={workspace.id}>
                            {workspace.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Prompt</Label>
                    <Textarea className="min-h-24 rounded-2xl" value={runtimePrompt} onChange={(event) => setRuntimePrompt(event.target.value)} />
                  </div>
                  <Button
                    type="button"
                    disabled={!selectedWorkspaceId || !runtimePrompt.trim() || !canUseBackend || !sandboxReady || createRuntimeRun.isPending}
                    onClick={() => createRuntimeRun.mutate()}
                    className="rounded-2xl bg-emerald-700 hover:bg-emerald-800"
                  >
                    {createRuntimeRun.isPending && <Loader2 className="mr-2 h-4 w-4" />}
                    {createRuntimeRun.isPending ? "Running" : "Run sandbox test"}
                  </Button>
                </div>
                <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-950 p-4 text-white">
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-black uppercase text-slate-300">Latest run</p>
                    {runtimeRunInProgress ? (
                      <Badge className="rounded-full bg-emerald-500/20 text-emerald-100 hover:bg-emerald-500/20">Running</Badge>
                    ) : latestRuntimeRun ? (
                      <Badge className="rounded-full bg-white/10 text-white hover:bg-white/10">{latestRuntimeRun.status}</Badge>
                    ) : null}
                  </div>
                  {runtimeRunInProgress ? (
                    <div className="flex items-center gap-3 rounded-2xl bg-emerald-500/10 p-3">
                      <Loader2 className="h-4 w-4 text-emerald-200" />
                      <p className="text-sm font-black text-emerald-100">Running since {activeRunStartedAt ?? "now"}</p>
                    </div>
                  ) : latestRuntimeRun ? (
                    <div className="space-y-3">
                      <p className="text-xs font-semibold leading-5 text-slate-300">{latestRuntimeRun.workspace_path}</p>
                      <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-2xl bg-white/5 p-3 text-xs leading-5 text-slate-100">
                        {latestRuntimeRun.summary || latestRuntimeRun.stderr || latestRuntimeRun.error || "No output captured."}
                      </pre>
                    </div>
                  ) : (
                    <p className="text-sm font-semibold text-slate-400">No runs yet.</p>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
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
