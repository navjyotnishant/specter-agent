# LLM-driven workflow planner for the smart supervisor agent.
# Decomposes an objective into specialist subtasks via the host runner CLIs
# (Codex, Claude Code, Cursor) and converts the plan into a React Flow graph.
from __future__ import annotations

import json
import re
from uuid import uuid4

from app.runtime.graph_runner import _call_host_runner

MAX_SUBTASKS = 10

PLAN_SCHEMA_EXAMPLE = """{
  "subtasks": [
    {"id": "code-review", "label": "Code Security Reviewer", "role": "Auth middleware reviewer", "objective": "Review auth middleware and API routes for injection and access-control flaws.", "depends_on": []},
    {"id": "deps-audit", "label": "Dependency Auditor", "role": "Dependency vulnerability auditor", "objective": "Check dependency manifests for vulnerable or outdated packages.", "depends_on": []},
    {"id": "report", "label": "Report Writer", "role": "Findings report writer", "objective": "Aggregate all findings into a severity-rated report.", "depends_on": ["code-review", "deps-audit"]}
  ],
  "approval_gate": {"needed": true, "reason": "Review findings before the final report is written.", "after_task_ids": ["code-review", "deps-audit"]},
  "memory_synthesis": {"needed": true, "label": "Write review summary"}
}"""


class PlannerUnavailableError(RuntimeError):
    """Raised when the host runner (and therefore the planner CLI) is unreachable."""


# ── CLI invocation ────────────────────────────────────────────────────────────

def _run_planner_cli(prompt: str, runtime: str, agent: str, workspace_path: str, timeout_seconds: int) -> str:
    agent = (agent or "claude").strip().lower()
    payload = {
        "agent": agent,
        "workspace_path": workspace_path,
        "prompt": prompt,
        "mode": "read-only",
        "timeout_seconds": timeout_seconds,
        "job_token": str(uuid4()),
    }
    host_path = "/runtimes/direct-cli/run" if (runtime or "").strip().lower() == "direct" else "/runtimes/docker-sandbox/run"
    result = _call_host_runner(host_path, payload)

    if result.get("status") == "host_runner_unavailable":
        raise PlannerUnavailableError(str(result.get("message") or "Specter Host Runner is unavailable."))
    if not result.get("ok"):
        raise ValueError(str(result.get("message") or result.get("stderr") or "Planner agent run failed."))

    text = str(result.get("final_message") or "").strip() or str(result.get("stdout") or "").strip()
    if not text:
        raise ValueError("Planner agent returned no output.")
    return text


# ── plan parsing / validation ─────────────────────────────────────────────────

def _find_matching_brace(text: str, start: int) -> int:
    """Return the index just past the closing '}' that matches the '{' at
    `start`, skipping over braces inside strings. -1 if unbalanced."""
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
    return -1


def _iter_top_level_objects(text: str):
    """Yield every balanced top-level {...} substring found in `text`, in order."""
    i = 0
    while True:
        start = text.find("{", i)
        if start == -1:
            return
        end = _find_matching_brace(text, start)
        if end == -1:
            return
        yield text[start:end]
        i = end


_MISSING_OBJECT_BRACE = re.compile(r"(\[\s*|\}\s*,\s*)(?=\"[^\"]+\"\s*:)")


def _find_matching_bracket(text: str, start: int) -> int:
    """Same as _find_matching_brace but for a '[' at `start`. -1 if unbalanced."""
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return i + 1
    return -1


def _repair_missing_array_element_braces(candidate: str) -> str:
    """Some CLI agents occasionally drop the opening '{' of each object inside
    the 'subtasks' array while keeping the closing '}' (e.g.
    `[\"id\": \"a\", ...}, \"id\": \"b\", ...}]`). Insert the missing '{' only at true
    element boundaries — right after '[' or after a '},' — and only within the
    'subtasks' array span, so unrelated top-level keys after the array (e.g.
    'approval_gate', 'memory_synthesis') are never touched. No-op on
    well-formed JSON or if no 'subtasks' array is found."""
    match = re.search(r'"subtasks"\s*:\s*\[', candidate)
    if not match:
        return candidate
    arr_start = match.end() - 1
    arr_end = _find_matching_bracket(candidate, arr_start)
    if arr_end == -1:
        return candidate
    array_span = candidate[arr_start:arr_end]
    repaired_span = _MISSING_OBJECT_BRACE.sub(lambda m: m.group(1) + "{", array_span)
    return candidate[:arr_start] + repaired_span + candidate[arr_end:]


