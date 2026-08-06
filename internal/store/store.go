// Package store is the CLI's view of Specter's database.
//
// WHY THE DATABASE IS THE INTEGRATION POINT
// `specter run` executes in-process — no server, nothing to start. But it writes
// the same rows the web UI reads, so a CLI-started run appears in the app without
// the two processes ever talking to each other.
//
//	specter run …  ──writes──►  ┌──────────┐
//	                            │ app.db   │
//	web UI         ──reads───►  └──────────┘
//
// That works because SQLite in WAL mode allows concurrent readers alongside a
// writer. It is also the constraint: WAL requires every writer on one filesystem,
// which is fine locally and breaks across a network mount. Postgres removes that
// limit, which is why nothing here reaches for SQLite-specific SQL.
package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/google/uuid"
	_ "modernc.org/sqlite"
)

// Store owns one connection to the Specter database.
type Store struct {
	db *sql.DB
}

// Run mirrors a workflow_runs row.
type Run struct {
	ID            string `json:"id"`
	WorkflowID    string `json:"workflow_id"`
	Status        string `json:"status"`
	WorkspacePath string `json:"workspace_path"`
	FinalReport   string `json:"final_report"`
	CreatedAt     string `json:"created_at"`
	CompletedAt   string `json:"completed_at"`
}

// Step mirrors a workflow_step_runs row.
type Step struct {
	ID          string `json:"id"`
	NodeID      string `json:"node_id"`
	NodeType    string `json:"node_type"`
	Status      string `json:"status"`
	StartedAt   string `json:"started_at"`
	CompletedAt string `json:"completed_at"`
}

// LogEntry mirrors a run_logs row.
type LogEntry struct {
	ID        string `json:"id"`
	Level     string `json:"level"`
	Message   string `json:"message"`
	CreatedAt string `json:"created_at"`
}

// Open connects and configures the pragmas the shared-database design needs.
func Open(path string) (*Store, error) {
	// WAL and busy_timeout in the DSN so they apply to every pooled connection,
	// not just the first. Setting them once after Open leaves later connections
	// unconfigured, and the failure only appears under concurrency.
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)", path)

	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("connecting to database: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// now formats timestamps the way the Python backend does, so rows written by
// either side sort and parse identically.
func now() string {
	return time.Now().UTC().Format("2006-01-02 15:04:05")
}

// CreateRun records a run as in flight.
//
// Status starts as "running", never "completed": the UI shows work in progress,
// and a row that looks finished before it starts is a lie the UI cannot detect.
func (s *Store) CreateRun(ctx context.Context, workflowID, workspacePath string) (string, error) {
	id := uuid.NewString()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO workflow_runs (id, workflow_id, status, trigger_type, workspace_path, created_at)
		 VALUES (?, ?, 'running', 'cli', ?, ?)`,
		id, workflowID, workspacePath, now())
	if err != nil {
		return "", fmt.Errorf("creating run: %w", err)
	}
	return id, nil
}

// CompleteRun stamps the terminal state.
//
// completed_at matters beyond bookkeeping: the UI computes duration from it, and
// a run left without one reads as still running forever.
func (s *Store) CompleteRun(ctx context.Context, runID, status, finalReport string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE workflow_runs SET status = ?, final_report = ?, completed_at = ? WHERE id = ?`,
		status, finalReport, now(), runID)
	if err != nil {
		return fmt.Errorf("completing run: %w", err)
	}
	return nil
}

func (s *Store) GetRun(ctx context.Context, runID string) (Run, error) {
	var run Run
	var workspace, report, completed sql.NullString

	err := s.db.QueryRowContext(ctx,
		`SELECT id, workflow_id, status, workspace_path, final_report, created_at, completed_at
		 FROM workflow_runs WHERE id = ?`, runID).
		Scan(&run.ID, &run.WorkflowID, &run.Status, &workspace, &report, &run.CreatedAt, &completed)
	if err != nil {
		return Run{}, fmt.Errorf("reading run: %w", err)
	}

	run.WorkspacePath = workspace.String
	run.FinalReport = report.String
	run.CompletedAt = completed.String
	return run, nil
}

func (s *Store) StartStep(ctx context.Context, runID, nodeID, nodeType string) (string, error) {
	id := uuid.NewString()
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO workflow_step_runs (id, workflow_run_id, node_id, node_type, status, started_at)
		 VALUES (?, ?, ?, ?, 'running', ?)`,
		id, runID, nodeID, nodeType, now())
	if err != nil {
		return "", fmt.Errorf("starting step: %w", err)
	}
	return id, nil
}

func (s *Store) CompleteStep(ctx context.Context, stepID, status string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE workflow_step_runs SET status = ?, completed_at = ? WHERE id = ?`,
		status, now(), stepID)
	if err != nil {
		return fmt.Errorf("completing step: %w", err)
	}
	return nil
}

func (s *Store) Steps(ctx context.Context, runID string) ([]Step, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, node_id, node_type, status, started_at, completed_at
		 FROM workflow_step_runs WHERE workflow_run_id = ? ORDER BY started_at`, runID)
	if err != nil {
		return nil, fmt.Errorf("reading steps: %w", err)
	}
	defer rows.Close()

	var out []Step
	for rows.Next() {
		var step Step
		var completed sql.NullString
		if err := rows.Scan(&step.ID, &step.NodeID, &step.NodeType, &step.Status,
			&step.StartedAt, &completed); err != nil {
			return nil, err
		}
		step.CompletedAt = completed.String
		out = append(out, step)
	}
	return out, rows.Err()
}

// AppendLog records one progress line, visible to the UI as the run proceeds.
func (s *Store) AppendLog(ctx context.Context, runID, level, message string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO run_logs (id, workflow_run_id, level, message, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		uuid.NewString(), runID, level, message, now())
	if err != nil {
		return fmt.Errorf("appending log: %w", err)
	}
	return nil
}

func (s *Store) Logs(ctx context.Context, runID string, since int) ([]LogEntry, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, level, message, created_at FROM run_logs
		 WHERE workflow_run_id = ? ORDER BY created_at LIMIT -1 OFFSET ?`, runID, since)
	if err != nil {
		return nil, fmt.Errorf("reading logs: %w", err)
	}
	defer rows.Close()

	var out []LogEntry
	for rows.Next() {
		var entry LogEntry
		if err := rows.Scan(&entry.ID, &entry.Level, &entry.Message, &entry.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, entry)
	}
	return out, rows.Err()
}
