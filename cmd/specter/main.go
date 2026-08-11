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
  --write                    let the agent change files, and open a pull request
  --allow-host <hosts>       extra hosts the agent may reach, comma-separated
  --deny-host <hosts>        hosts it may not reach — wins over every allow

The default policy already allows the model APIs, GitHub and the package
registries. --allow-host adds to that rather than replacing it.

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
