package exec

import (
	"context"
	"sync"
	"testing"
	"time"
)

// Ported from specter_exec/jobs.py --self-check.
//
// This is where crash isolation is traded away: containerized, a runaway agent
// dies with the host runner and the API survives; natively, the backend holds
// the job. Cancellation is what stops a stuck agent becoming a stuck Specter,
// so it is tested directly rather than assumed.

func TestJobProgress(t *testing.T) {
	jobs := NewJobs()
	var seen []string
	jobs.SetLogger(func(level, message string) { seen = append(seen, message) })

	jobs.Create("t1")
	jobs.Append("t1", "first")
	jobs.Append("t1", "second")

	got := jobs.Tail("t1", 0)
	if len(got.Lines) != 2 || got.Lines[0] != "first" || got.Lines[1] != "second" {
		t.Fatalf("tail returned %v", got.Lines)
	}
	if since := jobs.Tail("t1", 1); len(since.Lines) != 1 || since.Lines[0] != "second" {
		t.Fatalf("since must skip what was already read, got %v", since.Lines)
	}
	if len(seen) != 2 {
		t.Fatalf("progress must reach the logger, got %v", seen)
	}

	// Blank lines are padding in agent output; logging them is noise.
	jobs.Append("t1", "   ")
	if len(seen) != 2 {
		t.Fatalf("blank lines must not be logged, got %v", seen)
	}
}

func TestJobDoneState(t *testing.T) {
	jobs := NewJobs()
	jobs.Create("t1")

	if jobs.Tail("t1", 0).Done {
		t.Fatal("a live job must not report done")
	}
	jobs.Done("t1")
	if !jobs.Tail("t1", 0).Done {
		t.Fatal("done must mark it finished")
	}
}

// An unknown token must report done, or a poller spins forever waiting for
// output that will never arrive.
func TestUnknownJobReportsDone(t *testing.T) {
	jobs := NewJobs()
	got := jobs.Tail("never-existed", 0)
	if !got.Done {
		t.Fatal("an unknown token must report done")
	}
	if got.OK {
		t.Fatal("and must report not-ok")
	}
	if jobs.Kill("never-existed") {
		t.Fatal("killing an unknown token must return false")
	}
}

// THE CANCELLATION PATH. Without a cancel func recorded there is nothing to
// stop, and a runaway agent keeps running with nobody watching.
func TestJobCancellation(t *testing.T) {
	jobs := NewJobs()
	jobs.Create("t2")

	ctx, cancel := context.WithCancel(context.Background())
	jobs.SetCancel("t2", cancel)

	if !jobs.Kill("t2") {
		t.Fatal("kill must return true for a known job")
	}
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("kill must actually cancel the context")
	}
	if !jobs.Tail("t2", 0).Done {
		t.Fatal("kill must mark the job done")
	}
}

// A job with no cancel func registered must still be killable — it is marked
// done rather than left open, or a caller waits on it forever.
func TestKillWithoutCancelFuncStillMarksDone(t *testing.T) {
	jobs := NewJobs()
	jobs.Create("t3")

	if !jobs.Kill("t3") {
		t.Fatal("kill must return true even with no process registered")
	}
	if !jobs.Tail("t3", 0).Done {
		t.Fatal("and must still mark the job done")
	}
}

// Runs happen concurrently. The race detector catches what review does not.
func TestJobsAreConcurrencySafe(t *testing.T) {
	jobs := NewJobs()
	jobs.Create("shared")

	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			jobs.Append("shared", "line")
			jobs.Tail("shared", 0)
		}()
	}
	wg.Wait()

	if total := jobs.Tail("shared", 0).Total; total != 50 {
		t.Fatalf("want 50 lines, got %d", total)
	}
}
