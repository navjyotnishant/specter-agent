package exec

import (
	"bufio"
	"context"
	"errors"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Running a subprocess to completion, streaming its output under a deadline.
//
// The mechanics of running an agent, separated from knowing which agents exist.
//
// WHY BOTH PIPES ARE DRAINED CONCURRENTLY
// A subprocess writing more to stderr than the pipe buffer holds blocks forever
// while the parent reads stdout. Draining both at once is what stops a chatty
// agent deadlocking a run.
//
// WHY exec.CommandContext RATHER THAN A MANUAL DEADLINE
// The Python version checked the clock between stdout lines, which only notices
// time passing while output is arriving — a silent agent could overrun. A context
// deadline fires regardless, and the same mechanism serves cancellation.

// drainGrace is how long output collection may continue after the process has
// exited. Long enough for a normal flush, short enough that a pipe held by a
// surviving grandchild cannot hold the run open.
const drainGrace = 2 * time.Second

const (
	// Enough to diagnose a failure without storing a build log in a database row.
	StdoutLimit = 20000
	StderrLimit = 12000
)

// Command is what to run.
type Command struct {
	Argv     []string
	Dir      string
	Env      []string
	Timeout  time.Duration
	OnStdout func(string)
	OnStderr func(string)
}

// Result is what happened. No transport shape — the caller decides how to report.
type Result struct {
	ExitCode int      `json:"exit_code"`
	Stdout   string   `json:"stdout"`
	Stderr   string   `json:"stderr"`
	TimedOut bool     `json:"timed_out"`
	Err      string   `json:"error,omitempty"` // set only when the process could not run
	Lines    []string `json:"-"`
}

func (r Result) OK() bool {
	return r.ExitCode == 0 && !r.TimedOut && r.Err == ""
}

// RunStreaming runs cmd, streaming each line as it arrives.
//
// The context governs cancellation; Timeout adds a deadline on top. Either
// stopping the run is reported as TimedOut, because from the caller's side they
// are the same outcome: it did not finish on its own.
//
// A failure to start returns a Result with Err set rather than an error return:
// "claude is not installed" and "claude exited 1" are both outcomes a caller
// reports the same way.
func RunStreaming(ctx context.Context, cmd Command) Result {
	if cmd.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, cmd.Timeout)
		defer cancel()
	}

	proc := exec.CommandContext(ctx, cmd.Argv[0], cmd.Argv[1:]...)
	proc.Dir = cmd.Dir
	if cmd.Env != nil {
		proc.Env = cmd.Env
	}

	stdout, err := proc.StdoutPipe()
	if err != nil {
		return Result{ExitCode: -1, Err: err.Error()}
	}
	stderr, err := proc.StderrPipe()
	if err != nil {
		return Result{ExitCode: -1, Err: err.Error()}
	}

	if err := proc.Start(); err != nil {
		// Missing binary, bad working directory, no permission.
		return Result{ExitCode: -1, Err: err.Error()}
	}

	var (
		mu          sync.Mutex
		stdoutLines []string
		stderrLines []string
		wg          sync.WaitGroup
	)

	drain := func(r *bufio.Scanner, sink *[]string, on func(string)) {
		defer wg.Done()
		// Agent output can exceed bufio's default 64 KiB line cap; a long line
		// would otherwise end the scan early and truncate the run's output.
		r.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
		for r.Scan() {
			line := strings.TrimRight(r.Text(), "\r\n")
			mu.Lock()
			*sink = append(*sink, line)
			mu.Unlock()
			if on != nil {
				on(line)
			}
		}
	}

	wg.Add(2)
	go drain(bufio.NewScanner(stdout), &stdoutLines, cmd.OnStdout)
	go drain(bufio.NewScanner(stderr), &stderrLines, cmd.OnStderr)

	// Wait for the drains, but NOT unconditionally.
	//
	// Killing the child does not close a pipe its own child inherited. An agent
	// that leaves a background process behind keeps the write end open, so
	// scanning never reaches EOF and this would block past the deadline --
	// forever, with nothing reporting why. Waiting on the PROCESS and giving the
	// drains a short grace period afterwards bounds it: output already written
	// is still collected, and a pipe nobody will close no longer holds the run.
	drained := make(chan struct{})
	go func() { wg.Wait(); close(drained) }()

	// Drains FIRST, then Wait. os/exec closes both pipes inside Wait, and its
	// own documentation says it is incorrect to call Wait before the reads from
	// those pipes have finished. Calling it first is a race that only loses
	// under load: a script that writes and exits immediately can have its pipes
	// closed before the drain goroutines are ever scheduled, and the output is
	// gone. On an idle machine the drains win and nothing looks wrong.
	//
	// That produced failures nowhere near the cause — an agent's reply of "YES"
	// classified as "no", a memory row never written, a second node running
	// with no context — all of them "the output was empty", in three different
	// packages, only on a busy CI runner.
	//
	// The deadline stays, for the reason it was added: killing the child does
	// not close a pipe its own child inherited, so an agent that leaves a
	// background process behind holds the write end open and the scan never
	// reaches EOF. Bounding the wait means output already written is still
	// collected, while a pipe nobody will close cannot hold the run forever.
	select {
	case <-drained:
	case <-time.After(drainGrace):
	}

	waitErr := proc.Wait()

	mu.Lock()
	outText := strings.Join(stdoutLines, "\n")
	errText := strings.Join(stderrLines, "\n")
	lines := append([]string(nil), stdoutLines...)
	mu.Unlock()

	result := Result{
		Stdout: tail(outText, StdoutLimit),
		Stderr: tail(errText, StderrLimit),
		Lines:  lines,
	}

	// Reading the collected lines while a drain goroutine may still be appending
	// to them: the mutex makes that safe, and an orphaned drain writing into a
	// slice nobody reads again is harmless.

	// Context death means the deadline fired or the caller cancelled. Either way
	// the run did not finish on its own, and the exit code reflects the signal
	// rather than anything the agent decided.
	if ctxErr := ctx.Err(); ctxErr != nil {
		result.TimedOut = true
		result.ExitCode = -1
		return result
	}

	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			result.ExitCode = exitErr.ExitCode()
		} else {
			result.ExitCode = -1
			result.Err = waitErr.Error()
		}
		return result
	}

	result.ExitCode = 0
	return result
}

// tail keeps the last n bytes — the end of a failing run is what diagnoses it.
func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
