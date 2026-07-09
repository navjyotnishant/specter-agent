import { Link } from "react-router-dom";
import { Menu } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

function SystemStatusPill() {
  const { token } = useAuth();

  const { data: sandboxStatus } = useQuery({
    queryKey: ["topbar", "docker-sandbox", "status"],
    queryFn: () => api.dockerSandboxRuntimeStatus(token ?? ""),
    enabled: Boolean(token),
    retry: false,
    refetchInterval: 15000,
    staleTime: 10000,
  });

  const hostRunnerOffline = !sandboxStatus || sandboxStatus.status === "host_runner_unavailable";
  const sandboxReady = sandboxStatus?.status === "ready";
  const daemonDown = sandboxStatus?.sandbox_health_status === "daemon_unavailable";

  let label: string;
  let dotClass: string;
  let badgeClass: string;

  if (hostRunnerOffline) {
    label = "System offline";
    dotClass = "bg-red-500";
    badgeClass = "border-red-200 bg-red-50 text-red-700";
  } else if (sandboxReady) {
    label = "System ready";
    dotClass = "bg-emerald-500 animate-pulse";
    badgeClass = "border-emerald-200 bg-emerald-50 text-emerald-700";
  } else if (daemonDown) {
    label = "Daemon down";
    dotClass = "bg-amber-500";
    badgeClass = "border-amber-200 bg-amber-50 text-amber-700";
  } else {
    label = "System degraded";
    dotClass = "bg-amber-500";
    badgeClass = "border-amber-200 bg-amber-50 text-amber-700";
  }

  return (
    <Link to="/settings/models">
      <Badge variant="outline" className={`cursor-pointer rounded-full px-3 py-2 transition-opacity hover:opacity-80 ${badgeClass}`}>
        <span className={`mr-1.5 inline-block h-2 w-2 rounded-full ${dotClass}`} />
        {label}
      </Badge>
    </Link>
  );
}

export function TopBar() {
  return (
    <header className="sticky top-0 z-20 border-b border-white/70 bg-[#f7fbff]/85 px-4 py-4 backdrop-blur-xl sm:px-6">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="icon" className="rounded-2xl border-slate-200 bg-white lg:hidden">
          <Menu className="h-4 w-4" />
        </Button>
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-black tracking-tight text-slate-950 sm:text-2xl">Specter Agent</h1>
            <SystemStatusPill />
          </div>
          <p className="mt-1 text-sm text-slate-600">Govern agent workflows, approvals, and delivery evidence.</p>
        </div>
      </div>
    </header>
  );
}
