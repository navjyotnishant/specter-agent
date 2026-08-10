package graph

// Scheduling, ported from topological_order/topological_levels in
// backend/app/runtime/graph_runner.py.
//
// This is deliberately SEPARATE from ExecutionOrder, and deliberately more
// lenient than it. ExecutionOrder serves the CLI, where a human is watching and
// a malformed graph should be refused. Levels serves the runner, where Python
// never refuses: a cycle drops nodes out of Kahn's algorithm and a fallback
// appends them at the end, so the run proceeds. Making the Go runner strict
// here would mean one workflow behaves differently depending on which backend
// started it, which is the exact failure the port exists to avoid.

// ApprovalNodeType is the node that suspends a run until a human resolves it.
const ApprovalNodeType = "humanApproval"

// TopologicalOrder returns nodes in dependency order (Kahn's algorithm),
// appending anything the algorithm could not reach.
//
// Unreached nodes are the cycle case. They are appended rather than dropped:
// losing a node silently is worse than running one whose position is wrong,
// because the run would simply skip work the author asked for.
func (g *Graph) TopologicalOrder() []Node {
	byID := make(map[string]Node, len(g.Nodes))
	indegree := make(map[string]int, len(g.Nodes))
	for _, node := range g.Nodes {
		byID[node.ID] = node
		indegree[node.ID] = 0
	}

	dependents := make(map[string][]string, len(g.Edges))
	for _, edge := range g.Edges {
		// Membership-checked: a saved graph can carry an edge to a node the
		// user has since deleted, and that must not change scheduling.
		if _, ok := byID[edge.Source]; !ok {
			continue
		}
		if _, ok := byID[edge.Target]; !ok {
			continue
		}
		dependents[edge.Source] = append(dependents[edge.Source], edge.Target)
		indegree[edge.Target]++
	}

	// Seeded in DECLARATION order, not map order. Go randomises map iteration,
	// so without this the same graph schedules differently between runs and a
	// failure cannot be reproduced.
	var ready []string
	for _, node := range g.Nodes {
		if indegree[node.ID] == 0 {
			ready = append(ready, node.ID)
		}
	}

	order := make([]Node, 0, len(g.Nodes))
	seen := make(map[string]bool, len(g.Nodes))
	for len(ready) > 0 {
		id := ready[0]
		ready = ready[1:]
		if node, ok := byID[id]; ok {
			order = append(order, node)
			seen[id] = true
		}
		for _, next := range dependents[id] {
			indegree[next]--
			if indegree[next] == 0 {
				ready = append(ready, next)
			}
		}
	}

	// Whatever the queue never reached — the cycle.
	for _, node := range g.Nodes {
		if !seen[node.ID] {
			order = append(order, node)
		}
	}
	return order
}

// Levels groups nodes into depth bands that can run in parallel, then splits
// every approval gate into a band of its own.
//
// Depth is max(parent depth) + 1, so a node with two parents waits for BOTH.
// Taking the first parent's depth instead would start a join node while one of
// its inputs was still running.
func (g *Graph) Levels() [][]Node {
	if len(g.Nodes) == 0 {
		return nil
	}

	ordered := g.TopologicalOrder()

	parents := make(map[string][]string, len(g.Nodes))
	known := make(map[string]bool, len(g.Nodes))
	for _, node := range g.Nodes {
		known[node.ID] = true
	}
	for _, edge := range g.Edges {
		if known[edge.Source] && known[edge.Target] {
			parents[edge.Target] = append(parents[edge.Target], edge.Source)
		}
	}

	// Walking in topological order means a parent's depth is already known by
	// the time its child is reached — except inside a cycle, where the fallback
	// nodes land at depth 0. That matches Python; a cycle has no correct answer
	// and the run degrades rather than refusing.
	depth := make(map[string]int, len(ordered))
	maxDepth := 0
	for _, node := range ordered {
		best := -1
		for _, parent := range parents[node.ID] {
			if d, ok := depth[parent]; ok && d > best {
				best = d
			}
		}
		depth[node.ID] = best + 1
		if depth[node.ID] > maxDepth {
			maxDepth = depth[node.ID]
		}
	}

	bands := make([][]Node, maxDepth+1)
	for _, node := range ordered {
		bands[depth[node.ID]] = append(bands[depth[node.ID]], node)
	}

	// Split approval gates out. An approval that ran alongside three agents
	// would gate nothing — the actions it exists to authorise would already be
	// in flight. Each gate also gets its OWN level, so resolving one never
	// implicitly authorises another.
	var levels [][]Node
	for _, band := range bands {
		var agents, approvals []Node
		for _, node := range band {
			if node.Type == ApprovalNodeType {
				approvals = append(approvals, node)
			} else {
				agents = append(agents, node)
			}
		}
		if len(agents) > 0 {
			levels = append(levels, agents)
		}
		for _, approval := range approvals {
			levels = append(levels, []Node{approval})
		}
	}
	return levels
}
