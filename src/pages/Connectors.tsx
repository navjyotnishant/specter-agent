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

const MONO: React.CSSProperties = { fontFamily: "ui-monospace, 'Cascadia Code', monospace" };

// ── status badge ─────────────────────────────────────────────────────────────
function StatusBadge({ server }: { server: McpServer }) {
  if (!server.configured) {
    return (
      <span className="border border-[#e5e7eb] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#9ca3af]" style={MONO}>
        not configured
      </span>
    );
  }
  if (!server.enabled) {
    return (
      <span className="border border-[#fcd34d] bg-[#fffbeb] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#92400e]" style={MONO}>
        disabled
      </span>
    );
  }
  if (server.auth_status === "o_auth") {
    return (
      <span className="border border-[#c4b5fd] bg-[#f5f3ff] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#5b21b6]" style={MONO}>
        oauth connected
      </span>
    );
  }
  if (server.auth_status === "unsupported") {
    return (
      <span className="border border-[#6ee7b7] bg-[#ecfdf5] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#065f46]" style={MONO}>
        active
      </span>
    );
  }
  return (
    <span className="border border-[#6ee7b7] bg-[#ecfdf5] px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide text-[#065f46]" style={MONO}>
      {server.auth_status ?? "active"}
    </span>
  );
}

function AuthTypeTag({ type }: { type: string }) {
  const map: Record<string, { label: string; color: string }> = {
    none:    { label: "no auth",  color: "#6b7280" },
    token:   { label: "api token", color: "#0ea5e9" },
    oauth:   { label: "oauth",    color: "#6366f1" },
    unknown: { label: "unknown",  color: "#9ca3af" },
  };
  const cfg = map[type] ?? map.unknown;
  return (
    <span
      className="border px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-wide"
      style={{ borderColor: `${cfg.color}40`, color: cfg.color, background: `${cfg.color}0d`, ...MONO }}
    >
      {cfg.label}
    </span>
  );
}

function TransportTag({ type }: { type: string }) {
  return (
    <span className="border border-[#e5e7eb] px-1.5 py-[1px] text-[9px] text-[#9ca3af]" style={MONO}>
      {type === "streamable_http" ? "http" : type}
    </span>
  );
}

