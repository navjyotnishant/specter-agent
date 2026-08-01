// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Header model picker — lists the models each CLI actually reports.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Cpu, Loader2, RefreshCw, Search } from "lucide-react";

import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useModelPreference } from "@/lib/model-preference";
import type { AgentModel } from "@/lib/types";

const AGENT_LABELS: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
};

export function ModelSelector() {
  const { token } = useAuth();
  const [preference, setPreference] = useModelPreference();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const modelsQuery = useQuery({
    queryKey: ["agent-models"],
    queryFn: () => api.agentModels(token ?? ""),
    enabled: Boolean(token),
    retry: false,
    staleTime: 55 * 60 * 1000, // host runner caches for 1h; don't re-ask sooner
  });

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setFilter("");
  }, [open]);

  const agents = modelsQuery.data?.agents ?? {};
  const activeSet = agents[preference.agent];
  const models = useMemo(() => activeSet?.models ?? [], [activeSet]);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = needle
      ? models.filter(
          (m) =>
            m.slug.toLowerCase().includes(needle) ||
            m.display_name.toLowerCase().includes(needle),
        )
      : models;
    const byFamily = new Map<string, AgentModel[]>();
    for (const model of matches) {
      const list = byFamily.get(model.family) ?? [];
      list.push(model);
      byFamily.set(model.family, list);
    }
    return [...byFamily.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [models, filter]);

  const matchCount = grouped.reduce((sum, [, list]) => sum + list.length, 0);
  const selected = models.find((m) => m.slug === preference.model);
  const buttonLabel = selected?.display_name || (preference.model ? preference.model : "Auto");

  const refresh = async () => {
    setRefreshing(true);
    try {
      await api.agentModels(token ?? "", true);
      await modelsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  const choose = (slug: string) => {
    setPreference({ agent: preference.agent, model: slug });
    setOpen(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Default agent and model for new workflow nodes"
        style={{
          display: "flex", alignItems: "center", gap: 6, padding: "5px 10px",
          borderRadius: 999, border: "1px solid #e2e8f0", background: "white",
          cursor: "pointer", fontSize: 12, color: "#0f172a", maxWidth: 260,
        }}
      >
        <Cpu style={{ width: 12, height: 12, color: "#4f46e5", flexShrink: 0 }} />
        <span style={{ fontWeight: 700 }}>{AGENT_LABELS[preference.agent] ?? preference.agent}</span>
        <span style={{ color: "#cbd5e1" }}>/</span>
        <span style={{ color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {buttonLabel}
        </span>
        <ChevronDown style={{ width: 12, height: 12, color: "#94a3b8", flexShrink: 0 }} />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 50,
            width: 340, maxHeight: 460, display: "flex", flexDirection: "column",
            background: "white", border: "1px solid #e2e8f0", borderRadius: 12,
            boxShadow: "0 12px 40px rgba(0,0,0,0.14)", overflow: "hidden",
          }}>
            {/* agent tabs */}
            <div style={{ display: "flex", gap: 4, padding: 8, borderBottom: "1px solid #f1f5f9" }}>
              {Object.keys(AGENT_LABELS).map((agent) => {
                const active = agent === preference.agent;
                const count = agents[agent]?.count ?? 0;
                return (
                  <button
                    key={agent}
                    onClick={() => setPreference({ agent, model: "" })}
                    style={{
                      flex: 1, padding: "5px 6px", fontSize: 11, fontWeight: 700, cursor: "pointer",
                      borderRadius: 7, border: "1px solid " + (active ? "#4f46e5" : "#e2e8f0"),
                      background: active ? "#eef2ff" : "white", color: active ? "#3730a3" : "#64748b",
                    }}
                  >
                    {AGENT_LABELS[agent]}
                    {count > 0 && <span style={{ marginLeft: 4, opacity: 0.65 }}>{count}</span>}
                  </button>
                );
              })}
            </div>

            {/* search */}
            <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 10px", borderBottom: "1px solid #f1f5f9" }}>
              <Search style={{ width: 12, height: 12, color: "#94a3b8", flexShrink: 0 }} />
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Search ${models.length} models…`}
                style={{ flex: 1, border: "none", outline: "none", fontSize: 12, background: "transparent" }}
              />
              <button
                onClick={refresh}
                title="Re-query the CLIs for their model lists"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 2, display: "flex" }}
              >
                <RefreshCw
                  style={{ width: 12, height: 12, color: "#94a3b8" }}
                  className={refreshing ? "animate-spin" : undefined}
                />
              </button>
            </div>

            {/* list */}
            <div style={{ overflowY: "auto", flex: 1 }}>
              {modelsQuery.isLoading ? (
                <p style={{ padding: 16, fontSize: 12, color: "#94a3b8", display: "flex", gap: 6, alignItems: "center" }}>
                  <Loader2 className="animate-spin" style={{ width: 12, height: 12 }} /> Discovering models…
                </p>
              ) : activeSet?.error ? (
                <p style={{ padding: "12px 14px", fontSize: 11, color: "#92400e", background: "#fffbeb" }}>
                  {activeSet.error}
                </p>
              ) : matchCount === 0 ? (
                <p style={{ padding: "12px 14px", fontSize: 12, color: "#94a3b8" }}>
                  {models.length === 0 ? "No models reported by this CLI." : "No models match that search."}
                </p>
              ) : (
                <>
                  <button onClick={() => choose("")} style={rowStyle(preference.model === "")}>
                    <span style={{ fontWeight: 600 }}>Auto</span>
                    <span style={{ fontSize: 10, color: "#94a3b8" }}>let the CLI choose</span>
                    {preference.model === "" && <Check style={checkStyle} />}
                  </button>
                  {grouped.map(([family, list]) => (
                    <div key={family}>
                      <p style={{
                        margin: 0, padding: "6px 12px 3px", fontSize: 9, fontWeight: 700,
                        textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8",
                        background: "#fafafa",
                      }}>
                        {family} · {list.length}
                      </p>
                      {list.map((model) => (
                        <button key={model.slug} onClick={() => choose(model.slug)} style={rowStyle(model.slug === preference.model)}>
                          <span style={{ fontWeight: 600 }}>{model.display_name}</span>
                          <span style={{ fontSize: 10, color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
                            {model.slug}
                          </span>
                          {model.slug === preference.model && <Check style={checkStyle} />}
                        </button>
                      ))}
                    </div>
                  ))}
                </>
              )}
            </div>

            {activeSet && (
              <p style={{
                margin: 0, padding: "6px 12px", fontSize: 10, color: "#94a3b8",
                borderTop: "1px solid #f1f5f9", background: "#fafafa",
              }}>
                via <code style={{ fontSize: 10 }}>{activeSet.source}</code>
                {activeSet.cached && " · cached"}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const checkStyle: React.CSSProperties = {
  width: 12, height: 12, color: "#4f46e5", marginLeft: "auto", flexShrink: 0,
};

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "baseline", gap: 8, width: "100%", textAlign: "left",
    padding: "6px 12px", border: "none", cursor: "pointer", fontSize: 12,
    background: active ? "#f5f3ff" : "transparent", color: "#0f172a",
  };
}
