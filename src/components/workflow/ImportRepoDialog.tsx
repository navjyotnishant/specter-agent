// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Import an agentic-orchestrator repo (local path or git URL) as a workflow graph.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FolderGit2, Loader2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { classifySkill, defaultSelection, resolvedSkillId, type ImportSelection, type SkillConflict } from "@/lib/repo-import";
import type { ParsedRepository, Skill } from "@/lib/types";

type Props = {
  token: string;
  existingSkills: Skill[];
  onClose: () => void;
  onImport: (parsed: ParsedRepository, selection: ImportSelection, skillIdFor: (key: string) => string) => Promise<void>;
  /** Populate the skill library only -- no workflow graph. */
  onImportSkillsOnly: (parsed: ParsedRepository, selection: ImportSelection, skillIdFor: (key: string) => string) => Promise<void>;
};

const VERDICT_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  compatible: { bg: "#ecfdf5", fg: "#065f46", label: "Compatible" },
  partial: { bg: "#fffbeb", fg: "#92400e", label: "Partially compatible" },
  incompatible: { bg: "#fef2f2", fg: "#991b1b", label: "Not compatible" },
};

const CONFLICT_STYLE: Record<SkillConflict, { bg: string; fg: string; label: string }> = {
  new: { bg: "#eef2ff", fg: "#3730a3", label: "new" },
  update: { bg: "#ecfdf5", fg: "#065f46", label: "overwrite" },
  conflict: { bg: "#fef2f2", fg: "#991b1b", label: "name taken (kept separate)" },
};

