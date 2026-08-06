package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// runWorkflow executes every node in dependency order.
//
// In-process: no server, no daemon, no HTTP. Progress is written to the same
// database the web UI reads, so the run is visible there as it happens without
// the two ever talking to each other.
func runWorkflow(dbPath, workflowRef, workspace string, timeout time.Duration) error {
	db, err := store.Open(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	// Ctrl-C must stop the agent, not just this process. Without the signal
	// wired into the context, killing the CLI would orphan a running agent that
	// keeps working with nobody watching.
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	workflow, err := db.FindWorkflow(ctx, workflowRef)
	if err != nil {
		return err
	}

	parsed, err := graph.Parse([]byte(workflow.GraphJSON))
	if err != nil {
		return err
	}
	order, err := parsed.ExecutionOrder()
	if err != nil {
		// Reported before anything is spawned, so a broken graph costs nothing.
		return fmt.Errorf("%s: %w", workflow.Name, err)
	}

	approved, reason := exec.ApprovedWorkspace(workspace, exec.AllowlistPath())
	if approved == "" {
		return fmt.Errorf("%s", reason)
	}

	runID, err := db.CreateRun(ctx, workflow.ID, approved)
	if err != nil {
		return err
	}

	fmt.Printf("\n  %s\n", workflow.Name)
	fmt.Printf("  %s\n\n", dim(approved))

	jobs := exec.NewJobs()
	jobs.SetLogger(func(level, message string) {
		_ = db.AppendLog(ctx, runID, level, message)
	})

	failed := false
	for _, node := range order {
		if err := runNode(ctx, db, jobs, runID, node, approved, timeout); err != nil {
			failed = true
			fmt.Printf("  %s %s — %v\n", red("✗"), node.Name(), err)
			// Stop at the first failure: later nodes consume earlier output, so
			// continuing past a failure produces work built on nothing.
			break
		}
		fmt.Printf("  %s %s\n", green("✓"), node.Name())
	}

	status := "completed"
	if failed {
		status = "failed"
	}
	if ctx.Err() != nil {
		status = "cancelled"
	}
	if err := db.CompleteRun(ctx, runID, status, ""); err != nil {
		// The run itself finished; only the record is incomplete. Say so rather
		// than reporting the run as failed.
		fmt.Fprintf(os.Stderr, "  warning: could not record completion: %v\n", err)
	}

	fmt.Printf("\n  %s · %s\n\n", status, dim(runID))
	if failed {
		return fmt.Errorf("workflow failed")
	}
	return nil
}

func runNode(
	ctx context.Context,
	db *store.Store,
	jobs *exec.Jobs,
	runID string,
	node graph.Node,
	workspace string,
	timeout time.Duration,
) error {
	stepID, err := db.StartStep(ctx, runID, node.ID, node.Type)
	if err != nil {
		return err
	}

	agentPath := exec.ClaudePath()
	if agentPath == "" {
		_ = db.CompleteStep(ctx, stepID, "failed")
		return fmt.Errorf("claude is not installed")
	}

	prompt := node.Data.Objective
	if instructions := strings.TrimSpace(node.Data.SystemInstructions); instructions != "" {
		prompt = instructions + "\n\n" + prompt
	}

	jobs.Create(stepID)
	nodeCtx, cancelNode := context.WithCancel(ctx)
	defer cancelNode()
	jobs.SetCancel(stepID, cancelNode)

	result := exec.RunStreaming(nodeCtx, exec.Command{
		// --permission-mode plan: read-only is the default, and the agent's own
		// guardrail is the first of two. OS confinement is the second (#36).
		Argv:    []string{agentPath, "--permission-mode", "plan", "-p", prompt},
		Dir:     workspace,
		Timeout: timeout,
		OnStdout: func(line string) {
			exec.AppendProgress(line, func(text string) { jobs.Append(stepID, text) })
		},
	})
	jobs.Done(stepID)

	if result.TimedOut {
		_ = db.CompleteStep(ctx, stepID, "failed")
		return fmt.Errorf("timed out after %s", timeout)
	}
	if result.Err != "" {
		_ = db.CompleteStep(ctx, stepID, "failed")
		return fmt.Errorf("%s", result.Err)
	}
	if !result.OK() {
		_ = db.CompleteStep(ctx, stepID, "failed")
		if message := exec.ErrorMessage(result.Stdout); message != "" {
			return fmt.Errorf("%s", message)
		}
		return fmt.Errorf("exited %d", result.ExitCode)
	}

	return db.CompleteStep(ctx, stepID, "completed")
}

// cmdRun parses `specter run` and hands off to the executor.
func cmdRun(args []string) error {
	flags := flag.NewFlagSet("run", flag.ContinueOnError)
	repo := flags.String("repo", "", "repository to run against (default: current directory)")
	timeout := flags.Duration("timeout", 10*time.Minute, "per-node time limit")
	dbPath := flags.String("db", defaultDBPath(), "path to the Specter database")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if flags.NArg() < 1 {
		return fmt.Errorf("which workflow? try `specter workflows`")
	}

	workspace := *repo
	if workspace == "" {
		// The current directory is the obvious default for a terminal tool, and
		// it still has to pass the allowlist — convenience does not widen access.
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		workspace = cwd
	}
	return runWorkflow(*dbPath, flags.Arg(0), workspace, *timeout)
}

func cmdWorkflows() error {
	db, err := store.Open(defaultDBPath())
	if err != nil {
		return err
	}
	defer db.Close()

	workflows, err := db.Workflows(context.Background())
	if err != nil {
		return err
	}
	if len(workflows) == 0 {
		fmt.Println("  no workflows yet — create one in the Specter UI")
		return nil
	}
	fmt.Println()
	for _, w := range workflows {
		fmt.Printf("  %-28s %s\n", w.Name, dim(w.ID))
	}
	fmt.Println()
	return nil
}

// defaultDBPath finds the database the web UI uses, so both see one set of runs.
func defaultDBPath() string {
	if override := os.Getenv("SDLC_DATABASE_PATH"); override != "" {
		return override
	}
	if cwd, err := os.Getwd(); err == nil {
		if candidate := filepath.Join(cwd, "data", "app.db"); fileExists(candidate) {
			return candidate
		}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "app.db"
	}
	return filepath.Join(home, ".specter", "app.db")
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
