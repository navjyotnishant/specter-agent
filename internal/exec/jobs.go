package exec

import (
	"context"
	"strings"
	"sync"
)

// In-flight run tracking: progress lines, cancellation, completion.
//
// A run has to be observable while it happens and stoppable while it runs. Both
// need something only the spawning process holds, so this state is deliberately
// per-process rather than shared or persisted.
//
// That is also the crash-isolation trade. Containerized, the host shim owns
// these jobs and a runaway agent dies with it while the API survives. Natively,
// the backend owns them — and Kill below is what stops a stuck agent becoming a
// stuck Specter.

// LineLimit bounds a single progress line. Agent output can be an entire file;
// the progress view wants a line.
const LineLimit = 2000

// TailResult is a window onto a run's output.
type TailResult struct {
	OK    bool     `json:"ok"`
	Lines []string `json:"lines"`
	Done  bool     `json:"done"`
	Total int      `json:"total"`
}

type job struct {
	lines  []string
	done   bool
	cancel context.CancelFunc
}

// Jobs tracks runs in flight. The zero value is not usable; use NewJobs.
type Jobs struct {
	mu     sync.Mutex
	jobs   map[string]*job
	logger func(level, message string)
}

func NewJobs() *Jobs {
	return &Jobs{
		jobs: make(map[string]*job),
		// A no-op default, so an unconfigured Jobs is silent rather than nil-panicking.
		logger: func(string, string) {},
	}
}

// SetLogger routes progress lines to the caller's logger.
//
// Injected rather than imported: the host shim scrubs secrets into its own log
// ring, the CLI renders to a terminal, and the server writes to a database. This
// type should know none of that.
func (j *Jobs) SetLogger(fn func(level, message string)) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if fn != nil {
		j.logger = fn
	}
}

func (j *Jobs) Create(token string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.jobs[token] = &job{}
}

// SetCancel records how to stop this run. Without it, Kill has nothing to act on
// and a caller can only wait out the deadline.
func (j *Jobs) SetCancel(token string, cancel context.CancelFunc) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if existing, ok := j.jobs[token]; ok {
		existing.cancel = cancel
	}
}

// Append records a progress line and forwards it to the logger.
func (j *Jobs) Append(token, line string) {
	if len(line) > LineLimit {
		line = line[:LineLimit]
	}

	j.mu.Lock()
	if existing, ok := j.jobs[token]; ok {
		existing.lines = append(existing.lines, line)
	}
	logger := j.logger
	j.mu.Unlock()

	// Outside the lock: a slow logger must not block a streaming run.
	if strings.TrimSpace(line) != "" {
		logger("info", strings.TrimSpace(line))
	}
}

func (j *Jobs) Done(token string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if existing, ok := j.jobs[token]; ok {
		existing.done = true
		existing.cancel = nil
	}
}

// Kill stops a run. Returns false only when the token is unknown.
//
// The job is marked done whether or not a cancel func was registered: a run that
// cannot be signalled is already gone or unreachable, and leaving it open would
// strand a caller waiting for output that will never arrive.
func (j *Jobs) Kill(token string) bool {
	j.mu.Lock()
	existing, ok := j.jobs[token]
	if !ok {
		j.mu.Unlock()
		return false
	}
	cancel := existing.cancel
	existing.done = true
	existing.cancel = nil
	j.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	return true
}

// Tail returns lines after `since`. An unknown token reports done, so a poller
// stops rather than waiting on a run that no longer exists.
func (j *Jobs) Tail(token string, since int) TailResult {
	j.mu.Lock()
	defer j.mu.Unlock()

	existing, ok := j.jobs[token]
	if !ok {
		return TailResult{OK: false, Lines: []string{}, Done: true}
	}
	if since < 0 || since > len(existing.lines) {
		since = len(existing.lines)
	}

	// Copied: the caller must not hold a slice backed by state we keep mutating.
	window := make([]string, len(existing.lines)-since)
	copy(window, existing.lines[since:])

	return TailResult{OK: true, Lines: window, Done: existing.done, Total: len(existing.lines)}
}