export function ImportRepoDialog({ token, existingSkills, onClose, onImport, onImportSkillsOnly }: Props) {
  const [sourceMode, setSourceMode] = useState<"local" | "url">("local");
  const [repoPath, setRepoPath] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  // Where a cloned repo lands. Cloning writes to disk, so the destination must
  // be an approved workspace -- the backend refuses an unapproved one, but
  // until now the UI never asked, so the clone request always sent no
  // destination and every git-URL import failed with "Workspace path is
  // required."
  const [cloneDestination, setCloneDestination] = useState("");
  const [parsed, setParsed] = useState<ParsedRepository | null>(null);
  const [selection, setSelection] = useState<ImportSelection>({ skills: new Set(), agents: new Set() });
  const [error, setError] = useState("");
  const [checksOpen, setChecksOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [scopedTo, setScopedTo] = useState("");
  // Skills whose documented approval gate the user explicitly waived.
  const [ungated, setUngated] = useState<Set<string>>(new Set());

  const workspacesQuery = useQuery({
    queryKey: ["runtime-workspaces"],
    queryFn: () => api.runtimeWorkspaces(token),
    retry: false,
  });

  const existingByKey = useMemo(
    () => new Map(existingSkills.map((s) => [s.id, { source_repo: s.source_repo }])),
    [existingSkills],
  );

  const analyze = useMutation({
    mutationFn: async (): Promise<ParsedRepository> => {
      let path = repoPath.trim();
      if (sourceMode === "url") {
        const cloned = await api.cloneRepository(token, {
          repo_url: repoUrl.trim(),
          destination: cloneDestination,
        });
        if (!cloned.ok || !cloned.path) throw new Error(cloned.message ?? "Clone failed.");
        // A /tree/<ref>/<subdir> URL scopes the scan to that subdirectory.
        setScopedTo(cloned.subpath || "");
        path = cloned.path;
      } else {
        setScopedTo("");
      }
      if (!path) throw new Error("Choose a repository first.");
      return api.parseRepository(token, { repo_path: path });
    },
    onSuccess: (result) => {
      // call_host_runner degrades to a 200 with an unrelated shape when the host
      // runner is down, so never blind-read .skills -- check the contract first.
      if (!result?.ok || !result.compat) {
        setError(result?.message ?? "The host runner did not return a parse result. Is it running?");
        setParsed(null);
        return;
      }
      setError("");
      setParsed(result);
      setSelection(defaultSelection(result));
      setUngated(new Set());
    },
    onError: (err: Error) => {
      setError(err.message || "Could not analyze that repository.");
      setParsed(null);
    },
  });

  const compat = parsed?.compat;
  const repoPathValue = parsed?.repo?.path ?? "";
  const repoName = parsed?.repo?.name ?? "repository";
  const skills = (parsed?.skills ?? []).filter((s) => !s.error);
  const agents = (parsed?.agents ?? []).filter((a) => !a.error);
  const agentByKey = useMemo(() => new Map(agents.map((a) => [a.key, a])), [agents]);
  const standaloneAgents = agents.filter((a) => !a.spawned_by?.length);

  // Only skills that spawn an agent become supervisor nodes. The rest are real
  // capabilities but produce no node -- they ride along as attached skills -- so
  // they're separated out to avoid implying a node that never appears.
  const orchestrators = useMemo(
    () => skills.filter((s) => s.spawns.some((r) => r.kind === "agent" && agentByKey.has(r.key))),
    [skills, agentByKey],
  );
  const leafSkills = useMemo(
    () => skills.filter((s) => !s.spawns.some((r) => r.kind === "agent" && agentByKey.has(r.key))),
    [skills, agentByKey],
  );
  const [showLeafSkills, setShowLeafSkills] = useState(false);

  const skillIdFor = useMemo(() => {
    const map = new Map<string, string>();
    for (const skill of skills) {
      const conflict = classifySkill(skill.key, repoPathValue, existingByKey);
      map.set(skill.key, resolvedSkillId(skill.key, conflict, repoName));
    }
    return (key: string) => map.get(key) ?? key;
  }, [skills, repoPathValue, repoName, existingByKey]);

  const toggle = (kind: "skills" | "agents", key: string, on?: boolean) => {
    setSelection((cur) => {
      const next = { skills: new Set(cur.skills), agents: new Set(cur.agents) };
      const target = next[kind];
      const enable = on ?? !target.has(key);
      if (enable) target.add(key);
      else target.delete(key);
      // A skill's checkbox cascades to the agents it spawns -- that fan-out is the
      // whole reason the skill is worth importing, so unchecking has to undo it too.
      if (kind === "skills") {
        const spawned = (skills.find((s) => s.key === key)?.spawns ?? [])
          .filter((ref) => ref.kind === "agent" && agentByKey.has(ref.key))
          .map((ref) => ref.key);

        if (enable) {
          for (const agentKey of spawned) next.agents.add(agentKey);
        } else {
          // Agents are shared: several skills can spawn the same reviewer. Only
          // drop one if no *other* still-selected skill depends on it.
          for (const agentKey of spawned) {
            const stillNeeded = skills.some(
              (other) =>
                other.key !== key &&
                next.skills.has(other.key) &&
                other.spawns.some((ref) => ref.kind === "agent" && ref.key === agentKey),
            );
            if (!stillNeeded) next.agents.delete(agentKey);
          }
        }
      }
      return next;
    });
  };

  const toggleGate = (key: string) => {
    setUngated((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = (on: boolean) => {
    setSelection(on ? defaultSelection(parsed as ParsedRepository) : { skills: new Set(), agents: new Set() });
  };

  // Only warn about waivers on skills actually being imported.
  const waivedSelected = skills.filter(
    (s) => s.approval?.required && ungated.has(s.key) && selection.skills.has(s.key),
  );
  const pickedCount = selection.skills.size + selection.agents.size;
  const canImport = Boolean(parsed && compat && compat.verdict !== "incompatible" && pickedCount > 0 && !importing);
  // Agents produce no skills rows, so a skills-only import needs at least one skill.
  const canImportSkills = Boolean(
    parsed && compat && compat.verdict !== "incompatible" && selection.skills.size > 0 && !importing,
  );

  const runImport = async (skillsOnly = false) => {
    if (!parsed) return;
    setImporting(true);
    try {
      const handler = skillsOnly ? onImportSkillsOnly : onImport;
      await handler(parsed, { ...selection, ungated }, skillIdFor);
      onClose();
    } catch (err) {
      setError((err as Error).message || "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const verdictStyle = compat ? VERDICT_STYLE[compat.verdict] ?? VERDICT_STYLE.partial : null;

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 100, background: "rgba(15,17,23,0.45)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 24,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white", borderRadius: 12, width: "min(900px, 100%)", maxHeight: "88vh",
          display: "flex", flexDirection: "column", boxShadow: "0 24px 60px rgba(0,0,0,0.25)",
        }}
      >
        <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderBottom: "1px solid #e2e8f0" }}>
          <FolderGit2 className="h-4 w-4" style={{ color: "#4f46e5" }} />
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#0f172a" }}>Import from repository</h2>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: "#64748b" }}>
              Analyze a repo's skills and agents, then bring the ones you pick onto the canvas.
            </p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8" }}>
            <X className="h-4 w-4" />
          </button>
        </header>

        <div style={{ padding: "16px 20px", overflowY: "auto", flex: 1 }}>
          {/* ── step 1: source ── */}
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {(["local", "url"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setSourceMode(mode)}
                style={{
                  padding: "4px 10px", fontSize: 11, fontWeight: 600, cursor: "pointer",
                  borderRadius: 6, border: "1px solid " + (sourceMode === mode ? "#4f46e5" : "#e2e8f0"),
                  background: sourceMode === mode ? "#eef2ff" : "white",
                  color: sourceMode === mode ? "#3730a3" : "#64748b",
                }}
              >
                {mode === "local" ? "Local path" : "Git URL"}
              </button>
            ))}
          </div>

          {sourceMode === "local" ? (
            <div style={{ display: "flex", gap: 8 }}>
              <select
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                style={{ flex: 1, fontSize: 12, padding: "6px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}
              >
                <option value="">Select an approved workspace…</option>
                {(workspacesQuery.data ?? []).filter((w) => w.is_active).map((w) => (
                  <option key={w.id} value={w.path}>{w.name} — {w.path}</option>
                ))}
              </select>
              <input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/absolute/path/to/repo (or a subdirectory)"
                style={{ flex: 1, fontSize: 12, padding: "6px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}
              />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/owner/repo (or …/tree/main/subdir)"
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}
              />
              <select
                value={cloneDestination}
                onChange={(e) => setCloneDestination(e.target.value)}
                style={{ width: "100%", fontSize: 12, padding: "6px 8px", border: "1px solid #e2e8f0", borderRadius: 6 }}
              >
                <option value="">Clone into which approved workspace?</option>
                {(workspacesQuery.data ?? []).filter((w) => w.is_active).map((w) => (
                  <option key={w.id} value={w.path}>{w.name} — {w.path}</option>
                ))}
              </select>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <Button
              onClick={() => analyze.mutate()}
              disabled={analyze.isPending || (sourceMode === "local" ? !repoPath.trim() : !repoUrl.trim() || !cloneDestination)}
              className="h-8 rounded-none bg-[#0f1117] px-3 text-[11px] font-medium text-white hover:bg-[#1f2937] disabled:opacity-40"
            >
              {analyze.isPending ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : <Download className="mr-1.5 h-3 w-3" />}
              {sourceMode === "url" ? "Clone and analyze" : "Analyze repository"}
            </Button>
          </div>

          {error && (
            <p style={{ marginTop: 10, fontSize: 11, color: "#991b1b", background: "#fef2f2", padding: "8px 10px", borderRadius: 6 }}>
              {error}
            </p>
          )}

          {/* ── step 2: compatibility ── */}
          {compat && verdictStyle && (
            <div style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: verdictStyle.bg }}>
                {compat.verdict === "compatible"
                  ? <CheckCircle2 className="h-4 w-4" style={{ color: verdictStyle.fg }} />
                  : <AlertTriangle className="h-4 w-4" style={{ color: verdictStyle.fg }} />}
                <span style={{ fontSize: 12, fontWeight: 700, color: verdictStyle.fg }}>{verdictStyle.label}</span>
                <span style={{ fontSize: 11, color: verdictStyle.fg, opacity: 0.85 }}>
                  score {compat.score}/100 · layout “{compat.shape}”
                </span>
                <span style={{ marginLeft: "auto", fontSize: 11, color: verdictStyle.fg }}>
                  {compat.counts.skills} skills · {compat.counts.agents} agents · {compat.counts.refs} connections
                  {compat.counts.excluded > 0 && ` · ${compat.counts.excluded} excluded`}
                </span>
              </div>
              <button
                onClick={() => setChecksOpen((v) => !v)}
                style={{
                  display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 12px",
                  background: "white", border: "none", borderTop: "1px solid #f1f5f9", cursor: "pointer",
                  fontSize: 11, color: "#475569",
                }}
              >
                {checksOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                Standards checks ({compat.checks.filter((c) => !c.ok).length} of {compat.checks.length} flagged)
              </button>
              {checksOpen && (
                <div style={{ padding: "0 12px 10px", background: "white" }}>
                  {compat.checks.map((check) => (
                    <div key={check.id} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 11, alignItems: "baseline" }}>
                      <span style={{
                        fontSize: 9, fontWeight: 700, textTransform: "uppercase", minWidth: 42,
                        color: check.ok ? "#059669" : check.level === "error" ? "#dc2626" : check.level === "warn" ? "#d97706" : "#64748b",
                      }}>
                        {check.ok ? "pass" : check.level}
                      </span>
                      <span style={{ color: check.ok ? "#64748b" : "#0f172a" }}>{check.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {scopedTo && (
            <p style={{ marginTop: 8, fontSize: 11, color: "#3730a3", background: "#eef2ff", padding: "6px 10px", borderRadius: 6 }}>
              Scanning only <code style={{ fontSize: 11 }}>{scopedTo}/</code> — the URL pointed at that subdirectory.
            </p>
          )}
          {(parsed?.warnings ?? []).map((warning) => (
            <p key={warning} style={{ marginTop: 8, fontSize: 11, color: "#92400e" }}>{warning}</p>
          ))}

          {/* ── step 3: pick ── */}
          {compat && compat.verdict !== "incompatible" && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                <h3 style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#0f172a" }}>
                  What to import ({pickedCount} selected)
                </h3>
                <button onClick={() => selectAll(true)} style={linkBtn}>Select all</button>
                <button onClick={() => selectAll(false)} style={linkBtn}>Clear</button>
              </div>

              {orchestrators.length > 0 && (
                <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "#94a3b8", letterSpacing: "0.08em" }}>
                  Orchestrators — each becomes a supervisor node
                </p>
              )}

              {orchestrators.map((skill) => {
                const conflict = classifySkill(skill.key, repoPathValue, existingByKey);
                const badge = CONFLICT_STYLE[conflict];
                const spawned = skill.spawns.filter((r) => r.kind === "agent" && agentByKey.has(r.key));
                return (
                  <div key={skill.key} style={{ borderTop: "1px solid #f1f5f9", padding: "8px 0" }}>
                    <label style={{ display: "flex", gap: 8, alignItems: "baseline", cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={selection.skills.has(skill.key)}
                        onChange={() => toggle("skills", skill.key)}
                      />
                      <span style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{skill.name}</span>
                      {skill.class && (
                        <span style={{ fontSize: 9, color: "#64748b" }}>
                          {skill.class}{skill.subclass ? `/${skill.subclass}` : ""}
                        </span>
                      )}
                      <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: badge.bg, color: badge.fg }}>
                        {badge.label}
                      </span>
                      {skill.approval?.required && (
                        <span
                          title={`The source gates this — ${skill.approval.reason}`}
                          style={{
                            fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4,
                            background: ungated.has(skill.key) ? "#fef2f2" : "#fffbeb",
                            color: ungated.has(skill.key) ? "#991b1b" : "#92400e",
                          }}
                        >
                          {ungated.has(skill.key) ? "gate waived" : "needs approval"}
                        </span>
                      )}
                    </label>
                    {skill.approval?.required && selection.skills.has(skill.key) && (
                      <label
                        style={{
                          display: "flex", gap: 5, alignItems: "baseline", cursor: "pointer",
                          margin: "3px 0 0 24px", fontSize: 10, color: "#92400e",
                        }}
                      >
                        <input
                          type="checkbox"
                          checked={ungated.has(skill.key)}
                          onChange={() => toggleGate(skill.key)}
                        />
                        <span>
                          Run without approval — {skill.approval.reason}, so it would act
                          without asking.
                        </span>
                      </label>
                    )}
                    <p style={{ margin: "2px 0 0 24px", fontSize: 11, color: "#64748b" }}>
                      {skill.description.slice(0, 150)}{skill.description.length > 150 ? "…" : ""}
                    </p>
                    {spawned.length > 0 && (
                      <div style={{ margin: "4px 0 0 24px", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                        <span style={{ fontSize: 10, color: "#94a3b8" }}>spawns {spawned.length} →</span>
                        {spawned.map((ref) => (
                          <label key={ref.key} style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 10, color: "#334155", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={selection.agents.has(ref.key)}
                              onChange={() => toggle("agents", ref.key)}
                            />
                            {ref.key}
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}

              {leafSkills.length > 0 && (
                <div style={{ borderTop: "1px solid #f1f5f9", marginTop: 4 }}>
                  <button
                    onClick={() => setShowLeafSkills((v) => !v)}
                    style={{
                      display: "flex", alignItems: "center", gap: 6, width: "100%",
                      padding: "8px 0", background: "none", border: "none", cursor: "pointer",
                      fontSize: 11, color: "#475569", textAlign: "left",
                    }}
                  >
                    {showLeafSkills ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                    <span style={{ fontWeight: 600 }}>{leafSkills.length} standalone skills</span>
                    <span style={{ color: "#94a3b8" }}>
                      — no agents to orchestrate, so they add no node
                    </span>
                  </button>
                  {showLeafSkills && (
                    <div style={{ paddingBottom: 8 }}>
                      <p style={{ margin: "0 0 6px 24px", fontSize: 10, color: "#94a3b8" }}>
                        Imported as reusable skills you can attach to any node from the inspector.
                      </p>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginLeft: 24 }}>
                        {leafSkills.map((skill) => (
                          <label key={skill.key} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11, color: "#334155", cursor: "pointer" }}>
                            <input
                              type="checkbox"
                              checked={selection.skills.has(skill.key)}
                              onChange={() => toggle("skills", skill.key)}
                            />
                            {skill.name}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {standaloneAgents.length > 0 && (
                <>
                  <p style={{ margin: "12px 0 4px", fontSize: 10, fontWeight: 700, textTransform: "uppercase", color: "#94a3b8", letterSpacing: "0.08em" }}>
                    Standalone agents — run on their own, no supervisor
                  </p>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                    {standaloneAgents.map((agent) => (
                      <label key={agent.key} style={{ display: "flex", gap: 5, alignItems: "center", fontSize: 11, color: "#334155", cursor: "pointer" }}>
                        <input
                          type="checkbox"
                          checked={selection.agents.has(agent.key)}
                          onChange={() => toggle("agents", agent.key)}
                        />
                        {agent.name}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {waivedSelected.length > 0 && (
          <div style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            padding: "10px 20px", borderTop: "1px solid #fecaca", background: "#fef2f2",
          }}>
            <AlertTriangle className="h-4 w-4" style={{ color: "#991b1b", flexShrink: 0, marginTop: 1 }} />
            <p style={{ margin: 0, fontSize: 11, color: "#991b1b" }}>
              <strong>
                {waivedSelected.length} skill{waivedSelected.length === 1 ? "" : "s"} will run without
                the approval step {waivedSelected.length === 1 ? "its" : "their"} source requires
              </strong>{" "}
              ({waivedSelected.map((s) => s.name || s.key).join(", ")}). These act on their own — writing
              files, creating tracker items, or posting externally — with no human check. You can still
              add approval nodes by hand on the canvas.
            </p>
          </div>
        )}

        <footer style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 20px", borderTop: "1px solid #e2e8f0" }}>
          <Button variant="outline" onClick={onClose}
            className="h-8 rounded-none border-[#d1d5db] px-3 text-[11px] font-medium text-[#374151]">
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => runImport(true)}
            disabled={!canImportSkills}
            title={
              selection.skills.size === 0
                ? "Select at least one skill — agents alone create no library entries."
                : "Add these skills to your library without creating a workflow"
            }
            className="h-8 rounded-none border-[#d1d5db] px-3 text-[11px] font-medium text-[#374151] disabled:opacity-40"
          >
            {importing ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
            Import to skill library
            {selection.skills.size > 0 ? ` (${selection.skills.size})` : ""}
          </Button>
          <Button onClick={() => runImport(false)} disabled={!canImport}
            title="Create a workflow from the selected skills and agents"
            className="h-8 rounded-none bg-[#0f1117] px-3 text-[11px] font-medium text-white hover:bg-[#1f2937] disabled:opacity-40">
            {importing ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
            Import to workflow{pickedCount > 0 ? ` (${pickedCount})` : ""}
          </Button>
        </footer>
      </div>
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontSize: 11, color: "#4f46e5", textDecoration: "underline",
};