def _repair_missing_outer_brace(candidate: str) -> str:
    """The same brace-dropping slip can also eat the outermost '{', leaving the
    response starting directly with `"subtasks": [...`. The trailing '}' that
    was meant to close that (never-opened) object is still present, so just
    prepend '{' — no-op if it already starts with '{' or doesn't look like a
    bare top-level key."""
    stripped = candidate.strip()
    if stripped.startswith("{") or not re.match(r'^"[^"]+"\s*:', stripped):
        return candidate
    return "{" + stripped


def _extract_plan_json(text: str) -> dict:
    raw = text.strip()

    # Prefer the LAST fenced ```json block — CLI output often prepends
    # unrelated sandbox/bootstrap noise before the agent's real answer.
    fences = re.findall(r"```(?:json)?\s*(.*?)```", raw, re.DOTALL)
    candidates = [fences[-1].strip()] if fences else []
    candidates.append(raw)

    last_error: json.JSONDecodeError | None = None
    for candidate in candidates:
        elem_repaired = _repair_missing_array_element_braces(candidate)
        variants = (
            candidate,
            elem_repaired,
            _repair_missing_outer_brace(candidate),
            _repair_missing_outer_brace(elem_repaired),
        )
        for text_variant in variants:
            try:
                parsed = json.loads(text_variant)
            except json.JSONDecodeError as exc:
                last_error = exc
                parsed = None
            if isinstance(parsed, dict) and isinstance(parsed.get("subtasks"), list):
                return parsed

            # Scan for any balanced {...} substring that actually looks like a plan
            # (has a 'subtasks' list) rather than assuming the first/last brace pair
            # in the raw text is the answer — bootstrap/log noise can contain braces.
            for obj_text in _iter_top_level_objects(text_variant):
                try:
                    obj = json.loads(obj_text)
                except json.JSONDecodeError:
                    continue
                if isinstance(obj, dict) and isinstance(obj.get("subtasks"), list):
                    return obj

    if last_error is not None:
        raise ValueError(f"Planner returned malformed JSON: {last_error}")
    raise ValueError("Planner did not return JSON. Try re-running the plan.")


def _validate_plan(plan: dict) -> None:
    subtasks = plan.get("subtasks")
    if not isinstance(subtasks, list) or not subtasks:
        raise ValueError("Plan must contain a non-empty 'subtasks' list.")
    if len(subtasks) > MAX_SUBTASKS:
        raise ValueError(f"Plan has too many subtasks ({len(subtasks)} > {MAX_SUBTASKS}).")

    ids: set[str] = set()
    for task in subtasks:
        if not isinstance(task, dict):
            raise ValueError("Each subtask must be an object.")
        task_id = str(task.get("id") or "").strip()
        if not task_id:
            raise ValueError("Each subtask needs a non-empty 'id'.")
        if task_id in ids:
            raise ValueError(f"Duplicate subtask id: {task_id}")
        if not str(task.get("label") or "").strip():
            raise ValueError(f"Subtask '{task_id}' needs a non-empty 'label'.")
        ids.add(task_id)

    for task in subtasks:
        for dep in task.get("depends_on") or []:
            if str(dep) not in ids:
                raise ValueError(f"Subtask '{task['id']}' depends on unknown task '{dep}'.")

    # cycle check (Kahn): every task must be reachable once dependencies drain
    in_degree = {tid: 0 for tid in ids}
    adjacency: dict[str, list[str]] = {tid: [] for tid in ids}
    for task in subtasks:
        for dep in task.get("depends_on") or []:
            adjacency[str(dep)].append(str(task["id"]))
            in_degree[str(task["id"])] += 1
    queue = [tid for tid, deg in in_degree.items() if deg == 0]
    visited: set[str] = set()
    while queue:
        tid = queue.pop(0)
        visited.add(tid)
        for neighbor in adjacency[tid]:
            in_degree[neighbor] -= 1
            if in_degree[neighbor] == 0:
                queue.append(neighbor)
    if len(visited) != len(ids):
        raise ValueError("Plan contains a dependency cycle — 'depends_on' must form a DAG.")

    gate = plan.get("approval_gate")
    if isinstance(gate, dict) and gate.get("needed"):
        for dep in gate.get("after_task_ids") or []:
            if str(dep) not in ids:
                raise ValueError(f"approval_gate references unknown task '{dep}'.")


