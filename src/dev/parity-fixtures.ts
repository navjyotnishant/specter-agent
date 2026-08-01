// Author: Navjyot Nishant
// Created: 2026-08-01
// Last updated: 2026-08-01
// Description: Deterministic fixture data for the design-parity harness.
//
// These exist so a page can be rendered and measured without a backend, a
// session, or a login — which is what lets /claude-design-pull run in CI.
//
// The values mirror the mockups' own sample data on purpose: the gate ignores
// content, but matching it keeps a side-by-side screenshot readable by a human
// who is comparing the two.

import type {
  AuthUser, RuntimeWorkspace, Skill, Workflow, WorkflowRun,
} from "@/lib/types";

const NODES = [
  { id: "a", type: "supervisorAgent", position: { x: 0, y: 0 }, data: {} },
  { id: "b", type: "specialistAgent", position: { x: 220, y: 0 }, data: {} },
];
const EDGES = [{ id: "a-b", source: "a", target: "b" }];
const graph = () => ({ nodes: [...NODES], edges: [...EDGES] });

// Fixed instants, not Date.now(). A relative timestamp that drifts between the
// mockup render and the live render shows up as a spurious content difference
// and, worse, makes the run unreproducible.
const T = (iso: string) => iso;

export const WORKFLOWS: Workflow[] = [
  {
    id: "wf-blog", name: "blog_post",
    description: "Research, draft, fact-check and publish",
    workspace_path: "~/Desktop/github/ToolTropolis/nj-agents",
    graph: graph(), is_template: false,
    created_at: T("2026-07-01 09:00:00"), updated_at: T("2026-08-01 09:48:00"),
  },
  {
    id: "wf-prepush", name: "pre-push-review",
    description: "Secrets, correctness, tests, deps, style",
    workspace_path: "~/Desktop/github/navjyotnishant/specter-agent",
    graph: graph(), is_template: false,
    created_at: T("2026-07-02 09:00:00"), updated_at: T("2026-08-01 09:59:00"),
  },
  {
    id: "wf-changelog", name: "changelog",
    description: "Keep a Changelog entries from commits",
    workspace_path: "~/Desktop/github/navjyotnishant/specter-agent",
    graph: graph(), is_template: false,
    created_at: T("2026-07-03 09:00:00"), updated_at: T("2026-08-01 08:00:00"),
  },
  {
    // No workspace_path: drives the "Run disabled, no repo set" state the
    // mockup specifies.
    id: "wf-arch", name: "arch-diagram",
    description: "Presentation-quality SVG from the repo",
    graph: graph(), is_template: false,
    created_at: T("2026-07-04 09:00:00"), updated_at: T("2026-07-04 09:00:00"),
  },
];

// Five runs per workflow so the last-5 sparkline has a full bar set, with a
// mixed pass/fail history — a uniformly green fixture would hide a sparkline
// that renders only one colour.
const run = (
  id: string, workflow_id: string, status: WorkflowRun["status"],
  created_at: string, completed_at: string | null,
): WorkflowRun => ({
  id, workflow_id, status, trigger_type: "manual", created_at, completed_at,
});

export const RUNS: WorkflowRun[] = [
  run("r1", "wf-blog", "completed", T("2026-08-01 06:00:00"), T("2026-08-01 06:01:30")),
  run("r2", "wf-blog", "completed", T("2026-08-01 07:00:00"), T("2026-08-01 07:01:10")),
  run("r3", "wf-blog", "failed",    T("2026-08-01 08:00:00"), T("2026-08-01 08:02:20")),
  run("r4", "wf-blog", "completed", T("2026-08-01 09:00:00"), T("2026-08-01 09:01:05")),
  run("r5", "wf-blog", "failed",    T("2026-08-01 09:46:00"), T("2026-08-01 09:48:14")),

  run("r6",  "wf-prepush", "completed", T("2026-08-01 05:00:00"), T("2026-08-01 05:01:00")),
  run("r7",  "wf-prepush", "completed", T("2026-08-01 06:00:00"), T("2026-08-01 06:01:12")),
  run("r8",  "wf-prepush", "completed", T("2026-08-01 07:00:00"), T("2026-08-01 07:00:54")),
  run("r9",  "wf-prepush", "completed", T("2026-08-01 08:00:00"), T("2026-08-01 08:01:03")),
  run("r10", "wf-prepush", "running",   T("2026-08-01 09:59:00"), null),

  run("r11", "wf-changelog", "completed", T("2026-08-01 04:00:00"), T("2026-08-01 04:00:41")),
  run("r12", "wf-changelog", "completed", T("2026-08-01 05:00:00"), T("2026-08-01 05:00:45")),
  run("r13", "wf-changelog", "completed", T("2026-08-01 06:00:00"), T("2026-08-01 06:00:39")),
  run("r14", "wf-changelog", "completed", T("2026-08-01 07:00:00"), T("2026-08-01 07:00:44")),
  run("r15", "wf-changelog", "completed", T("2026-08-01 08:00:00"), T("2026-08-01 08:00:41")),
];

