// Author: Navjyot Nishant
// Created: 2026-07-31
// Last updated: 2026-07-31
// Description: Turns a parsed agentic-orchestrator repo into a laid-out React Flow graph.

import type { Edge, Node } from "@xyflow/react";

import { topoLayout } from "@/lib/graph-layout";
import type { ParsedAgent, ParsedRepository, ParsedSkill } from "@/lib/types";

export type ImportSelection = {
  skills: Set<string>;
  agents: Set<string>;
  /**
   * Skills whose documented human-approval gate the user chose to drop.
   * Absent/empty means every gate the source asks for is honoured.
   */
  ungated?: Set<string>;
};

export type SkillConflict = "new" | "update" | "conflict";

/**
 * Classify an imported skill against what is already in the skills table.
 *
 * Re-importing a skill overwrites it with the latest copy, whether it came from
 * this path or a different checkout of the same repo -- the same key from a repo
 * IS the same skill, and a local clone and its git URL are the same source.
 *
 * The one thing never overwritten is a skill that did NOT come from a repo
 * import (a seed, or a hand-written one): graph_runner resolves
 * node.data.selectedSkills by id, so clobbering one silently changes what every
 * existing workflow node feeds its agent.
 */
export function classifySkill(
  key: string,
  _repoPath: string,
  existing: Map<string, { source_repo?: string }>,
): SkillConflict {
  const row = existing.get(key);
  if (!row) return "new";
  return (row.source_repo ?? "") ? "update" : "conflict";
}

/** The id a skill is written under, avoiding a collision with a non-imported skill. */
export function resolvedSkillId(key: string, conflict: SkillConflict, repoName: string): string {
  if (conflict !== "conflict") return key;
  const suffix = repoName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return suffix ? `${key}--${suffix}` : key;
}

function firstSentence(text: string, limit = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const cut = flat.split(". ")[0].trim();
  return cut.length > limit ? `${cut.slice(0, limit - 1)}…` : cut;
}

/**
 * Build the canvas graph from a parse result, restricted to the user's selection.
 *
 * Shape rules:
 *  - a selected agent becomes a specialistAgent node
 *  - a selected skill that spawns >=1 selected agent becomes a supervisorAgent node
 *  - a selected skill that spawns nothing has no node at all -- it is a
 *    selectedSkills attachment on whatever references it. Without this, a repo
 *    like nj-agents renders ~47 nodes, most of them disconnected singletons.
 */