# ── plan → React Flow graph ───────────────────────────────────────────────────

def _plan_to_graph(plan: dict, supervisor_node_id: str, runtime: str, agent: str) -> dict:
    subtasks = plan["subtasks"]
    task_ids = {str(t["id"]) for t in subtasks}
    node_id = {tid: f"gen-{supervisor_node_id}-{tid}" for tid in task_ids}

    nodes: list[dict] = []
    edges: list[dict] = []

    def add_edge(source: str, target: str) -> None:
        edges.append({
            "id": f"gen-e-{source}-{target}",
            "source": source,
            "target": target,
            "type": "smoothstep",
            "data": {"generatedBy": supervisor_node_id},
        })

    for task in subtasks:
        tid = str(task["id"])
        nodes.append({
            "id": node_id[tid],
            "type": "specialistAgent",
            "position": {"x": 0, "y": 0},
            "data": {
                "label": str(task.get("label") or tid),
                "role": str(task.get("role") or ""),
                "model": "",
                "selectedTools": [],
                "selectedSkills": [],
                "memoryScope": "workflow",
                "maxIterations": 1,
                "objective": str(task.get("objective") or ""),
                "systemInstructions": "",
                "runtime": runtime,
                "sandboxAgent": agent,
                "generatedBy": supervisor_node_id,
            },
        })
        deps = [str(d) for d in (task.get("depends_on") or [])]
        if deps:
            for dep in deps:
                add_edge(node_id[dep], node_id[tid])
        else:
            add_edge(supervisor_node_id, node_id[tid])

    # leaf tasks = tasks nothing depends on
    depended_on = {str(d) for t in subtasks for d in (t.get("depends_on") or [])}
    leaf_ids = [str(t["id"]) for t in subtasks if str(t["id"]) not in depended_on]

    tail_ids = [node_id[tid] for tid in leaf_ids]
    gate = plan.get("approval_gate")
    if isinstance(gate, dict) and gate.get("needed"):
        gate_node_id = f"gen-{supervisor_node_id}-approval"
        after = [str(t) for t in (gate.get("after_task_ids") or []) if str(t) in task_ids] or leaf_ids
        nodes.append({
            "id": gate_node_id,
            "type": "humanApproval",
            "position": {"x": 0, "y": 0},
            "data": {
                "label": "Human Approval",
                "reason": str(gate.get("reason") or "Review the findings before continuing."),
                "timeoutHours": 24,
                "generatedBy": supervisor_node_id,
            },
        })
        for tid in after:
            add_edge(node_id[tid], gate_node_id)
        # downstream tasks that depend on gated tasks keep their edges; the gate
        # only needs to sit after its listed tasks. If the gate covers all leaves,
        # memory synthesis chains after the gate instead.
        if set(after) >= set(leaf_ids):
            tail_ids = [gate_node_id]
        else:
            tail_ids = [node_id[tid] for tid in leaf_ids if tid not in after] + [gate_node_id]

    memory = plan.get("memory_synthesis")
    if isinstance(memory, dict) and memory.get("needed"):
        memory_node_id = f"gen-{supervisor_node_id}-memory"
        nodes.append({
            "id": memory_node_id,
            "type": "memory",
            "position": {"x": 0, "y": 0},
            "data": {
                "label": str(memory.get("label") or "Write workflow summary"),
                "scope": "workflow",
                "generatedBy": supervisor_node_id,
            },
        })
        for tail in tail_ids:
            add_edge(tail, memory_node_id)

    return {"nodes": nodes, "edges": edges}


# ── prompts ───────────────────────────────────────────────────────────────────