export const SKILLS: Skill[] = [
  { id: "standard-report-format", name: "standard-report-format", description: "Consistent headings and a summary block",
    prompt_template: "Use the standard report format.", compatible_agent_roles: "[]",
    created_at: T("2026-06-19 09:00:00") },
  { id: "secure-code-review", name: "secure-code-review", description: "Injection, authz, secrets, unsafe deserialization",
    prompt_template: "Review only the changed lines and their blast radius.",
    compatible_agent_roles: JSON.stringify(["reviewer", "specialist"]),
    created_at: T("2026-06-19 09:00:00") },
  { id: "pr-readiness-review", name: "pr-readiness-review", description: "Is this branch ready to open as a PR",
    prompt_template: "Assess PR readiness.", compatible_agent_roles: "[]",
    created_at: T("2026-06-19 09:00:00") },

  { id: "sk-4", name: "tech-blog", description: "Writer → fact-checker → reviewer → editor",
    prompt_template: "Draft a technical blog post.", compatible_agent_roles: "[]",
    source_repo: "nj-agents", created_at: T("2026-07-10 09:00:00") },
  { id: "sk-5", name: "changelog", description: "Keep a Changelog entries from commit history",
    prompt_template: "Generate changelog entries.", compatible_agent_roles: "[]",
    source_repo: "nj-agents", created_at: T("2026-07-10 09:00:00") },
  { id: "sk-6", name: "arch-diagram", description: "Presentation-quality SVG into docs/architecture",
    prompt_template: "Author an architecture diagram.", compatible_agent_roles: "[]",
    source_repo: "nj-agents", created_at: T("2026-07-10 09:00:00") },

  { id: "sk-7", name: "house-style", description: "Tone and formatting rules for all output",
    prompt_template: "Apply house style.", compatible_agent_roles: "[]",
    created_at: T("2026-07-20 09:00:00") },
];

export const USERS: AuthUser[] = [
  { id: "u-1", email: "admin@local.dev", role: "admin",    created_at: T("2026-06-19 09:00:00") },
  { id: "u-2", email: "ops@local.dev",   role: "operator", created_at: T("2026-07-04 09:00:00") },
];

export const WORKSPACES: RuntimeWorkspace[] = [
  { id: "ws-1", name: "specter-agent", path: "~/Desktop/github/navjyotnishant/specter-agent",
    is_active: true, created_at: T("2026-06-19 09:00:00"), updated_at: T("2026-06-19 09:00:00") },
  { id: "ws-2", name: "nj-agents", path: "~/Desktop/github/ToolTropolis/nj-agents",
    is_active: false, created_at: T("2026-06-20 09:00:00"), updated_at: T("2026-06-20 09:00:00") },
];

/** The workflow the builder harness route opens. Exported so the route, the
 *  fixture, and the cache key cannot drift apart. */
export const FIXTURE_WORKFLOW_ID = "wf-prepush";

/** A graph with enough shape to exercise the builder's own vocabulary: more
 *  than one node type, a connection between them, and a selected node — an
 *  empty canvas would measure as a page missing every node element. */
const BUILDER_GRAPH = {
  nodes: [
    { id: "n1", type: "supervisorAgent", position: { x: 40, y: 80 },
      data: { label: "Planner", role: "supervisor", objective: "Break the task down", model: "claude-opus-5",
              systemInstructions: "", selectedSkills: [], selectedTools: [] } },
    { id: "n2", type: "specialistAgent", position: { x: 320, y: 40 },
      data: { label: "Reviewer", role: "reviewer", objective: "Review the diff", model: "claude-sonnet-5",
              systemInstructions: "", selectedSkills: ["secure-code-review"], selectedTools: [] } },
    { id: "n3", type: "humanApproval", position: { x: 320, y: 190 },
      data: { label: "Approve", instructions: "Approve before publishing" } },
  ],
  edges: [
    { id: "e1", source: "n1", target: "n2" },
    { id: "e2", source: "n2", target: "n3" },
  ],
};

/** Every query key the gated pages read, mapped to fixture data.
 *
 *  Seeded into the QueryClient cache so each `useQuery` resolves from cache and
 *  never calls its queryFn — no network, no token, no ProtectedRoute. */
export const SEED: Array<[readonly unknown[], unknown]> = [
  [["workflows"], WORKFLOWS],
  [["all-runs"], RUNS],
  [["skills"], SKILLS],
  [["users"], USERS],
  [["workspaces"], WORKSPACES],
  [["runtime-workspaces"], WORKSPACES],
  [["mcp-list"], []],
  [["workflow", FIXTURE_WORKFLOW_ID],
   { ...WORKFLOWS.find((w) => w.id === FIXTURE_WORKFLOW_ID)!, graph: BUILDER_GRAPH }],
];
