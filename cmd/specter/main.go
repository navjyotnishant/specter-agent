// Command specter runs Specter workflows from a terminal.
//
// It executes in-process: no server to start, no daemon to keep alive, no
// interpreter to install. Runs are written to the same database the web UI reads,
// so a CLI-started run is visible in the app without the two ever talking.
package main

import (
	"fmt"
	"os"
	osexec "os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/confine"
	"github.com/navjyotnishant/specter-agent/internal/exec"
	"github.com/navjyotnishant/specter-agent/internal/specterhome"
)

// Set at build time: -ldflags "-X main.version=…"
var version = "dev"

func main() {
	if len(os.Args) < 2 {
		welcome()
		return
	}

	switch os.Args[1] {
	case "run":
		if err := cmdRun(os.Args[2:]); err != nil {
			// Errors go to stderr so --json keeps stdout parseable, and the
			// exit code carries the verdict for scripts that read neither.
			fmt.Fprintf(os.Stderr, "\n  %s %v\n\n", red("✗"), err)
			os.Exit(1)
		}
	case "serve":
		if err := cmdServe(os.Args[2:]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "workflows", "ls":
		if err := cmdWorkflows(); err != nil {
			fmt.Fprintf(os.Stderr, "  %v\n", err)
			os.Exit(1)
		}
	case "--version", "-v", "version":
		fmt.Printf("specter %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "status":
		status()
	case "agent-host":
		if err := cmdAgentHost(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "  %v\n", err)
			os.Exit(1)
		}
	case "models":
		if err := cmdModels(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "  %v\n", err)
			os.Exit(1)
		}
	case "help", "--help", "-h":
		usage()
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

// welcome answers "what can this machine do right now" rather than printing a
// wall of help. A new user's first question is whether their agents are usable,
// not which flags exist.
func welcome() {
	banner()
	status()
	// The two things this binary does, named on the first screen. Making
	// someone run `help` to discover that it also serves the API hides half the
	// product from a new user.
	fmt.Println("\n  specter run <workflow>    run a workflow here")
	fmt.Println("  specter serve            serve the API and web UI")
	fmt.Println("  specter help             everything else")
}

func status() {
	fmt.Println("  agents")
	for _, agent := range []struct {
		name string
		path string
	}{
		{"claude", exec.ClaudePath()},
		{"codex", exec.CodexPath()},
		{"cursor", exec.CursorPath()},
		{"gemini", exec.GeminiPath()},
	} {
		if agent.path == "" {
			fmt.Printf("    %-8s not installed\n", agent.name)
			continue
		}
		fmt.Printf("    %-8s %s\n", agent.name, shorten(agent.path))
	}

	// Tools this binary shells out to but deliberately does not bundle. Naming
	// what each one ENABLES is the point: "gh: not installed" tells a user
	// nothing, while "write runs report the branch instead of opening a PR"
	// tells them exactly what they lose and whether they care.
	fmt.Println("\n  tools")
	for _, tool := range []struct {
		name string
		// What is LOST, not what is gained — this string is only ever printed
		// on the absent path, so it has to read as a consequence.
		without string
	}{
		{"git", "runs cannot take a worktree and the agent works in your checkout"},
		{"gh", "a write run reports its branch instead of opening a pull request"},
	} {
		// Plain PATH lookup is right here, unlike agent CLIs: git and gh are
		// system tools, not Homebrew installs that launchd's stripped PATH
		// hides, so internal/exec's extra search roots buy nothing.
		if path, err := osexec.LookPath(tool.name); err == nil {
			fmt.Printf("    %-8s %s\n", tool.name, shorten(path))
			continue
		}
		fmt.Printf("    %-8s not installed — %s\n", tool.name, tool.without)
	}

	// Confinement is reported whether or not it is available. An unconfined run
	// that reads as confined is worse than one that admits it.
	fmt.Println("\n  confinement")
	if info := confine.Detect(); info.Mechanism == confine.MechanismNone {
		fmt.Printf("    none — %s\n", info.Reason)
		fmt.Println("    agents run unconfined; set SPECTER_REQUIRE_CONFINEMENT=1 to refuse instead")
	} else {
		fmt.Printf("    %s\n", info.Mechanism)
	}

	// Which files this invocation actually resolved. SPECTER_HOME moves five
	// state paths at once, so a user who set it — or who did not and wonders why
	// the CLI and the UI disagree — should not have to read the source to find
	// out where the database is.
	fmt.Println("\n  state")
	fmt.Printf("    %-8s %s\n", "home", shorten(specterhome.Dir()))
	fmt.Printf("    %-8s %s\n", "database", shorten(defaultDBPath()))

	fmt.Println("\n  approved repositories")
	config := exec.AllowlistPath()
	// Probing with the config path itself: it is never an approved workspace, so
	// a rejection is expected. What matters is WHICH rejection — "not
	// provisioned" and "not approved" are different states, and only the first
	// tells the user to start the backend.
	if _, reason := exec.ApprovedWorkspace(config, config); strings.Contains(reason, "no approved-workspace list") {
		fmt.Printf("    none — no allowlist at %s\n", shorten(config))
		fmt.Println("    start the Specter backend once to sync it")
	} else {
		fmt.Printf("    listed in %s\n", shorten(config))
	}

	modelSummary()
}

func usage() {
	fmt.Print(`specter — run Specter workflows from your terminal

  specter                    what this machine can do right now
  specter run <workflow>     run a workflow here
  specter workflows          what you can run
  specter status             agents, confinement, approved repositories
  specter models             what each installed agent can run
  specter agent-host         spawn agents for a containerized backend
  specter version            build information

Options for run
  --repo <path>              which repository to run against
  --timeout <duration>       per-node limit (default 10m)

Runs execute in this process. Nothing needs to be running first.
`)
}

// shorten replaces $HOME with ~ so paths stay readable in a narrow terminal.
func shorten(path string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if rel, err := filepath.Rel(home, path); err == nil && !strings.HasPrefix(rel, "..") {
		return "~/" + rel
	}
	return path
}
