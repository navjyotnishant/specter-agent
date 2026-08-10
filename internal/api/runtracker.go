package api

import (
	"context"
	"sync"
)

// activeRuns holds a cancel function per in-flight run so POST /{id}/cancel can
// reach a running agent. Without it "cancel" could only mark a database row
// while the subprocess kept working — the UI would say cancelled and the agent
// would keep editing files.
type activeRuns struct {
	mu     sync.Mutex
	cancel map[string]context.CancelFunc
}

var running = &activeRuns{cancel: map[string]context.CancelFunc{}}

func (d *Deps) trackRun(runID string, cancel context.CancelFunc) {
	running.mu.Lock()
	defer running.mu.Unlock()
	running.cancel[runID] = cancel
}

func (d *Deps) untrackRun(runID string) {
	running.mu.Lock()
	defer running.mu.Unlock()
	delete(running.cancel, runID)
}

// cancelRun stops a run if it is executing here. Returns false when the run is
// not in flight in THIS process — a run started by the Python backend, or one
// that has already finished.
func (d *Deps) cancelRun(runID string) bool {
	running.mu.Lock()
	defer running.mu.Unlock()
	cancel, ok := running.cancel[runID]
	if !ok {
		return false
	}
	cancel()
	return true
}

// isRunActive reports whether this process is executing the run.
func (d *Deps) isRunActive(runID string) bool {
	running.mu.Lock()
	defer running.mu.Unlock()
	_, ok := running.cancel[runID]
	return ok
}