export function buildImportGraph(
  parsed: ParsedRepository,
  selection: ImportSelection,
  skillIdFor: (key: string) => string,
): { nodes: Node[]; edges: Edge[] } {
  const repoName = parsed.repo?.name ?? "repository";
  const allSkills = (parsed.skills ?? []).filter((s) => !s.error);
  const allAgents = (parsed.agents ?? []).filter((a) => !a.error);

  const skills = allSkills.filter((s) => selection.skills.has(s.key));
  const agents = allAgents.filter((a) => selection.agents.has(a.key));
  const agentKeys = new Set(agents.map((a) => a.key));
  const skillByKey = new Map(allSkills.map((s) => [s.key, s]));

  // A skill earns a node only if it actually orchestrates something we imported.
  const spawnsSelectedAgent = (skill: ParsedSkill) =>
    skill.spawns.some((ref) => ref.kind === "agent" && agentKeys.has(ref.key));
  const supervisors = skills.filter(spawnsSelectedAgent);
  const supervisorKeys = new Set(supervisors.map((s) => s.key));

  const nodeId = (kind: "skill" | "agent", key: string) => `imp-${kind}-${key}`;
  const nodes: Node[] = [];
  const edges: Edge[] = [];

  for (const skill of supervisors) {
    // Leaf skills this supervisor references ride along as attached skills rather
    // than nodes, so their prompt still reaches the agent at run time.
    const attached = [
      skillIdFor(skill.key),
      ...skill.spawns
        .filter((ref) => ref.kind === "skill" && !supervisorKeys.has(ref.key) && skillByKey.has(ref.key))
        .map((ref) => skillIdFor(ref.key)),
    ];
    nodes.push({
      id: nodeId("skill", skill.key),
      type: "supervisorAgent",
      position: { x: 0, y: 0 },
      data: {
        label: skill.name || skill.key,
        runtime: "direct",
        sandboxAgent: "codex",
        model: "",
        memoryScope: "team",
        maxIterations: 1,
        delegationStrategy: "parallel_delegation",
        objective: skill.description,
        systemInstructions: skill.body,
        selectedSkills: Array.from(new Set(attached)),
        importedFrom: repoName,
        sourcePath: skill.source_path,
      },
    });
  }

  for (const agent of agents) {
    nodes.push({
      id: nodeId("agent", agent.key),
      type: "specialistAgent",
      position: { x: 0, y: 0 },
      data: {
        label: agent.name || agent.key,
        role: firstSentence(agent.description),
        runtime: "direct",
        sandboxAgent: "codex",
        model: "",
        memoryScope: "workflow",
        maxIterations: 1,
        objective: agent.description,
        systemInstructions: agent.body,
        selectedSkills: [],
        importedFrom: repoName,
        sourcePath: agent.source_path,
      },
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const pushEdge = (source: string, target: string) => {
    if (!nodeIds.has(source) || !nodeIds.has(target) || source === target) return;
    const id = `imp-edge-${source}--${target}`;
    if (edges.some((e) => e.id === id)) return;
    edges.push({ id, source, target, animated: true });
  };

  for (const skill of supervisors) {
    // Agents named in a documented chain run in order: supervisor → a → b → c.
    // Everything else fans out directly from the supervisor and runs in parallel.
    const chains = (skill.pipeline?.chains ?? []).map((chain) =>
      chain.filter((key) => selection.agents.has(key)),
    ).filter((chain) => chain.length >= 2);

    const chained = new Set<string>();
    for (const chain of chains) {
      pushEdge(nodeId("skill", skill.key), nodeId("agent", chain[0]));
      for (let i = 0; i < chain.length - 1; i++) {
        pushEdge(nodeId("agent", chain[i]), nodeId("agent", chain[i + 1]));
      }
      for (const key of chain) chained.add(key);
    }

    // Agents that act on the finished artifact (publish, post, promote) must run
    // AFTER the pipeline, never beside it -- fanning them out from the supervisor
    // starts them before the artifact exists.
    const terminal = (skill.pipeline?.terminal ?? []).filter((key) => selection.agents.has(key));
    const terminalSet = new Set(terminal);

    // Agents with no documented position fan out from the supervisor.
    const fannedOut: string[] = [];
    for (const ref of skill.spawns) {
      if (ref.kind === "agent") {
        if (chained.has(ref.key) || terminalSet.has(ref.key)) continue; // placed elsewhere
        pushEdge(nodeId("skill", skill.key), nodeId("agent", ref.key));
        fannedOut.push(ref.key);
      } else if (supervisorKeys.has(ref.key)) {
        pushEdge(nodeId("skill", skill.key), nodeId("skill", ref.key));
      }
    }

    let joinNodeId = "";
    let tailId = "";
    // Fan-in: when the skill says its parallel branches converge, add an
    // aggregator so they join instead of dangling as leaves. Without this the
    // graph shows the fan-out but loses the "results come back together" step.
    const needsFanIn = skill.pipeline?.fan_in && fannedOut.length >= 2;
    if (needsFanIn) {
      const joinId = `imp-join-${skill.key}`;
      nodes.push({
        id: joinId,
        type: "specialistAgent",
        position: { x: 0, y: 0 },
        data: {
          label: `Aggregate ${skill.name || skill.key}`,
          role: "Aggregator",
          runtime: "direct",
          sandboxAgent: "codex",
          model: "",
          memoryScope: "workflow",
          maxIterations: 1,
          objective:
            `Combine the outputs of the parallel branches under "${skill.name || skill.key}" ` +
            "into a single, de-duplicated result. Note any conflicts between branches explicitly.",
          systemInstructions: "",
          selectedSkills: [],
          importedFrom: repoName,
        },
      });
      nodeIds.add(joinId);
      for (const key of fannedOut) pushEdge(nodeId("agent", key), joinId);
      joinNodeId = joinId;
    }

    // A skill that waits for a human before acting imports as a real approval
    // gate, wired after the work completes -- otherwise the imported workflow
    // would run unattended the very step the source explicitly gates.
    // The user can waive a gate at import time (see the import dialog's warning);
    // waiving is explicit and per-skill, never a default.
    if (skill.approval?.required && !selection.ungated?.has(skill.key)) {
      const gateId = `imp-approval-${skill.key}`;
      nodes.push({
        id: gateId,
        type: "humanApproval",
        position: { x: 0, y: 0 },
        data: {
          label: `Approve: ${skill.name || skill.key}`,
          reason: skill.approval.reason
            ? `"${skill.name || skill.key}" ${skill.approval.reason}. Review the output before it continues.`
            : `"${skill.name || skill.key}" requires human approval before continuing.`,
          timeoutHours: 24,
          importedFrom: repoName,
        },
      });
      nodeIds.add(gateId);

      if (joinNodeId) {
        // Branches already converge on an aggregator -- gate after that.
        pushEdge(joinNodeId, gateId);
      } else {
        // Otherwise gate after whatever ran last.
        const terminals = [
          ...chains.map((chain) => chain[chain.length - 1]),
          ...fannedOut,
        ].filter((key, i, all) => all.indexOf(key) === i);
        if (terminals.length) {
          for (const key of terminals) pushEdge(nodeId("agent", key), gateId);
        } else {
          pushEdge(nodeId("skill", skill.key), gateId);
        }
      }
      tailId = gateId;
    }

    // Publish/promo agents hang off the end of the run -- after the approval gate
    // when there is one, so a human sees the artifact before it goes out.
    if (terminal.length) {
      const upstream =
        tailId ||
        joinNodeId ||
        (chains.length ? nodeId("agent", chains[0][chains[0].length - 1]) : nodeId("skill", skill.key));
      let previous = upstream;
      for (const key of terminal) {
        pushEdge(previous, nodeId("agent", key));
        previous = nodeId("agent", key); // chain them: post, then promote
      }
    }
  }

  return { nodes: topoLayout(nodes, edges).nodes, edges };
}

/** Default selection: everything importable, so "select all" is the starting point. */
export function defaultSelection(parsed: ParsedRepository): ImportSelection {
  return {
    skills: new Set((parsed.skills ?? []).filter((s) => !s.error).map((s: ParsedSkill) => s.key)),
    agents: new Set((parsed.agents ?? []).filter((a) => !a.error).map((a: ParsedAgent) => a.key)),
  };
}
