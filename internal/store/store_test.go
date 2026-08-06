package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// The database is the integration point between the CLI and the web UI: the CLI
// writes runs, the UI reads them, and neither process talks to the other.
//
// That only works if the CLI writes EXACTLY the rows the existing backend writes.
// These tests pin the schema contract.

func testDB(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "app.db")

	// The real schema, not a Go-authored approximation: a divergence here would
	// mean the CLI writes rows the UI cannot read, which is the failure this
	// whole design exists to avoid.
	schema, err := os.ReadFile("testdata/schema.sql")
	if err != nil {
		t.Skipf("schema fixture missing: %v", err)
	}

	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	if _, err := s.db.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	return s
}

// WAL is what allows the CLI to write while the UI reads. Without it a reader
// blocks a writer and the two processes fight over the file.
func TestOpenEnablesWAL(t *testing.T) {
	s := testDB(t)

	var mode string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil {
		t.Fatal(err)
	}
	if mode != "wal" {
		t.Fatalf("journal_mode = %q, want wal", mode)
	}

	var timeout int
	if err := s.db.QueryRow("PRAGMA busy_timeout").Scan(&timeout); err != nil {
		t.Fatal(err)
	}
	if timeout < 5000 {
		t.Fatalf("busy_timeout = %d, want >= 5000", timeout)
	}
}

func TestRunLifecycle(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	if _, err := s.db.Exec(
		`INSERT INTO workflows (id, name, description) VALUES (?, ?, ?)`,
		"wf-1", "pre-push-review", "checks"); err != nil {
		t.Fatal(err)
	}

	runID, err := s.CreateRun(ctx, "wf-1", "/tmp/repo")
	if err != nil {
		t.Fatal(err)
	}
	if runID == "" {
		t.Fatal("CreateRun must return an id")
	}

	run, err := s.GetRun(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	// A run starts as running, not completed: the UI shows in-flight work, and a
	// row that appears finished before it starts is a lie the UI cannot detect.
	if run.Status != "running" {
		t.Fatalf("status = %q, want running", run.Status)
	}
	if run.WorkspacePath != "/tmp/repo" {
		t.Fatalf("workspace = %q", run.WorkspacePath)
	}
	if run.CompletedAt != "" {
		t.Fatal("a new run must not carry a completion time")
	}

	if err := s.CompleteRun(ctx, runID, "completed", "all good"); err != nil {
		t.Fatal(err)
	}
	run, _ = s.GetRun(ctx, runID)
	if run.Status != "completed" {
		t.Fatalf("status = %q, want completed", run.Status)
	}
	if run.CompletedAt == "" {
		t.Fatal("completing must stamp completed_at — the UI computes duration from it")
	}
}

func TestStepsAndLogs(t *testing.T) {
	s := testDB(t)
	ctx := context.Background()

	if _, err := s.db.Exec(`INSERT INTO workflows (id, name) VALUES ('wf-1','w')`); err != nil {
		t.Fatal(err)
	}
	runID, err := s.CreateRun(ctx, "wf-1", "/tmp/repo")
	if err != nil {
		t.Fatal(err)
	}

	stepID, err := s.StartStep(ctx, runID, "n1", "specialistAgent")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.CompleteStep(ctx, stepID, "completed"); err != nil {
		t.Fatal(err)
	}

	steps, err := s.Steps(ctx, runID)
	if err != nil {
		t.Fatal(err)
	}
	if len(steps) != 1 || steps[0].Status != "completed" {
		t.Fatalf("steps = %+v", steps)
	}

	if err := s.AppendLog(ctx, runID, "info", "scanning 14 files"); err != nil {
		t.Fatal(err)
	}
	logs, err := s.Logs(ctx, runID, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(logs) != 1 || logs[0].Message != "scanning 14 files" {
		t.Fatalf("logs = %+v", logs)
	}
}

// The whole point: a CLI-started run must be visible to a reader that never
// spoke to the CLI.
func TestConcurrentReaderSeesWriterRows(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.db")
	schema, err := os.ReadFile("testdata/schema.sql")
	if err != nil {
		t.Skipf("schema fixture missing: %v", err)
	}

	writer, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err := writer.db.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.db.Exec(`INSERT INTO workflows (id, name) VALUES ('wf-1','w')`); err != nil {
		t.Fatal(err)
	}

	// A second connection, as the web UI would have.
	reader, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()

	ctx := context.Background()
	runID, err := writer.CreateRun(ctx, "wf-1", "/tmp/repo")
	if err != nil {
		t.Fatal(err)
	}

	got, err := reader.GetRun(ctx, runID)
	if err != nil {
		t.Fatalf("the reader cannot see the writer's run: %v", err)
	}
	if got.ID != runID {
		t.Fatalf("got %q, want %q", got.ID, runID)
	}
}