def _build_planning_prompt(objective: str, system_instructions: str, current_plan: dict | None, feedback: str) -> str:
    parts = [
        "You are a supervisor agent planning a multi-agent workflow.",
        f"OBJECTIVE: {objective}",
    ]
    if system_instructions.strip():
        parts.append(f"SUPERVISOR INSTRUCTIONS: {system_instructions.strip()}")
    parts.append(
        "You are running inside the target repository. Spend at most a minute inspecting the "
        "top-level layout (manifests, main directories) to ground your plan. Do NOT do a deep scan."
    )
    parts.append(
        "Decompose the objective into 3-7 subtasks, each handled by one specialist agent. "
        "Give every subtask a UNIQUE, specific role: a 2-4 word descriptor of what that agent "
        "does (e.g. 'Auth middleware reviewer', not 'code review'). No two subtasks may share "
        "the same role. These archetype categories exist only so the UI can pick an icon and "
        "color — code review, dependency/audit, secrets/config, test/QA, report/writer — pick "
        "the closest category when wording each role, but the role string itself must be "
        "distinct and task-specific. Rules: tasks that are independent must have "
        "disjoint depends_on lists (they will run in parallel); a task that consumes another "
        "task's output must list that task in depends_on; a final aggregation/report task must "
        "depend on every task it summarizes. Recommend an approval_gate before any final report "
        "or risky conclusion, and memory_synthesis when a durable summary is useful."
    )
    if current_plan is not None:
        parts.append(f"CURRENT PLAN (JSON):\n{json.dumps(current_plan, indent=2)}")
        parts.append(
            f"USER FEEDBACK: {feedback.strip() or 'Improve the plan.'}\n"
            "Revise the current plan according to the feedback. Keep the ids of unchanged subtasks stable."
        )
    parts.append(
        "Respond with ONLY a JSON object matching this schema — no prose, no markdown fences:\n"
        + PLAN_SCHEMA_EXAMPLE
    )
    return "\n\n".join(parts)


def _build_tune_prompt(node_data: dict, instruction: str) -> str:
    current = {
        "label": str(node_data.get("label") or ""),
        "role": str(node_data.get("role") or ""),
        "objective": str(node_data.get("objective") or ""),
        "systemInstructions": str(node_data.get("systemInstructions") or ""),
    }
    return (
        "You are refining the configuration of one specialist agent inside a multi-agent workflow.\n\n"
        f"CURRENT CONFIGURATION (JSON):\n{json.dumps(current, indent=2)}\n\n"
        f"USER INSTRUCTION: {instruction.strip()}\n\n"
        "Update the configuration per the instruction. Keep values concise. "
        "Respond with ONLY a JSON object containing exactly these keys: "
        '"label", "role", "objective", "systemInstructions". No prose, no markdown fences.'
    )


# ── public API ────────────────────────────────────────────────────────────────

def plan_workflow(
    objective: str,
    supervisor_node_id: str,
    runtime: str,
    agent: str,
    workspace_path: str,
    system_instructions: str = "",
    current_plan: dict | None = None,
    feedback: str = "",
) -> dict:
    """Decompose an objective into a specialist subgraph. Returns {"nodes", "edges"}."""
    prompt = _build_planning_prompt(objective, system_instructions, current_plan, feedback)
    text = _run_planner_cli(prompt, runtime, agent, workspace_path, timeout_seconds=180)
    plan = _extract_plan_json(text)
    _validate_plan(plan)
    return _plan_to_graph(plan, supervisor_node_id, runtime, agent)


def tune_node(node_data: dict, instruction: str, runtime: str, agent: str, workspace_path: str) -> dict:
    """Refine one node's label/role/objective/systemInstructions per a user instruction."""
    prompt = _build_tune_prompt(node_data, instruction)
    text = _run_planner_cli(prompt, runtime, agent, workspace_path, timeout_seconds=90)
    parsed = _extract_plan_json(text)
    updated = {
        "label": str(parsed.get("label") or "").strip(),
        "role": str(parsed.get("role") or "").strip(),
        "objective": str(parsed.get("objective") or "").strip(),
        "systemInstructions": str(parsed.get("systemInstructions") or "").strip(),
    }
    if not updated["label"]:
        raise ValueError("Tuned node must keep a non-empty label.")
    return updated


# ── legacy demo compat (used by agent_engine.start_security_review_demo) ─────

SECURITY_REVIEW_PLAN = [
    {"agent": "Code Security Reviewer Agent", "task": "Review source code for insecure patterns and risky data handling."},
    {"agent": "Dependency Vulnerability Agent", "task": "Inspect dependency manifests and summarize package risk."},
    {"agent": "Secrets & Configuration Agent", "task": "Check configuration surfaces with strict masking and exclusion rules."},
    {"agent": "Report Writer Agent", "task": "Aggregate findings into an auditable security review report."},
]


def create_supervisor_plan(objective: str) -> dict:
    return {
        "objective": objective,
        "strategy": "sequential_delegation",
        "tasks": SECURITY_REVIEW_PLAN,
        "approval_policy": "Require approval before final report or external write actions.",
    }
