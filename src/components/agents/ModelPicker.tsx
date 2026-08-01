// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Searchable, family-grouped model picker for a single workflow node.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, Search } from "lucide-react";

import { api } from "@/lib/api";
import { getStoredToken } from "@/lib/auth";
import type { AgentModel } from "@/lib/types";

/** Shared across every picker instance — one query, many consumers. */
export function useAgentModels(agent: string) {
  const token = getStoredToken() ?? "";
  const query = useQuery({
    queryKey: ["agent-models"],
    queryFn: () => api.agentModels(token),
    enabled: Boolean(token),
    retry: false,
    staleTime: 55 * 60 * 1000,
  });
  const set = query.data?.agents?.[agent];
  return { models: set?.models ?? [], source: set?.source ?? "", error: set?.error ?? "", isLoading: query.isLoading };
}

export function ModelPicker({
  agent,
  value,
  onChange,
}: {
  agent: string;
  value: string;
  onChange: (slug: string) => void;
}) {
  const { models, source, error, isLoading } = useAgentModels(agent);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setFilter("");
  }, [open]);

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = needle
      ? models.filter(
          (m) => m.slug.toLowerCase().includes(needle) || m.display_name.toLowerCase().includes(needle),
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
  const selected = models.find((m) => m.slug === value);
  const label = selected?.display_name || (value || "Auto (CLI default)");

  const choose = (slug: string) => {
    onChange(slug);
    setOpen(false);
  };

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-left text-[11px] text-[#111827] outline-none focus:border-[#374151]"
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label}
        </span>
        {selected && (
          <span style={{ fontSize: 9, color: "#94a3b8", flexShrink: 0 }}>{selected.family}</span>
        )}
        <ChevronDown style={{ width: 11, height: 11, color: "#9ca3af", flexShrink: 0 }} />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div style={{
            position: "absolute", top: "calc(100% + 3px)", left: 0, right: 0, zIndex: 50,
            maxHeight: 320, display: "flex", flexDirection: "column",
            background: "white", border: "1px solid #e2e8f0", borderRadius: 8,
            boxShadow: "0 10px 32px rgba(0,0,0,0.14)", overflow: "hidden",
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", borderBottom: "1px solid #f1f5f9" }}>
              <Search style={{ width: 11, height: 11, color: "#94a3b8", flexShrink: 0 }} />
              <input
                ref={searchRef}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder={`Search ${models.length} models…`}
                style={{ flex: 1, border: "none", outline: "none", fontSize: 11, background: "transparent" }}
              />
            </div>

            <div style={{ overflowY: "auto", flex: 1 }}>
              {isLoading ? (
                <p style={{ padding: 12, fontSize: 11, color: "#94a3b8", display: "flex", gap: 5, alignItems: "center" }}>
                  <Loader2 className="animate-spin" style={{ width: 11, height: 11 }} /> Loading models…
                </p>
              ) : error ? (
                <p style={{ padding: "10px 12px", fontSize: 10, color: "#92400e", background: "#fffbeb" }}>{error}</p>
              ) : (
                <>
                  <button onClick={() => choose("")} style={rowStyle(value === "")}>
                    <span style={{ fontWeight: 600 }}>Auto</span>
                    <span style={{ fontSize: 9, color: "#94a3b8" }}>let the CLI choose</span>
                    {value === "" && <Check style={checkStyle} />}
                  </button>
                  {matchCount === 0 ? (
                    <p style={{ padding: "10px 12px", fontSize: 11, color: "#94a3b8" }}>
                      {models.length === 0 ? "No models reported by this CLI." : "No models match that search."}
                    </p>
                  ) : (
                    grouped.map(([family, list]) => (
                      <div key={family}>
                        <p style={{
                          margin: 0, padding: "5px 10px 2px", fontSize: 8, fontWeight: 700,
                          textTransform: "uppercase", letterSpacing: "0.08em", color: "#94a3b8", background: "#fafafa",
                        }}>
                          {family} · {list.length}
                        </p>
                        {list.map((model) => (
                          <button key={model.slug} onClick={() => choose(model.slug)} style={rowStyle(model.slug === value)}>
                            <span style={{ fontWeight: 600 }}>{model.display_name}</span>
                            <span style={{ fontSize: 9, color: "#94a3b8", fontFamily: "ui-monospace, monospace" }}>
                              {model.slug}
                            </span>
                            {model.slug === value && <Check style={checkStyle} />}
                          </button>
                        ))}
                      </div>
                    ))
                  )}
                </>
              )}
            </div>

            {source && (
              <p style={{
                margin: 0, padding: "4px 10px", fontSize: 9, color: "#94a3b8",
                borderTop: "1px solid #f1f5f9", background: "#fafafa",
              }}>
                via <code style={{ fontSize: 9 }}>{source}</code>
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const checkStyle: React.CSSProperties = {
  width: 11, height: 11, color: "#4f46e5", marginLeft: "auto", flexShrink: 0,
};

function rowStyle(active: boolean): React.CSSProperties {
  return {
    display: "flex", alignItems: "baseline", gap: 6, width: "100%", textAlign: "left",
    padding: "5px 10px", border: "none", cursor: "pointer", fontSize: 11,
    background: active ? "#f5f3ff" : "transparent", color: "#0f172a",
  };
}
