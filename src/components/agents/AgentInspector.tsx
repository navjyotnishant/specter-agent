import { useLayoutEffect, useRef, useState } from "react";
import type { Node } from "@xyflow/react";
import { Loader2, Sparkles } from "lucide-react";
import { ModelPicker } from "@/components/agents/ModelPicker";
import { TelegramConfigForm } from "@/components/agents/TelegramConfigForm";
import type { McpServer, Skill } from "@/lib/types";


function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-widest text-[#6b7280] first:mt-0">
      {children}
    </p>
  );
}

function Field({ label, required, empty, children }: { label: string; required?: boolean; empty?: boolean; children: React.ReactNode }) {
  return (
    <div className="border-b border-[#f3f4f6] pb-3 last:border-b-0 last:pb-0">
      <p className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af]">
        {label}
        {required && <span className={required && empty ? "text-red-500" : "text-red-400"} title="Required">*</span>}
      </p>
      {children}
      {required && empty && (
        <p className="mt-1 text-[10px] font-medium text-red-500">Required.</p>
      )}
    </div>
  );
}

function TextInput({ value, onChange, placeholder, error }: { value: string; onChange: (v: string) => void; placeholder?: string; error?: boolean }) {
  return (
    <input
      className={`w-full border bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151] ${error ? "border-red-300" : "border-[#e5e7eb]"}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function TextArea({ value, onChange, rows = 3, placeholder, error }: { value: string; onChange: (v: string) => void; rows?: number; placeholder?: string; error?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // auto-grow with the content (capped) — keyed on value so programmatic
  // writes (e.g. planner tune-node) resize too, not just keystrokes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={`w-full resize-none overflow-y-auto border bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151] placeholder:text-[#c7ccd4] ${error ? "border-red-300" : "border-[#e5e7eb]"}`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
    />
  );
}

function SelectField({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return (
    <select
      className="w-full border border-[#e5e7eb] bg-white px-2.5 py-1.5 text-[11px] text-[#111827] outline-none focus:border-[#374151]"
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
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

function McpList({ servers }: { servers: McpServer[] }) {
  if (!servers.length) {
    return (
      <p className="py-2 text-[10px] text-[#9ca3af]">
        No MCP servers configured. Add them in Connectors.
      </p>
    );
  }

  return (
    <div className="max-h-40 overflow-y-auto border border-[#e5e7eb]">
      {servers.map((s) => {
        const active = s.configured && s.enabled;
        return (
          <div
            key={s.name}
            className={`flex items-start gap-2 border-b border-[#f3f4f6] px-3 py-2 last:border-b-0 ${active ? "" : "opacity-50"}`}
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="block truncate text-[10px] font-medium text-[#111827]">{s.display_name}</span>
                {!active && (
                  <span className="border border-[#fcd34d] bg-[#fffbeb] px-1 py-[1px] text-[8px] font-semibold uppercase text-[#92400e]">
                    {s.configured ? "disabled" : "not configured"}
                  </span>
                )}
                {active && s.auth_status === "o_auth" && (
                  <span className="border border-[#c4b5fd] bg-[#f5f3ff] px-1 py-[1px] text-[8px] font-semibold uppercase text-[#5b21b6]">
                    oauth
                  </span>
                )}
              </span>
              <span className="line-clamp-1 text-[10px] text-[#9ca3af]">{s.description}</span>
            </span>
          </div>
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
      <p className="py-2 text-[10px] text-[#9ca3af]">
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
            <span className="block truncate text-[10px] font-medium text-[#111827]">{skill.name}</span>
            <span className="line-clamp-1 text-[10px] text-[#9ca3af]">{skill.description}</span>
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
  planError = null,
}: {
  node: Node | null;
  onChange: (updated: Node) => void;
  mcpServers?: McpServer[];
  skills?: Skill[];
  onPlanWorkflow?: (node: Node, feedback?: string) => void;
  planPending?: boolean;
  hasGeneratedPlan?: boolean;
  onTuneNode?: (node: Node, instruction: string) => void;
  planError?: string | null;
  tunePending?: boolean;
}) {
  const [planFeedback, setPlanFeedback] = useState("");
  const [idCopied, setIdCopied] = useState(false);
  const [tuneInstruction, setTuneInstruction] = useState("");
  if (!node) {
    return (
      <div className="flex h-48 items-center justify-center border border-[#e5e7eb]">
        <p className="text-[11px] text-[#9ca3af]">Select a node to inspect</p>
      </div>
    );
  }

  const d = node.data as NodeData;
  const isTrigger = node.type === "trigger";
  const isApproval = node.type === "humanApproval";
  const isMemory = node.type === "memory";
  const isConditional = node.type === "conditional";
  const isWebhook = node.type === "webhook";
  const isSupervisor = node.type === "supervisorAgent";
  const isAgent = node.type === "supervisorAgent" || node.type === "specialistAgent";

  const patch = (partial: Partial<NodeData>) => onChange(patchNode(node, partial));

  // per-node skill selection stored as a string array in node data
  const selectedSkills = Array.isArray(d.selectedSkills) ? (d.selectedSkills as string[]) : [];

  return (
    <div className="border border-[#e5e7eb] bg-white">
      {/* header */}
      <div className="flex items-center justify-between border-b border-[#e5e7eb] px-4 py-2.5">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[#9ca3af]">
            {node.type === "supervisorAgent" ? "Supervisor"
              : node.type === "specialistAgent" ? "Specialist"
              : node.type === "humanApproval" ? "Approval gate"
              : node.type === "conditional" ? "Conditional"
              : node.type === "webhook" ? "Webhook"
              : "Memory"}
            {" · node config"}
          </p>
          <p className="mt-0.5 text-[12px] font-semibold text-[#111827]">{String(d.label ?? node.id)}</p>
        </div>
        <button
          onClick={() => { navigator.clipboard.writeText(node.id).catch(() => {}); setIdCopied(true); setTimeout(() => setIdCopied(false), 1200); }}
          title="Copy node id"
          className="border border-transparent px-1.5 py-[2px] font-mono text-[10px] text-[#b6bcc6] hover:border-[#e5e7eb] hover:text-[#6b7280]"
        >
          {idCopied ? "copied" : node.id}
        </button>
      </div>

      <div className="space-y-3 p-4">

        {/* ── identity ── */}
        <SectionHeader>Identity</SectionHeader>
        <Field label="Label" required empty={!String(d.label ?? "").trim()}>
          <TextInput value={String(d.label ?? "")} onChange={(v) => patch({ label: v })} placeholder="Node label" error={!String(d.label ?? "").trim()} />
        </Field>

        {isAgent && (
          <>
            <Field label="Role">
              <TextInput value={String(d.role ?? "")} onChange={(v) => patch({ role: v })} placeholder="e.g. Secure code review" />
            </Field>
            <Field label="Objective" required empty={!String(d.objective ?? "").trim()}>
              <TextArea
                value={String(d.objective ?? "")}
                onChange={(v) => patch({ objective: v })}
                rows={2}
                placeholder="The task for this run, e.g. &quot;Review the auth middleware for injection and access-control flaws.&quot;"
                error={!String(d.objective ?? "").trim()}
              />
              {String(d.objective ?? "").trim() && (
                <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                  What this agent should do this run.
                </p>
              )}
            </Field>

            <SectionHeader>
              Skills
              <span className="ml-2 border border-[#e5e7eb] px-1.5 py-[1px] text-[10px] text-[#9ca3af]">
                {selectedSkills.length} selected
              </span>
            </SectionHeader>
            <SkillChecklist
              skills={skills}
              selected={selectedSkills}
              onChange={(ids) => patch({ selectedSkills: ids })}
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-[#9ca3af]">
              Reusable prompt fragments, applied before System instructions below. Prefer a
              Skill for guidance you'll reuse across nodes or workflows.
            </p>

            <Field label="System instructions">
              <TextArea
                value={String(d.systemInstructions ?? "")}
                onChange={(v) => patch({ systemInstructions: v })}
                rows={3}
                placeholder="One-off behavioral constraints for this node, e.g. &quot;Only look at files under /api/auth. Do not modify code, only report findings.&quot;"
              />
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                {selectedSkills.length > 0
                  ? `${selectedSkills.length} skill${selectedSkills.length === 1 ? "" : "s"} attached — its instructions are included automatically. Add anything extra here.`
                  : "How this agent should behave, scoped or constrained beyond the objective."}
              </p>
            </Field>
          </>
        )}

        {/* ── trigger node fields ── */}
        {isTrigger && (
          <>
            <SectionHeader>Trigger</SectionHeader>
            <Field label="Source">
              <SelectField
                value={String(d.source ?? "manual")}
                onChange={(v) => patch({ source: v })}
                options={[
                  { value: "manual", label: "Manual — entered when you click Run" },
                  { value: "telegram", label: "Telegram — an allowlisted chat message" },
                ]}
              />
              {String(d.source) === "telegram" && <TelegramConfigForm />}
            </Field>
            <Field label="Prompt shown at run time" required empty={!String(d.label ?? "").trim()}>
              <TextInput value={String(d.label ?? "")} onChange={(v) => patch({ label: v })} placeholder="Topic" />
            </Field>
            <Field label="Field name" required empty={!String(d.fieldName ?? "").trim()}>
              <TextInput
                value={String(d.fieldName ?? "")}
                onChange={(v) => patch({ fieldName: v.replace(/[^a-zA-Z0-9_]/g, "_") })}
                placeholder="topic"
              />
              <p className="mt-1 text-[10px] text-[#9ca3af]">
                Identifies this value when the run is started.
              </p>
            </Field>
            <Field label="Placeholder">
              <TextInput
                value={String(d.placeholder ?? "")}
                onChange={(v) => patch({ placeholder: v })}
                placeholder="What should this workflow work on?"
              />
            </Field>
            <Field label="Required">
              <SelectField
                value={d.required === false ? "no" : "yes"}
                onChange={(v) => patch({ required: v === "yes" })}
                options={[{ value: "yes", label: "Required" }, { value: "no", label: "Optional" }]}
              />
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
                <p className="mt-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] font-semibold text-amber-700">
                  No isolation — runs as host user. Safe for read-only tasks.
                </p>
              )}
            </Field>
            <Field label="Agent">
              <SelectField
                value={String(d.sandboxAgent ?? "codex")}
                onChange={(v) => patch({ sandboxAgent: v, model: "" })}
                options={[
                  { value: "codex",  label: "Codex" },
                  { value: "claude", label: "Claude Code" },
                  { value: "cursor", label: "Cursor" },
                ]}
              />
            </Field>
            <Field label="Model">
              <ModelPicker
                agent={String(d.sandboxAgent ?? "codex")}
                value={String(d.model ?? "")}
                onChange={(v) => patch({ model: v })}
              />
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
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                After this node finishes, its output is saved to memory at this scope and
                surfaced to later nodes that share it (workflow = whole run, team = supervisor
                + specialists, agent_private = only this node's own future runs).
              </p>
            </Field>
            <Field label="Max iterations">
              <NumericField value={Number(d.maxIterations ?? 1)} onChange={(v) => patch({ maxIterations: v })} min={1} max={20} />
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                Retry attempts if the agent call fails or times out. 1 = no retry.
              </p>
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
             
              title={!String(d.objective ?? "").trim() ? "Set an objective first" : undefined}
            >
              {planPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
              {planPending ? "Planning… (can take 1–3 min)" : hasGeneratedPlan ? "Re-plan workflow" : "Plan workflow"}
            </button>
            <p className="text-[10px] leading-relaxed text-[#9ca3af]">
              Breaks the objective into specialist sub-agents and adds them to the canvas. Review and edit before running.
            </p>
            {!planPending && planError && (
              <p className="border border-[#fecaca] bg-[#fef2f2] px-2 py-1.5 text-[10px] leading-relaxed text-[#b91c1c]">
                {planError}
              </p>
            )}
            {hasGeneratedPlan && (
              <Field label="Refine plan with feedback">
                <TextArea value={planFeedback} onChange={setPlanFeedback} rows={2} />
                <button
                  onClick={() => { onPlanWorkflow(node, planFeedback); setPlanFeedback(""); }}
                  disabled={planPending || !planFeedback.trim()}
                  className="mt-1.5 flex w-full items-center justify-center gap-1.5 border border-[#d1d5db] bg-white px-3 py-1.5 text-[11px] font-medium text-[#374151] hover:bg-[#f9fafb] disabled:cursor-not-allowed disabled:opacity-40"
                 
                >
                  {planPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                  Refine plan
                </button>
                <p className="mt-1.5 text-[10px] text-[#9ca3af]">
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
               
              >
                {tunePending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
                {tunePending ? "Tuning…" : "Tune node"}
              </button>
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                e.g. "focus this reviewer on the auth module only". Updates this node's label, role, objective, and instructions.
              </p>
            </Field>
          </>
        )}

        {/* ── MCP tools (read-only: configured per-CLI, not per-node) ── */}
        {isAgent && (
          <>
            <SectionHeader>
              MCP Tools
              <span className="ml-2 border border-[#e5e7eb] px-1.5 py-[1px] text-[10px] text-[#9ca3af]">
                {mcpServers.filter((s) => s.configured && s.enabled).length} available
              </span>
            </SectionHeader>
            <McpList servers={mcpServers} />
            <p className="mt-1.5 text-[10px] leading-relaxed text-[#9ca3af]">
              MCP servers are configured globally per agent CLI, not per node — every node
              using the same agent shares this list. Manage servers in Connectors.
            </p>
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
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                Hours before the pending approval is cancelled. Default is 24.
              </p>
            </Field>
            <Field label="Allowed actions">
              <p className="mb-1.5 text-[10px] text-[#9ca3af]">Which actions the reviewer can take</p>
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
                    <span className="text-[11px] text-[#374151]">{label}</span>
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
                <span className="text-[11px] text-[#374151]">Require a note before submitting</span>
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

        {/* ── conditional node fields ── */}
        {isConditional && (
          <>
            <SectionHeader>Condition</SectionHeader>
            <Field label="Question" required empty={!String(d.condition ?? "").trim()}>
              <TextArea
                value={String(d.condition ?? "")}
                onChange={(v) => patch({ condition: v })}
                rows={2}
                placeholder="A yes/no question about prior output, e.g. &quot;Did the code review find any CRITICAL or HIGH severity issues?&quot;"
                error={!String(d.condition ?? "").trim()}
              />
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                Answered YES/NO by the agent below, based on prior steps' output and memory.
                Connect the canvas card's two outputs (top = true, bottom = false) to different
                downstream nodes to branch the workflow.
              </p>
            </Field>

            <SectionHeader>Evaluator</SectionHeader>
            <Field label="Execution mode">
              <SelectField
                value={String(d.runtime ?? "sandbox")}
                onChange={(v) => patch({ runtime: v })}
                options={[
                  { value: "sandbox", label: "Docker Sandbox (isolated microVM)" },
                  { value: "direct",  label: "Direct CLI (fast, runs on host)" },
                ]}
              />
            </Field>
            <Field label="Agent">
              <SelectField
                value={String(d.sandboxAgent ?? "codex")}
                onChange={(v) => patch({ sandboxAgent: v, model: "" })}
                options={[
                  { value: "codex",  label: "Codex" },
                  { value: "claude", label: "Claude Code" },
                  { value: "cursor", label: "Cursor" },
                ]}
              />
            </Field>
            <Field label="Model">
              <ModelPicker
                agent={String(d.sandboxAgent ?? "codex")}
                value={String(d.model ?? "")}
                onChange={(v) => patch({ model: v })}
              />
            </Field>
          </>
        )}

        {/* ── webhook node fields ── */}
        {isWebhook && (
          <>
            <SectionHeader>Webhook</SectionHeader>
            <Field label="URL" required empty={!String(d.url ?? "").trim()}>
              <TextInput
                value={String(d.url ?? "")}
                onChange={(v) => patch({ url: v })}
                placeholder="https://hooks.example.com/workflow-notify"
                error={!String(d.url ?? "").trim()}
              />
            </Field>
            <Field label="Method">
              <SelectField
                value={String(d.method ?? "POST")}
                onChange={(v) => patch({ method: v })}
                options={[
                  { value: "POST", label: "POST" },
                  { value: "PUT", label: "PUT" },
                ]}
              />
            </Field>
            <Field label="Payload template">
              <TextArea
                value={String(d.payloadTemplate ?? "")}
                onChange={(v) => patch({ payloadTemplate: v })}
                rows={3}
                placeholder={'{ "text": "Workflow update: {{context}}" }'}
              />
              <p className="mt-1.5 text-[10px] text-[#9ca3af]">
                {'{{context}}'} is replaced with the accumulated output from prior steps. Leave
                blank to send a default JSON payload with the run id and context.
              </p>
            </Field>
          </>
        )}
      </div>
    </div>
  );
}
