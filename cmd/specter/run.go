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

	tea "github.com/charmbracelet/bubbletea"
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

	jobs := exec.NewJobs()
	jobs.SetLogger(func(level, message string) {
		_ = db.AppendLog(ctx, runID, level, message)
	})

	// Two presentations of one run. The tree redraws in place and needs a
	// terminal; piped output must stay line-oriented so it greps and appends to
	// a log file cleanly. Same execution either way — only the reporting differs.
	var failed bool
	if useColour {
		failed = runWithLiveView(ctx, db, jobs, runID, workflow.Name, approved, order, timeout)
	} else {
		failed = runPlain(ctx, db, jobs, runID, workflow.Name, approved, order, timeout)
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
	onProgress func(string),
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
			exec.AppendProgress(line, func(text string) {
				jobs.Append(stepID, text)
				if onProgress != nil {
					onProgress(text)
				}
			})
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

// runPlain reports line by line. Used when output is piped, redirected, or
// NO_COLOR is set — a redrawing view in a log file is unreadable.
func runPlain(
	ctx context.Context, db *store.Store, jobs *exec.Jobs, runID, name, workspace string,
	order []graph.Node, timeout time.Duration,
) bool {
	fmt.Printf("\n  %s\n  %s\n\n", name, workspace)
	for _, node := range order {
		if err := runNode(ctx, db, jobs, runID, node, workspace, timeout, nil); err != nil {
			fmt.Printf("  %s %s — %v\n", red("✗"), node.Name(), err)
			return true
		}
		fmt.Printf("  %s %s\n", green("✓"), node.Name())
	}
	return false
}

// runWithLiveView drives the Bubble Tea tree.
//
// Execution runs on its own goroutine and reports progress as messages; the
// program owns the terminal. Running them the other way round would block the
// event loop and freeze the view for the length of the run.
func runWithLiveView(
	ctx context.Context, db *store.Store, jobs *exec.Jobs, runID, name, workspace string,
	order []graph.Node, timeout time.Duration,
) bool {
	model := newRunModel(name, workspace, confinementMechanism(), "read-only", "in place", order)
	// WithAltScreen: the view redraws in place on its own screen and restores the
	// terminal afterwards, so a multi-minute run does not leave hundreds of
	// spinner frames scrolled into the user's scrollback.
	program := tea.NewProgram(model, tea.WithAltScreen())

	failed := make(chan bool, 1)
	go func() {
		anyFailed := false
		for i, node := range order {
			program.Send(nodeStartedMsg{index: i})

			err := runNode(ctx, db, jobs, runID, node, workspace, timeout, func(line string) {
				program.Send(nodeProgressMsg{index: i, line: line})
			})

			program.Send(nodeFinishedMsg{index: i, err: err})
			if err != nil {
				anyFailed = true
				break
			}
		}
		// A short pause so the final state is visible rather than flashing past
		// as the program tears the view down.
		time.Sleep(400 * time.Millisecond)
		program.Send(runFinishedMsg{})
		failed <- anyFailed
	}()

	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "  view error: %v\n", err)
	}
	return <-failed
}

// confinementMechanism reports how this platform can confine a run.
//
// Honest about absence: an unconfined run says so on screen rather than
// implying an isolation it does not have. Real enforcement lands in #36.
func confinementMechanism() string {
	if _, err := os.Stat("/usr/bin/sandbox-exec"); err == nil {
		return "sandbox-exec"
	}
	return "none"
}
