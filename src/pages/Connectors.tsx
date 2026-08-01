import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Globe,
  Loader2,
  Network,
  RefreshCw,
  Terminal,
  Trash2,
  XCircle,
} from "lucide-react";
import { getStoredToken } from "@/lib/auth";
import { api } from "@/lib/api";
import type { McpServer } from "@/lib/types";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const CLIENTS = [
  { id: "codex",       label: "Codex",       note: "codex mcp CLI" },
  { id: "claude-code", label: "Claude Code",  note: "~/.claude/settings.json" },
] as const;
type ClientId = typeof CLIENTS[number]["id"];

// ── badges ────────────────────────────────────────────────────────────────────
function StatusBadge({ server }: { server: McpServer }) {
  if (!server.configured)
    return <Badge variant="outline" className="text-slate-400 border-slate-200 text-[10px]">not configured</Badge>;
  if (!server.enabled)
    return <Badge className="bg-amber-100 text-amber-800 text-[10px]">disabled</Badge>;
  if (server.auth_status === "o_auth" || server.auth_status === "oauth")
    return <Badge className="bg-violet-100 text-violet-700 text-[10px]">oauth connected</Badge>;
  if (server.auth_status === "needs_auth")
    return <Badge className="bg-amber-100 text-amber-800 text-[10px]">needs auth</Badge>;
  if (server.auth_status === "unsupported")
    return <Badge className="bg-slate-100 text-slate-500 text-[10px]">no auth</Badge>;
  return <Badge className="bg-emerald-100 text-emerald-800 text-[10px]">{server.auth_status ?? "active"}</Badge>;
}

function AuthTypeTag({ type }: { type: string }) {
  const map: Record<string, string> = {
    none:    "bg-slate-100 text-slate-500",
    token:   "bg-sky-100 text-sky-700",
    oauth:   "bg-[#fff4e6] text-indigo-700",
    unknown: "bg-slate-100 text-slate-400",
  };
  const labels: Record<string, string> = { none: "no auth", token: "api token", oauth: "oauth", unknown: "unknown" };
  return (
    <Badge className={`text-[10px] ${map[type] ?? map.unknown}`}>
      {labels[type] ?? type}
    </Badge>
  );
}

function TransportTag({ type }: { type: string }) {
  return (
    <Badge variant="outline" className="text-[10px] text-slate-400 font-mono">
      {type === "streamable_http" ? "http" : type}
    </Badge>
  );
}

