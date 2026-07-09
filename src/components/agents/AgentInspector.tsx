import { useState } from "react";
import type { Node } from "@xyflow/react";
import { Loader2, Sparkles } from "lucide-react";
import type { McpServer, Skill } from "@/lib/types";

const MONO: React.CSSProperties = { fontFamily: "ui-monospace, 'Cascadia Code', monospace" };

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-4 text-[9px] font-semibold uppercase tracking-widest text-[#6b7280] first:mt-0" style={MONO}>
      {children}
    </p>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#f3f4f6] pb-3 last:border-b-0 last:pb-0">
      <p className="mb-1 text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]" style={MONO}>{label}</p>
      {children}
    </div>
  );
}

function TextInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="w-full border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]"
      style={MONO}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function TextArea({ value, onChange, rows = 3 }: { value: string; onChange: (v: string) => void; rows?: number }) {
  return (
    <textarea
      rows={rows}
      className="w-full resize-none border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]"
      style={MONO}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      className="w-full border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]"
      style={MONO}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  );
}

function NumericField({ value, onChange, min = 1, max = 20 }: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      className="w-full border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]"
      style={MONO}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function McpChecklist({
  servers,
  selected,
  onChange,
}: {
  servers: McpServer[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (name: string, checked: boolean) =>
    onChange(checked ? [...selected, name] : selected.filter((n) => n !== name));

  if (!servers.length) {
    return (
      <p className="py-2 text-[10px] text-[#9ca3af]" style={MONO}>
        No MCP servers configured. Add them in Connectors.
      </p>
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto border border-[#e5e7eb]">
      {servers.map((s) => {
        const active = s.configured && s.enabled;
        const checked = selected.includes(s.name);
        return (
          <label
            key={s.name}
            className={`flex cursor-pointer items-start gap-2 border-b border-[#f3f4f6] px-3 py-2 last:border-b-0 ${active ? "hover:bg-[#f9fafb]" : "opacity-50"}`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-3 w-3"
              checked={checked}
              disabled={!active}
              onChange={(e) => toggle(s.name, e.target.checked)}
            />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="block truncate text-[10px] font-medium text-[#111827]" style={MONO}>{s.display_name}</span>
                {!active && (
                  <span className="border border-[#fcd34d] bg-[#fffbeb] px-1 py-[1px] text-[8px] font-semibold uppercase text-[#92400e]" style={MONO}>
                    {s.configured ? "disabled" : "not configured"}
                  </span>
                )}
                {active && s.auth_status === "o_auth" && (
                  <span className="border border-[#c4b5fd] bg-[#f5f3ff] px-1 py-[1px] text-[8px] font-semibold uppercase text-[#5b21b6]" style={MONO}>
                    oauth
                  </span>
                )}
              </span>
              <span className="line-clamp-1 text-[9px] text-[#9ca3af]" style={MONO}>{s.description}</span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

function SkillChecklist({
  skills,
  selected,
  onChange,
}: {
  skills: Skill[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...selected, id] : selected.filter((s) => s !== id));

  if (!skills.length) {
    return (
      <p className="py-2 text-[10px] text-[#9ca3af]" style={MONO}>
        No skills saved. Add them in Skills.
      </p>
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto border border-[#e5e7eb]">
      {skills.map((skill) => (
        <label
          key={skill.id}
          className="flex cursor-pointer items-start gap-2 border-b border-[#f3f4f6] px-3 py-2 last:border-b-0 hover:bg-[#f9fafb]"
        >
          <input
            type="checkbox"
            className="mt-0.5 h-3 w-3"
            checked={selected.includes(skill.id)}
            onChange={(e) => toggle(skill.id, e.target.checked)}
          />
          <span className="min-w-0">
            <span className="block truncate text-[10px] font-medium text-[#111827]" style={MONO}>{skill.name}</span>
            <span className="line-clamp-1 text-[9px] text-[#9ca3af]" style={MONO}>{skill.description}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

type NodeData = Record<string, unknown>;

function patchNode(node: Node, patch: Partial<NodeData>): Node {
  return { ...node, data: { ...node.data, ...patch } };
}

export function AgentInspector({
  node,
  onChange,
  mcpServers = [],
  skills = [],
  onPlanWorkflow,
  planPending = false,
  hasGeneratedPlan = false,
  onTuneNode,
  tunePending = false,
}: {
  node: Node | null;
  onChange: (updated: Node) => void;
  mcpServers?: McpServer[];
  skills?: Skill[];
  onPlanWorkflow?: (node: Node, feedback?: string) => void;
  planPending?: boolean;
  hasGeneratedPlan?: boolean;
  onTuneNode?: (node: Node, instruction: string) => void;
  tunePending?: boolean;
}) {
  const [planFeedback, setPlanFeedback] = useState("");
  const [tuneInstruction, setTuneInstruction] = useState("");
  if (!node) {
    return (
      <div className="flex h-48 items-center justify-center border border-[#e5e7eb]">
        <p className="text-[11px] text-[#9ca3af]" style={MONO}>Select a node to inspect</p>
      </div>
    );
  }

  const d = node.data as NodeData;
  const isApproval = node.type === "humanApproval";
  const isMemory = node.type === "memory";
  const isSupervisor = node.type === "supervisorAgent";
  const isAgent = !isApproval && !isMemory;

  const patch = (partial: Partial<NodeData>) => onChange(patchNode(node, partial));

  // per-node tool/skill selections stored as string arrays in node data
  const selectedTools = Array.isArray(d.selectedTools) ? (d.selectedTools as string[]) : [];
  const selectedSkills = Array.isArray(d.selectedSkills) ? (d.selectedSkills as string[]) : [];

  return (
    <div className="border border-[#e5e7eb] bg-white" style={MONO}>
      {/* header */}
      <div className="flex items-center justify-between border-b border-[#e5e7eb] px-4 py-2.5">
        <div>
          <p className="text-[9px] font-semibold uppercase tracking-widest text-[#9ca3af]">
            {node.type === "supervisorAgent" ? "Supervisor" : node.type === "specialistAgent" ? "Specialist" : node.type === "humanApproval" ? "Approval gate" : "Memory"}
            {" · node config"}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-[#111827]">{String(d.label ?? node.id)}</p>
        </div>
        <span className="border border-[#e5e7eb] px-1.5 py-[2px] text-[9px] text-[#6b7280]">{node.id}</span>
      </div>

      <div className="space-y-3 p-4">

        {/* ── identity ── */}
        <SectionHeader>Identity</SectionHeader>
        <Field label="Label">
          <TextInput value={String(d.label ?? "")} onChange={(v) => patch({ label: v })} placeholder="Node label" />
        </Field>

        {isAgent && (
          <>
            <Field label="Role">
              <TextInput value={String(d.role ?? "")} onChange={(v) => patch({ role: v })} placeholder="Agent role" />
            </Field>
            <Field label="Objective">
              <TextArea value={String(d.objective ?? "")} onChange={(v) => patch({ objective: v })} rows={2} />
            </Field>
            <Field label="System instructions">
              <TextArea value={String(d.systemInstructions ?? "")} onChange={(v) => patch({ systemInstructions: v })} rows={3} />
            </Field>
          </>
        )}

        {/* ── runtime ── */}
        {isAgent && (
          <>
            <SectionHeader>Runtime</SectionHeader>
            <Field label="Execution mode">
              <SelectField
                value={String(d.runtime ?? "sandbox")}
                onChange={(v) => patch({ runtime: v })}
                options={[
                  { value: "sandbox", label: "Docker Sandbox (isolated microVM)" },
                  { value: "direct",  label: "Direct CLI (fast, runs on host)" },
                ]}
              />
              {(d.runtime ?? "sandbox") === "direct" && (
                <p className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[9px] font-semibold text-amber-700" style={MONO}>
                  No isolation — runs as host user. Safe for read-only tasks.
                </p>
              )}
            </Field>
            {(d.runtime ?? "sandbox") === "sandbox" && (
              <Field label="Sandbox agent">
                <SelectField
                  value={String(d.sandboxAgent ?? "codex")}
                  onChange={(v) => patch({ sandboxAgent: v })}
                  options={[
                    { value: "codex",  label: "Codex" },
                    { value: "claude", label: "Claude Code" },
                    { value: "cursor", label: "Cursor" },
                  ]}
                />
              </Field>
            )}
            <Field label="Model">
              <TextInput value={String(d.model ?? "codex-cli")} onChange={(v) => patch({ model: v })} placeholder="codex-cli" />
            </Field>
            <Field label="Memory scope">
              <SelectField
                value={String(d.memoryScope ?? "workflow")}
                onChange={(v) => patch({ memoryScope: v })}
                options={[
                  { value: "workflow", label: "workflow — shared across run" },
                  { value: "team", label: "team — shared with supervisor" },
                  { value: "agent_private", label: "agent_private — scratchpad only" },
                ]}
              />
            </Field>
            <Field label="Max iterations">
              <NumericField value={Number(d.maxIterations ?? 3)} onChange={(v) => patch({ maxIterations: v })} min={1} max={20} />
            </Field>
            <Field label="Approval required">
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id={`approval-${node.id}`}
                  checked={Boolean(d.requiresApproval)}
                  onChange={(e) => patch({ requiresApproval: e.target.checked })}
                  className="h-3 w-3"
                />
                <label htmlFor={`approval-${node.id}`} className="text-[11px] text-[#374151]">
                  Pause before executing
                </label>
              </div>
            </Field>
          </>
        )}

        {isSupervisor && (
          <Field label="Delegation strategy">
            <SelectField
              value={String(d.delegationStrategy ?? "sequential_delegation") === "parallel_delegation_later" ? "parallel_delegation" : String(d.delegationStrategy ?? "sequential_delegation")}
              onChange={(v) => patch({ delegationStrategy: v })}
              options={[
                { value: "sequential_delegation", label: "Sequential delegation" },
                { value: "parallel_delegation", label: "Parallel delegation" },
                { value: "review_and_revise_later", label: "Review-and-revise (planned)" },
              ]}
            />
          </Field>
        )}

        {/* ── smart planning (supervisor only) ── */}
        {isSupervisor && onPlanWorkflow && (
          <>
            <SectionHeader>Smart planning</SectionHeader>
            <button
              onClick={() => onPlanWorkflow(node)}
              disabled={planPending || !String(d.objective ?? "").trim()}
              className="flex w-full items-center justify-center gap-1.5 border border-[#0f1117] bg-[#0f1117] px-3 py-2 text-[11px] font-medium text-white hover:bg-[#1f2937] disabled:cursor-not-allowed disabled:opacity-40"
              style={MONO}
              title={!String(d.objective ?? "").trim() ? "Set an objective first" : undefined}
            >
              {planPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {planPending ? "Planning… (can take 1–3 min)" : hasGeneratedPlan ? "Re-plan workflow" : "Plan workflow"}
            </button>
            <p className="text-[9px] leading-relaxed text-[#9ca3af]" style={MONO}>
              Breaks the objective into specialist sub-agents and adds them to the canvas. Review and edit before running.
            </p>
            {hasGeneratedPlan && (
              <Field label="Refine plan with feedback">
                <TextArea value={planFeedback} onChange={setPlanFeedback} rows={2} />
                <button
                  onClick={() => { onPlanWorkflow(node, planFeedback); setPlanFeedback(""); }}
                  disabled={planPending || !planFeedback.trim()}
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 border border-[#d1d5db] bg-white px-3 py-1.5 text-[11px] font-medium text-[#374151] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
                  style={MONO}
                >
                  {planPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Refine plan
                </button>
                <p className="mt-1.5 text-[9px] text-[#9ca3af]" style={MONO}>
                  e.g. "merge the two audit tasks" or "add a test-writer step". Replaces the generated agents.
                </p>
              </Field>
            )}
          </>
        )}

        {/* ── prompt tuning for generated nodes ── */}
        {isAgent && !isSupervisor && Boolean(d.generatedBy) && onTuneNode && (
          <>
            <SectionHeader>Tune with prompt</SectionHeader>
            <Field label="Instruction">
              <TextArea value={tuneInstruction} onChange={setTuneInstruction} rows={2} />
              <button
                onClick={() => { onTuneNode(node, tuneInstruction); setTuneInstruction(""); }}
                disabled={tunePending || !tuneInstruction.trim()}
                className="mt-1.5 flex w-full items-center justify-center gap-1.5 border border-[#d1d5db] bg-white px-3 py-1.5 text-[11px] font-medium text-[#374151] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
                style={MONO}
              >
                {tunePending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {tunePending ? "Tuning…" : "Tune node"}
              </button>
              <p className="mt-1.5 text-[9px] text-[#9ca3af]" style={MONO}>
                e.g. "focus this reviewer on the auth module only". Updates this node's label, role, objective, and instructions.
              </p>
            </Field>
          </>
        )}

        {/* ── MCP tools ── */}
        {isAgent && (
          <>
            <SectionHeader>
              MCP Tools
              <span className="ml-2 border border-[#e5e7eb] px-1.5 py-[1px] text-[9px] text-[#9ca3af]">
                {selectedTools.length} selected
              </span>
            </SectionHeader>
            <McpChecklist
              servers={mcpServers}
              selected={selectedTools}
              onChange={(ids) => patch({ selectedTools: ids, tools: ids.length })}
            />
          </>
        )}

        {/* ── skills ── */}
        {isAgent && (
          <>
            <SectionHeader>
              Skills
              <span className="ml-2 border border-[#e5e7eb] px-1.5 py-[1px] text-[9px] text-[#9ca3af]">
                {selectedSkills.length} selected
              </span>
            </SectionHeader>
            <SkillChecklist
              skills={skills}
              selected={selectedSkills}
              onChange={(ids) => patch({ selectedSkills: ids, skills: ids.length })}
            />
          </>
        )}

        {/* ── approval gate fields ── */}
        {isApproval && (
          <>
            <SectionHeader>Gate config</SectionHeader>
            <Field label="Approval reason">
              <TextArea value={String(d.reason ?? "")} onChange={(v) => patch({ reason: v })} rows={3} />
            </Field>
            <Field label="Approval timeout">
              <TextInput
                value={String(d.timeoutHours ?? 24)}
                onChange={(v) => {
                  const parsed = Number.parseInt(v, 10);
                  patch({ timeoutHours: Number.isFinite(parsed) ? Math.max(1, Math.min(720, parsed)) : 24 });
                }}
                placeholder="24"
              />
              <p className="mt-1.5 text-[9px] text-[#9ca3af]" style={MONO}>
                Hours before the pending approval is cancelled. Default is 24.
              </p>
            </Field>
            <Field label="Allowed actions">
              <p className="mb-1.5 text-[9px] text-[#9ca3af]" style={MONO}>Which actions the reviewer can take</p>
              {(["approve", "reject", "request_revision"] as const).map((action) => {
                const current: string[] = Array.isArray(d.allowedActions) ? d.allowedActions as string[] : ["approve", "reject", "request_revision"];
                const checked = current.includes(action);
                const label = action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Request revision";
                return (
                  <label key={action} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5, cursor: "pointer" }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked ? current.filter((a) => a !== action) : [...current, action];
                        patch({ allowedActions: next.length ? next : current }); // always keep at least one
                      }}
                      style={{ accentColor: "#d97706" }}
                    />
                    <span className="text-[11px] text-[#374151]" style={MONO}>{label}</span>
                  </label>
                );
              })}
            </Field>
            <Field label="Note from reviewer">
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={Boolean(d.noteRequired)}
                  onChange={() => patch({ noteRequired: !d.noteRequired })}
                  style={{ accentColor: "#d97706" }}
                />
                <span className="text-[11px] text-[#374151]" style={MONO}>Require a note before submitting</span>
              </label>
            </Field>
          </>
        )}

        {/* ── memory node fields ── */}
        {isMemory && (
          <>
            <SectionHeader>Memory config</SectionHeader>
            <Field label="Memory scope">
              <SelectField
                value={String(d.scope ?? "workflow")}
                onChange={(v) => patch({ scope: v })}
                options={[
                  { value: "workflow", label: "workflow" },
                  { value: "team", label: "team" },
                  { value: "agent_private", label: "agent_private" },
                ]}
              />
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
