package confine

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
)

// A boundary probe against the REAL home directory, run explicitly:
//
//	go test ./internal/confine/ -run TestBoundaryAgainstRealHome -v -tags manual
//
// Kept out of the default run because it touches real paths — ~/.ssh, ~/Desktop
// — rather than a temp fixture. That is exactly why it is worth having: the unit
// tests prove the profile denies a synthetic directory, and this proves it
// denies the things that actually matter.
func TestBoundaryAgainstRealHome(t *testing.T) {
	if os.Getenv("SPECTER_BOUNDARY_PROBE") == "" {
		t.Skip("set SPECTER_BOUNDARY_PROBE=1 to run against real home paths")
	}
	requireMacOS(t)

	workspace, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	home, _ := os.UserHomeDir()

	probes := []struct {
		name      string
		script    string
		wantAllow bool
	}{
		{"write inside the workspace", "echo ok > " + workspace + "/.specter-probe.txt", true},
		{"write to ~/Desktop", "echo pwned > " + home + "/Desktop/pwned.txt", false},
		{"read ~/.ssh", "ls " + home + "/.ssh", false},
		{"git still works", "git --version", true},
		// A file this test knows exists: go test runs in the package directory,
		// so the repository root is not the working directory.
		{"reading the workspace is allowed", "head -1 " + workspace + "/confine.go", true},
		// G5 depends on this: ~/.ssh is denied, so the PR path must authenticate
		// some other way. gh keeps its token in the macOS keyring, not on disk.
		{"gh stays authenticated", "gh auth status", true},
	}

	for _, probe := range probes {
		t.Run(probe.name, func(t *testing.T) {
			argv, info, err := Wrap([]string{"sh", "-c", probe.script}, workspace)
			if err != nil {
				t.Fatal(err)
			}
			result := exec.RunStreaming(context.Background(), exec.Command{
				Argv: argv, Dir: workspace, Env: Env(os.Environ(), workspace),
				Timeout: 15 * time.Second,
			})
			if result.OK() != probe.wantAllow {
				t.Fatalf("[%s] allowed=%v want=%v  %s",
					info.Mechanism, result.OK(), probe.wantAllow, result.Stderr)
			}
			t.Logf("[%s] %s → %v", info.Mechanism, probe.name, map[bool]string{true: "allowed", false: "DENIED"}[result.OK()])
		})
	}

	os.Remove(workspace + "/.specter-probe.txt")
}