// ── add form ──────────────────────────────────────────────────────────────────
function AddForm({ server, token, client, onDone }: { server: McpServer; token: string; client: ClientId; onDone: () => void }) {
  const [tokenVal, setTokenVal] = useState("");
  const queryClient = useQueryClient();

  const add = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof api.mcpAdd>[1] = {
        name: server.name,
        transport_type: server.transport_type,
      };
      if (server.transport_type === "streamable_http" && server.url) payload.url = server.url;
      else if (server.add_command) payload.command = server.add_command as string[];
      if (server.auth_type === "token" && server.token_env_var && tokenVal)
        payload.env_vars = { [server.token_env_var]: tokenVal };
      return api.mcpAdd(token, payload, client);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["mcp-list", client] }); onDone(); },
  });

  const clientLabel = client === "claude-code" ? "Claude Code" : "Codex";
  const configNote = client === "claude-code"
    ? "Written to ~/.claude/settings.json. Restart Claude Code after adding."
    : "Stored in your local Codex config.";

  return (
    <div className="border-t border-slate-100 bg-slate-50 rounded-b-2xl px-4 py-4 space-y-3">
      {server.auth_type === "token" && server.token_env_var && (
        <div className="space-y-1.5">
          <Label className="text-xs text-slate-600">{server.token_label ?? server.token_env_var}</Label>
          <Input
            type="password"
            placeholder={`Enter ${server.token_env_var}`}
            value={tokenVal}
            onChange={(e) => setTokenVal(e.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-[11px] text-slate-400">{configNote}</p>
        </div>
      )}
      {server.auth_type === "oauth" && (
        <p className="text-xs text-slate-500">
          {client === "claude-code"
            ? "Claude Code handles OAuth automatically on first use after adding."
            : `After adding, run codex mcp login ${server.name} in your terminal to complete OAuth.`}
        </p>
      )}
      {server.auth_type === "none" && <p className="text-xs text-slate-500">No authentication required.</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button
          size="sm"
          onClick={() => add.mutate()}
          disabled={add.isPending || (server.auth_type === "token" && !tokenVal)}
          className="bg-[#ff6d5a] hover:bg-[#f95f4b] text-white text-xs h-8"
        >
          {add.isPending && <Loader2 className="h-3 w-3 animate-spin mr-1.5" />}
          Add to {clientLabel}
        </Button>
        <button onClick={onDone} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
        {add.data && !add.data.ok && <span className="text-xs text-red-600">{add.data.message}</span>}
        {add.data?.ok && <span className="text-xs text-emerald-600">{add.data.message}</span>}
      </div>
    </div>
  );
}

// ── server card ───────────────────────────────────────────────────────────────
function ServerCard({ server, token, client }: { server: McpServer; token: string; client: ClientId }) {
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [loginInfo, setLoginInfo] = useState<{ command?: string; message: string } | null>(null);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.mcpRemove(token, server.name, client),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp-list", client] }),
  });

  const getLoginInstructions = useMutation({
    mutationFn: () => api.mcpLoginInstructions(token, server.name, client),
    onSuccess: (data) => setLoginInfo({ command: data.command, message: data.message }),
  });

  return (
    <Card className={`rounded-[8px] border shadow-none transition-colors ${server.configured ? "border-slate-200" : "border-slate-100"}`}>
      <CardContent className="p-0">
        <div
          className="flex cursor-pointer items-center gap-3 px-4 py-3.5 hover:bg-slate-50 rounded-[8px]"
          onClick={() => setExpanded((v) => !v)}
        >
          {/* icon */}
          <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] ${server.configured ? "bg-indigo-50" : "bg-slate-100"}`}>
            {server.configured
              ? server.enabled
                ? <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                : <XCircle className="h-4 w-4 text-slate-400" />
              : <Network className="h-4 w-4 text-slate-300" />}
          </div>

          {/* info */}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-800">{server.display_name}</span>
              <StatusBadge server={server} />
              <AuthTypeTag type={server.auth_type} />
              <TransportTag type={server.transport_type} />
            </div>
            <p className="mt-0.5 text-xs text-slate-400">{server.description}</p>
          </div>

          {/* right side */}
          <div className="flex shrink-0 items-center gap-2">
            {server.docs_url && (
              <a
                href={server.docs_url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="text-slate-300 hover:text-slate-500"
                title="Docs"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {expanded
              ? <ChevronDown className="h-4 w-4 text-slate-300" />
              : <ChevronRight className="h-4 w-4 text-slate-300" />}
          </div>
        </div>

        {expanded && (
          <div className="border-t border-slate-100">
            {server.configured ? (
              <div className="px-4 py-4 space-y-4">
                {server.live?.transport && (
                  <div className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Current config</p>
                    <pre className="overflow-x-auto rounded-[6px] border border-slate-100 bg-slate-50 p-3 text-[11px] font-mono leading-relaxed text-slate-600">
                      {JSON.stringify(server.live.transport, null, 2)}
                    </pre>
                  </div>
                )}
                {server.auth_type === "oauth" && client === "codex" && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">Authentication</p>
                    {loginInfo ? (
                      <div className="rounded-[6px] border border-violet-100 bg-violet-50 p-3 space-y-2">
                        <p className="text-xs text-violet-700">{loginInfo.message}</p>
                        {loginInfo.command && (
                          <div className="flex items-center gap-2 rounded-lg border border-violet-100 bg-white p-2">
                            <Terminal className="h-3 w-3 shrink-0 text-violet-500" />
                            <code className="text-xs text-slate-700 font-mono">{loginInfo.command}</code>
                          </div>
                        )}
                      </div>
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => getLoginInstructions.mutate()}
                        disabled={getLoginInstructions.isPending}
                        className="h-8 text-xs border-violet-200 text-violet-700 hover:bg-violet-50"
                      >
                        {getLoginInstructions.isPending
                          ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                          : <Globe className="h-3 w-3 mr-1.5" />}
                        Get login instructions
                      </Button>
                    )}
                  </div>
                )}
                <div className="pt-2 border-t border-slate-100">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => remove.mutate()}
                    disabled={remove.isPending}
                    className="h-8 text-xs border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
                  >
                    {remove.isPending
                      ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                      : <Trash2 className="h-3 w-3 mr-1.5" />}
                    Remove
                  </Button>
                  {remove.data && !remove.data.ok && <span className="ml-2 text-xs text-red-600">{remove.data.message}</span>}
                </div>
              </div>
            ) : (
              <>
                {!showAdd ? (
                  <div className="flex items-center gap-3 px-4 py-3">
                    <Button
                      size="sm"
                      onClick={() => setShowAdd(true)}
                      className="h-8 text-xs bg-[#ff6d5a] hover:bg-[#f95f4b] text-white"
                    >
                      Configure &amp; add
                    </Button>
                    {server.docs_url && (
                      <a
                        href={server.docs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600"
                      >
                        <ExternalLink className="h-3 w-3" /> Docs
                      </a>
                    )}
                  </div>
                ) : (
                  <AddForm server={server} token={token} client={client} onDone={() => setShowAdd(false)} />
                )}
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── page ──────────────────────────────────────────────────────────────────────
export default function Connectors() {
  const token = getStoredToken() ?? "";
  const queryClient = useQueryClient();
  const [client, setClient] = useState<ClientId>("codex");
  const [isRefreshing, setIsRefreshing] = useState(false);

  const canFetch = Boolean(token);

  const { data, isLoading, isFetching, isError, error } = useQuery({
    queryKey: ["mcp-list", client],
    queryFn: () => api.mcpList(token, client),
    enabled: canFetch,
    refetchInterval: 60_000,
    staleTime: 20_000,
    // keep previous data visible while switching tabs
    placeholderData: (prev) => prev,
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.refetchQueries({ queryKey: ["mcp-list", client], exact: true });
    } finally {
      setIsRefreshing(false);
    }
  };

  const configured = data?.servers.filter((s) => s.configured) ?? [];
  const available  = data?.servers.filter((s) => !s.configured) ?? [];

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-[8px] bg-[#ff6d5a] text-white shadow-lg shadow-indigo-100">
            <Network className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Connectors</h1>
            <p className="text-sm text-slate-500">Manage MCP servers for each AI agent client</p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isRefreshing || isFetching}
          className="h-9 text-sm rounded-[6px]"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRefreshing || isFetching ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      {/* client selector */}
      <div className="flex gap-2">
        {CLIENTS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setClient(c.id)}
            className={`flex flex-col items-start rounded-[8px] border px-4 py-2.5 text-left transition-colors ${
              client === c.id
                ? "border-indigo-600 bg-[#ff6d5a] text-white shadow-lg shadow-indigo-100"
                : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            <span className="text-sm font-semibold">{c.label}</span>
            <span className={`text-[11px] font-mono ${client === c.id ? "text-indigo-200" : "text-slate-400"}`}>{c.note}</span>
          </button>
        ))}
      </div>

      {/* states */}
      {isLoading && !data && (
        <div className="flex items-center gap-2 rounded-[8px] border border-slate-200 bg-white px-5 py-4 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-500" /> Loading MCP catalog…
        </div>
      )}
      {isError && (
        <Alert variant="destructive" className="rounded-[8px]">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            {error instanceof Error ? error.message : "Host runner unavailable — start it to load the MCP catalog."}
          </AlertDescription>
        </Alert>
      )}

      {!isLoading && !isError && (
        <>
          {/* configured */}
          {configured.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                Configured ({configured.length})
              </p>
              <div className="space-y-2">
                {configured.map((s) => <ServerCard key={s.id} server={s} token={token} client={client} />)}
              </div>
            </div>
          )}

          {/* available */}
          {available.length > 0 && (
            <div className="space-y-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                  Available ({available.length})
                </p>
                <p className="text-xs text-slate-400 mt-0.5">Expand a row to configure and add.</p>
              </div>
              <div className="space-y-2">
                {available.map((s) => <ServerCard key={s.id} server={s} token={token} client={client} />)}
              </div>
            </div>
          )}

          {!configured.length && !available.length && (
            <Card className="rounded-[8px] border-slate-100">
              <CardContent className="px-5 py-10 text-center">
                <p className="text-sm text-slate-400">No MCP servers found. Ensure the host runner is running.</p>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* footer note */}
      <Card className="rounded-[8px] border-slate-100 bg-slate-50 shadow-none">
        <CardContent className="px-5 py-3">
          <p className="text-xs text-slate-400">
            {client === "codex"
              ? <>MCP servers managed via <code className="font-mono text-slate-600">codex mcp</code>. OAuth requires <code className="font-mono text-slate-600">codex mcp login &lt;name&gt;</code> in your terminal.</>
              : <>Config written to <code className="font-mono text-slate-600">~/.claude/settings.json</code> under <code className="font-mono text-slate-600">mcpServers</code>. Restart Claude Code after changes.</>}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
