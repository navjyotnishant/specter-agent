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
	_ "embed"
	"fmt"
	"strings"
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

	// Create the schema if it is not already there. Every statement is CREATE …
	// IF NOT EXISTS, so this is a no-op against a database Python already
	// initialised — which is the case that matters, since both backends run
	// against one file during cutover.
	//
	// Without this the Go binary would require the Python backend to have
	// started at least once, which is not a replacement.
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("applying schema: %w", err)
	}
	if err := applyMigrations(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// applyMigrations adds the columns Python adds via _add_column_if_missing.
//
// These are NOT optional extras: workflows.workspace_path is the only source a
// trigger-started run can read for its repository, and it exists solely as a
// migration. A Go-created database without them is missing columns the running
// application depends on.
//
// SQLite has no ADD COLUMN IF NOT EXISTS, so each statement runs on its own and
// "duplicate column name" means it is already applied — the expected result
// against any database Python has touched.
func applyMigrations(db *sql.DB) error {
	for _, stmt := range strings.Split(migrationsSQL, ";") {
		stmt = strings.TrimSpace(stmt)
		if stmt == "" || strings.HasPrefix(stmt, "--") {
			continue
		}
		if _, err := db.Exec(stmt); err != nil {
			if strings.Contains(err.Error(), "duplicate column name") {
				continue
			}
			return fmt.Errorf("migration %q: %w", stmt, err)
		}
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

//go:embed schema.sql
var schemaSQL string

//go:embed migrations.sql
var migrationsSQL string

// DB exposes the underlying handle for packages that own their own tables
// (auth sessions, users). Everything run-related goes through the methods
// below instead, so the run schema has exactly one writer.
func (s *Store) DB() *sql.DB { return s.db }

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

// Workflow mirrors a workflows row.
type Workflow struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	GraphJSON string `json:"graph_json"`
}

// FindWorkflow resolves a workflow by id or by name.
//
// Name first, because that is what a person types. An exact match wins outright;
// a unique prefix is accepted so `specter run pre-push` works. An ambiguous
// prefix is an error listing the candidates rather than a guess — running the
// wrong workflow is worse than being asked to be specific.
func (s *Store) FindWorkflow(ctx context.Context, ref string) (Workflow, error) {
	var w Workflow
	err := s.db.QueryRowContext(ctx,
		`SELECT id, name, graph_json FROM workflows WHERE id = ? OR name = ?`, ref, ref).
		Scan(&w.ID, &w.Name, &w.GraphJSON)
	if err == nil {
		return w, nil
	}
	if err != sql.ErrNoRows {
		return Workflow{}, fmt.Errorf("looking up workflow: %w", err)
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, graph_json FROM workflows WHERE name LIKE ? ORDER BY name`, ref+"%")
	if err != nil {
		return Workflow{}, fmt.Errorf("looking up workflow: %w", err)
	}
	defer rows.Close()

	var matches []Workflow
	for rows.Next() {
		var candidate Workflow
		if err := rows.Scan(&candidate.ID, &candidate.Name, &candidate.GraphJSON); err != nil {
			return Workflow{}, err
		}
		matches = append(matches, candidate)
	}
	if err := rows.Err(); err != nil {
		return Workflow{}, err
	}

	switch len(matches) {
	case 0:
		return Workflow{}, fmt.Errorf("no workflow matches %q", ref)
	case 1:
		return matches[0], nil
	default:
		names := make([]string, len(matches))
		for i, candidate := range matches {
			names[i] = candidate.Name
		}
		return Workflow{}, fmt.Errorf("%q matches several workflows: %s", ref, strings.Join(names, ", "))
	}
}

// Workflows lists non-template workflows, newest first.
func (s *Store) Workflows(ctx context.Context) ([]Workflow, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, name, graph_json FROM workflows WHERE is_template = 0 ORDER BY updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("listing workflows: %w", err)
	}
	defer rows.Close()

	var out []Workflow
	for rows.Next() {
		var w Workflow
		if err := rows.Scan(&w.ID, &w.Name, &w.GraphJSON); err != nil {
			return nil, err
		}
		out = append(out, w)
	}
	return out, rows.Err()
}