// ── add form for a single catalog entry ──────────────────────────────────────
function AddForm({ server, token, onDone }: { server: McpServer; token: string; onDone: () => void }) {
  const [token_value, setTokenValue] = useState("");
  const queryClient = useQueryClient();

  const add = useMutation({
    mutationFn: () => {
      const payload: Parameters<typeof api.mcpAdd>[1] = {
        name: server.name,
        transport_type: server.transport_type,
      };
      if (server.transport_type === "streamable_http" && server.url) {
        payload.url = server.url;
      } else if (server.add_command) {
        payload.command = server.add_command as string[];
      }
      if (server.auth_type === "token" && server.token_env_var && token_value) {
        payload.env_vars = { [server.token_env_var]: token_value };
      }
      return api.mcpAdd(token, payload);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mcp-list"] });
      onDone();
    },
  });

  return (
    <div className="border-t border-[#f3f4f6] bg-[#fafafa] px-4 py-3" style={MONO}>
      {server.auth_type === "token" && server.token_env_var && (
        <div className="mb-3">
          <label className="mb-1 block text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]">{server.token_label ?? server.token_env_var}</label>
          <input
            type="password"
            placeholder={`Enter ${server.token_env_var}`}
            value={token_value}
            onChange={(e) => setTokenValue(e.target.value)}
            className="w-full border border-[#d1d5db] bg-white px-2.5 py-1.5 text-[11px] text-[#374151] outline-none focus:border-[#374151]"
            style={MONO}
          />
          <p className="mt-1 text-[9px] text-[#9ca3af]">Stored as env var in Codex config — not sent to Specter backend.</p>
        </div>
      )}
      {server.auth_type === "oauth" && (
        <p className="mb-3 text-[10px] text-[#6b7280]">
          After adding, run <code className="bg-[#f3f4f6] px-1">codex mcp login {server.name}</code> in your terminal to complete OAuth.
        </p>
      )}
      {server.auth_type === "none" && (
        <p className="mb-3 text-[10px] text-[#6b7280]">No authentication required.</p>
      )}
      <div className="flex items-center gap-2">
        <button
          onClick={() => add.mutate()}
          disabled={add.isPending || (server.auth_type === "token" && !token_value)}
          className="flex items-center gap-1.5 border border-[#0f1117] bg-[#0f1117] px-3 py-1.5 text-[10px] font-semibold text-white disabled:opacity-40 hover:bg-[#1f2937]"
          style={MONO}
        >
          {add.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
          Add to Codex
        </button>
        <button onClick={onDone} className="text-[10px] text-[#9ca3af] hover:text-[#374151]" style={MONO}>Cancel</button>
        {add.data && !add.data.ok && (
          <span className="text-[10px] text-[#dc2626]" style={MONO}>{add.data.message}</span>
        )}
      </div>
    </div>
  );
}

// ── single server card ───────────────────────────────────────────────────────
function ServerCard({ server, token }: { server: McpServer; token: string }) {
  const [expanded, setExpanded] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [loginInfo, setLoginInfo] = useState<{ command: string; message: string } | null>(null);
  const queryClient = useQueryClient();

  const remove = useMutation({
    mutationFn: () => api.mcpRemove(token, server.name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["mcp-list"] }),
  });

  const getLoginInstructions = useMutation({
    mutationFn: () => api.mcpLoginInstructions(token, server.name),
    onSuccess: (data) => setLoginInfo({ command: data.command ?? "", message: data.message }),
  });

  return (
    <div className="border border-[#e5e7eb] bg-white" style={MONO}>
      {/* header row */}
      <div
        className="flex cursor-pointer items-center gap-3 px-4 py-3 hover:bg-[#fafafa]"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center border border-[#e5e7eb] bg-[#f9fafb]">
          {server.configured
            ? server.enabled
              ? <CheckCircle2 className="h-3.5 w-3.5 text-[#10b981]" />
              : <XCircle className="h-3.5 w-3.5 text-[#9ca3af]" />
            : <Network className="h-3.5 w-3.5 text-[#d1d5db]" />
          }
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[#0f1117]">{server.display_name}</span>
            <StatusBadge server={server} />
            <AuthTypeTag type={server.auth_type} />
            <TransportTag type={server.transport_type} />
          </div>
          <p className="mt-0.5 text-[10px] text-[#6b7280]">{server.description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {server.docs_url && (
            <a
              href={server.docs_url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-[#9ca3af] hover:text-[#374151]"
              title="Docs"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
          {expanded ? <ChevronDown className="h-3.5 w-3.5 text-[#9ca3af]" /> : <ChevronRight className="h-3.5 w-3.5 text-[#9ca3af]" />}
        </div>
      </div>

      {/* expanded section */}
      {expanded && (
        <div className="border-t border-[#f3f4f6]">
          {server.configured ? (
            <div className="px-4 py-3 space-y-3">
              {/* live config summary */}
              {server.live?.transport && (
                <div>
                  <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">Transport config</p>
                  <pre className="overflow-x-auto border border-[#f3f4f6] bg-[#fafafa] p-2.5 text-[9px] leading-relaxed text-[#374151]">
                    {JSON.stringify(server.live.transport, null, 2)}
                  </pre>
                </div>
              )}

              {/* oauth login helper */}
              {server.auth_type === "oauth" && (
                <div>
                  <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">Authentication</p>
                  {loginInfo ? (
                    <div className="border border-[#c4b5fd] bg-[#f5f3ff] p-3">
                      <p className="text-[10px] text-[#5b21b6]">{loginInfo.message}</p>
                      <div className="mt-2 flex items-center gap-2 border border-[#ddd6fe] bg-white p-2">
                        <Terminal className="h-3 w-3 shrink-0 text-[#7c3aed]" />
                        <code className="text-[10px] text-[#374151]">{loginInfo.command}</code>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => getLoginInstructions.mutate()}
                      disabled={getLoginInstructions.isPending}
                      className="flex items-center gap-1.5 border border-[#c4b5fd] bg-[#f5f3ff] px-3 py-1.5 text-[10px] font-semibold text-[#5b21b6] hover:bg-[#ede9fe]"
                      style={MONO}
                    >
                      {getLoginInstructions.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Globe className="h-3 w-3" />}
                      Get login instructions
                    </button>
                  )}
                </div>
              )}

              {/* remove */}
              <div className="flex items-center gap-2 pt-1 border-t border-[#f3f4f6]">
                <button
                  onClick={() => remove.mutate()}
                  disabled={remove.isPending}
                  className="flex items-center gap-1.5 border border-[#fca5a5] bg-white px-3 py-1.5 text-[10px] font-semibold text-[#dc2626] hover:bg-[#fef2f2] disabled:opacity-40"
                  style={MONO}
                >
                  {remove.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                  Remove from Codex
                </button>
                {remove.data && !remove.data.ok && (
                  <span className="text-[10px] text-[#dc2626]">{remove.data.message}</span>
                )}
              </div>
            </div>
          ) : (
            <>
              {!showAdd ? (
                <div className="flex items-center gap-2 px-4 py-3">
                  <button
                    onClick={() => setShowAdd(true)}
                    className="flex items-center gap-1.5 border border-[#0f1117] bg-[#0f1117] px-3 py-1.5 text-[10px] font-semibold text-white hover:bg-[#1f2937]"
                    style={MONO}
                  >
                    Configure &amp; add
                  </button>
                  {server.docs_url && (
                    <a
                      href={server.docs_url}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center gap-1 text-[10px] text-[#6b7280] hover:text-[#374151]"
                      style={MONO}
                    >
                      <ExternalLink className="h-3 w-3" /> Docs
                    </a>
                  )}
                </div>
              ) : (
                <AddForm server={server} token={token} onDone={() => setShowAdd(false)} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────
export default function Connectors() {
  const token = getStoredToken() ?? "";
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["mcp-list"],
    queryFn: () => api.mcpList(token),
    enabled: Boolean(token && token !== "preview-mode"),
    refetchInterval: 30_000,
  });

  const configured = data?.servers.filter((s) => s.configured) ?? [];
  const available = data?.servers.filter((s) => !s.configured) ?? [];

  return (
    <div className="space-y-6" style={MONO}>

      {/* page header */}
      <div className="border border-[#e5e7eb] bg-white px-6 py-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center border border-[#e5e7eb] bg-[#f9fafb]">
              <Network className="h-5 w-5 text-[#374151]" />
            </div>
            <div>
              <p className="text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">MCP Tool Registry</p>
              <h1 className="text-[15px] font-semibold text-[#0f1117]">Connectors</h1>
              <p className="text-[11px] text-[#6b7280]">MCP servers configured in your local Codex CLI. Changes write directly to your Codex config.</p>
            </div>
          </div>
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ["mcp-list"] })}
            className="flex items-center gap-1.5 border border-[#e5e7eb] bg-white px-3 py-1.5 text-[10px] text-[#6b7280] hover:bg-[#f9fafb] hover:text-[#374151]"
            style={MONO}
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </div>
      </div>

      {/* error / loading */}
      {isLoading && (
        <div className="flex items-center gap-2 border border-[#e5e7eb] bg-white px-5 py-4 text-[11px] text-[#6b7280]">
          <Loader2 className="h-4 w-4 animate-spin" /> Querying Codex CLI for MCP servers…
        </div>
      )}
      {isError && (
        <div className="flex items-center gap-2 border border-[#fca5a5] bg-[#fef2f2] px-5 py-4 text-[11px] text-[#dc2626]">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error instanceof Error ? error.message : "Host runner unavailable — start the Specter Host Runner to manage MCP servers."}
        </div>
      )}

      {/* configured servers */}
      {configured.length > 0 && (
        <div>
          <div className="mb-2 flex items-center gap-2">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]">Configured ({configured.length})</p>
          </div>
          <div className="space-y-px">
            {configured.map((s) => <ServerCard key={s.id} server={s} token={token} />)}
          </div>
        </div>
      )}

      {/* available to add */}
      {available.length > 0 && (
        <div>
          <div className="mb-2">
            <p className="text-[9px] font-semibold uppercase tracking-widest text-[#6b7280]">Available to configure ({available.length})</p>
            <p className="mt-0.5 text-[10px] text-[#9ca3af]">Expand a row to add the MCP server to your Codex CLI config.</p>
          </div>
          <div className="space-y-px">
            {available.map((s) => <ServerCard key={s.id} server={s} token={token} />)}
          </div>
        </div>
      )}

      {/* empty state */}
      {!isLoading && !isError && !data?.servers.length && (
        <div className="border border-[#e5e7eb] bg-white px-5 py-8 text-center">
          <p className="text-[11px] text-[#9ca3af]">No MCP servers found. Start the Specter Host Runner and ensure Codex CLI is installed.</p>
        </div>
      )}

      {/* footer note */}
      <div className="border border-[#e5e7eb] bg-[#fafafa] px-5 py-3">
        <p className="text-[10px] text-[#9ca3af]">
          MCP servers are managed by <code className="text-[#6b7280]">codex mcp</code> and stored in your local Codex config.
          Specter reads live status from the host runner at <code className="text-[#6b7280]">127.0.0.1:8765</code>.
          OAuth servers require running <code className="text-[#6b7280]">codex mcp login &lt;name&gt;</code> in your terminal.
        </p>
      </div>
    </div>
  );
}
