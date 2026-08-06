package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/navjyotnishant/specter-agent/internal/confine"
	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/graph"
	"github.com/navjyotnishant/specter-agent/internal/publish"
	"github.com/navjyotnishant/specter-agent/internal/store"
	"github.com/navjyotnishant/specter-agent/internal/worktree"
)

// runWorkflow executes every node in dependency order.
//
// In-process: no server, no daemon, no HTTP. Progress is written to the same
// database the web UI reads, so the run is visible there as it happens without
// the two ever talking to each other.
func runWorkflow(dbPath, workflowRef, workspace string, timeout time.Duration, asJSON, write bool) error {
	db, err := store.Open(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	// Read by the deferred worktree cleanup below: a failed run keeps its
	// checkout so the failure can be examined.
	var failedRun bool

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

	// The agent works on its own checkout, never the repository the user is in.
	// A bad run costs a discarded directory rather than uncommitted work.
	//
	// The run id is the token, so a worktree left behind after a failure is
	// traceable back to the run that produced it.
	// Read-only unless asked otherwise. An agent that can edit by default is one
	// bad prompt away from changing something nobody reviewed.
	mode := worktree.ModeReadOnly
	if write {
		mode = worktree.ModeReadWrite
	}
	wt, err := worktree.Prepare(approved, "run-"+runID[:8], mode)
	if err != nil {
		_ = db.CompleteRun(ctx, runID, "failed", "")
		return fmt.Errorf("preparing an isolated checkout: %w", err)
	}
	// Retained on failure so it can be inspected; Reap clears the backlog.
	defer func() {
		if !failedRun {
			_ = wt.Remove()
		}
	}()

	jobs := exec.NewJobs()
	jobs.SetLogger(func(level, message string) {
		_ = db.AppendLog(ctx, runID, level, message)
	})

	// Two presentations of one run. The tree redraws in place and needs a
	// terminal; piped output must stay line-oriented so it greps and appends to
	// a log file cleanly. Same execution either way — only the reporting differs.
	var failed bool
	if asJSON {
		failed = runQuiet(ctx, db, jobs, runID, wt.Path, order, timeout, write)
	} else if useColour {
		failed = runWithLiveView(ctx, db, jobs, runID, workflow.Name, approved, wt, order, timeout, write)
	} else {
		failed = runPlain(ctx, db, jobs, runID, workflow.Name, wt.Path, order, timeout, write)
	}
	failedRun = failed

	status := "completed"
	if failed {
		status = "failed"
	}

	// A successful write run becomes a branch and a pull request. Never a commit
	// on the branch the user is standing on -- the whole point is that the work
	// is reviewed before it is theirs.
	var published publish.Result
	if write && !failed && ctx.Err() == nil {
		published = publishRun(wt, workflow.Name, order)
		// The branch is the work. Keep the worktree so nothing is lost if the
		// push or the PR failed.
		if published.Committed && published.PullRequest == "" {
			failedRun = true
		}
	}
	if ctx.Err() != nil {
		status = "cancelled"
	}
	if err := db.CompleteRun(ctx, runID, status, ""); err != nil {
		// The run itself finished; only the record is incomplete. Say so rather
		// than reporting the run as failed.
		fmt.Fprintf(os.Stderr, "  warning: could not record completion: %v\n", err)
	}

	if asJSON {
		steps, _ := db.Steps(ctx, runID)
		payload := map[string]any{
			"run_id":    runID,
			"workflow":  workflow.Name,
			"status":    status,
			"workspace": approved,
			"steps":     steps,
		}
		if write {
			payload["published"] = published
		}
		out, err := json.MarshalIndent(payload, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(out))
	} else {
		fmt.Printf("\n  %s · %s\n", status, dim(runID))
		reportPublished(published)
		fmt.Println()
	}

	// Exit code carries the verdict for a script that does not parse the output.
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
	allowWrite bool,
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

	// Defence in depth. --permission-mode plan is the agent's OWN guardrail and
	// is advisory -- an agent can shell out past it. The OS profile is not.
	// Neither alone is sufficient.
	// plan is read-only; acceptEdits lets the agent write. Advisory either way --
	// an agent can shell out past its own flag -- which is why the OS profile
	// below is the boundary that actually holds.
	permission := "plan"
	if allowWrite {
		permission = "acceptEdits"
	}
	argv := []string{agentPath, "--permission-mode", permission, "-p", prompt}
	confined, info, err := confine.Wrap(argv, workspace)
	if err != nil {
		_ = db.CompleteStep(ctx, stepID, "failed")
		return err
	}
	if info.Mechanism == confine.MechanismNone {
		// Said out loud rather than left implicit: a run nobody knows is
		// unconfined is the failure this whole layer exists to prevent.
		jobs.Append(stepID, "warning: running unconfined — "+info.Reason)
	}

	result := exec.RunStreaming(nodeCtx, exec.Command{
		Argv:    confined,
		Dir:     workspace,
		Env:     confine.Env(os.Environ(), workspace),
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
	asJSON := flags.Bool("json", false, "emit a machine-readable result")
	write := flags.Bool("write", false, "allow the agent to change files, and open a pull request with the result")
	// Go's flag package stops parsing at the first positional argument, so
	// `specter run my-workflow --json` would silently ignore every flag — the
	// run proceeds against the wrong repo, unconfined, with no warning. People
	// type the workflow name first; reorder rather than making them learn this.
	if err := flags.Parse(reorderFlagsFirst(args)); err != nil {
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
	return runWorkflow(*dbPath, flags.Arg(0), workspace, *timeout, *asJSON, *write)
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
	order []graph.Node, timeout time.Duration, allowWrite bool,
) bool {
	fmt.Printf("\n  %s\n  %s\n\n", name, workspace)
	for _, node := range order {
		if err := runNode(ctx, db, jobs, runID, node, workspace, timeout, allowWrite, nil); err != nil {
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
	wt *worktree.Worktree, order []graph.Node, timeout time.Duration, allowWrite bool,
) bool {
	model := newRunModel(name, workspace, confinementMechanism(), "read-only", wt.Describe(), order)
	// WithAltScreen: the view redraws in place on its own screen and restores the
	// terminal afterwards, so a multi-minute run does not leave hundreds of
	// spinner frames scrolled into the user's scrollback.
	program := tea.NewProgram(model, tea.WithAltScreen())

	failed := make(chan bool, 1)
	go func() {
		anyFailed := false
		for i, node := range order {
			program.Send(nodeStartedMsg{index: i})

			err := runNode(ctx, db, jobs, runID, node, wt.Path, timeout, allowWrite, func(line string) {
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
	return string(confine.Detect().Mechanism)
}

// runQuiet executes without any progress output at all.
//
// For --json: a machine reading the result wants one object on stdout, not a
// tree or a log interleaved with it.
func runQuiet(
	ctx context.Context, db *store.Store, jobs *exec.Jobs, runID, workspace string,
	order []graph.Node, timeout time.Duration, allowWrite bool,
) bool {
	for _, node := range order {
		if err := runNode(ctx, db, jobs, runID, node, workspace, timeout, allowWrite, nil); err != nil {
			return true
		}
	}
	return false
}

// reorderFlagsFirst moves flags ahead of positional arguments.
//
// Go's flag package stops at the first non-flag, so `run wf --json` parses
// nothing. Silently ignoring --repo would run against the wrong directory, which
// is a correctness problem rather than a usability one.
func reorderFlagsFirst(args []string) []string {
	var flagArgs, positional []string

	// Flags that take a value, so the value is not mistaken for a positional.
	takesValue := map[string]bool{"--repo": true, "-repo": true, "--timeout": true,
		"-timeout": true, "--db": true, "-db": true}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			positional = append(positional, arg)
			continue
		}
		flagArgs = append(flagArgs, arg)
		// --repo=/path carries its own value; --repo /path takes the next arg.
		if takesValue[arg] && !strings.Contains(arg, "=") && i+1 < len(args) {
			i++
			flagArgs = append(flagArgs, args[i])
		}
	}
	return append(flagArgs, positional...)
}

// publishRun turns a completed write run into a reviewable pull request.
//
// Every step degrades rather than failing: the branch exists locally either way,
// so a push or PR that cannot happen leaves the work recoverable and says how.
// Losing an agent's output because gh was missing would be the worst outcome
// here.
func publishRun(wt *worktree.Worktree, workflowName string, order []graph.Node) publish.Result {
	if wt.Branch == "" {
		return publish.Result{Manual: "this run had no branch, so there is nothing to publish"}
	}

	objective := workflowName
	if len(order) > 0 {
		objective = order[0].Data.Objective
	}

	result, err := publish.Commit(wt.Path, wt.Branch, objective)
	if err != nil {
		return publish.Result{Manual: fmt.Sprintf("could not commit: %v", err)}
	}
	if !result.Committed {
		// A legitimate outcome: the agent decided nothing needed changing.
		return result
	}

	remote, err := publish.Push(wt.Path, wt.Branch)
	if err != nil {
		result.Manual = fmt.Sprintf("committed to %s but could not push: %v", wt.Branch, err)
		return result
	}
	result.PushedTo = remote

	title := fmt.Sprintf("%s: %s", workflowName, firstLineOf(objective))
	body := fmt.Sprintf(
		"Produced by a Specter agent run.\n\n**Workflow:** %s\n**Objective:** %s\n\n"+
			"Opened as a draft. Review the diff before marking it ready.\n",
		workflowName, objective)

	url, err := publish.OpenPR(wt.Path, wt.Branch, title, body)
	if err != nil {
		result.Manual = fmt.Sprintf("pushed %s — open a PR from it (%v)", wt.Branch, err)
		return result
	}
	result.PullRequest = url
	return result
}

func reportPublished(result publish.Result) {
	switch {
	case result.PullRequest != "":
		fmt.Printf("  %s %s\n", green("→"), result.PullRequest)
	case result.Manual != "":
		fmt.Printf("  %s %s\n", dim("→"), result.Manual)
	case result.Branch != "" && !result.Committed:
		fmt.Printf("  %s\n", dim("no changes to publish"))
	}
}

func firstLineOf(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if len(line) > 60 {
		line = line[:60]
	}
	return line
}
