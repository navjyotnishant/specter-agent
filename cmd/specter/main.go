// Command specter runs Specter workflows from a terminal.
//
// It executes in-process: no server to start, no daemon to keep alive, no
// interpreter to install. Runs are written to the same database the web UI reads,
// so a CLI-started run is visible in the app without the two ever talking.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/exec"
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
	case "workflows", "ls":
		if err := cmdWorkflows(); err != nil {
			fmt.Fprintf(os.Stderr, "  %v\n", err)
			os.Exit(1)
		}
	case "--version", "-v", "version":
		fmt.Printf("specter %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "status":
		status()
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
	fmt.Printf("specter %s\n\n", version)
	status()
	fmt.Println("\n  specter help    what you can do")
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
}

func usage() {
	fmt.Print(`specter — run Specter workflows from your terminal

  specter                    what this machine can do right now
  specter run <workflow>     run a workflow here
  specter workflows          what you can run
  specter status             agents, confinement, approved repositories
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
