// bubblewrap invocation — the Linux mechanism.
//
// Same policy as darwin.go expressed in a different mechanism: read-only bind
// of the whole filesystem, then selectively re-bind what must be writable.
package isolation

import (
	"os"
	"path/filepath"
)

// linuxCommand builds a bubblewrap invocation.
//
// UNTESTED. bwrap was not available on the development machine, so this is
// written from documentation rather than verified behaviour. Detect() reports
// bwrap only when the binary exists, and this path should be exercised on real
// Linux before being relied on.
func linuxCommand(argv []string, workspace string) ([]string, error) {
	workspace, err := resolve(workspace)
	if err != nil {
		return nil, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}

	args := []string{
		"bwrap",
		// The whole filesystem readable but not writable, so every toolchain
		// stays visible, then selectively re-bind what must be writable.
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		"--bind", workspace, workspace,
		"--bind", "/tmp", "/tmp",
	}

	for _, dir := range []string{".claude", ".codex", ".cursor", ".gemini", ".cache", ".npm"} {
		path := filepath.Join(home, dir)
		if _, err := os.Stat(path); err == nil {
			args = append(args, "--bind", path, path)
		}
	}

	// Empty tmpfs over the credential directories: present but empty, which
	// fails more gracefully than a missing path.
	for _, dir := range []string{".ssh", ".aws", ".gnupg", ".kube"} {
		args = append(args, "--tmpfs", filepath.Join(home, dir))
	}

	// Without this the wrapper survives a kill and the agent keeps running,
	// which would defeat the cancellation the engine depends on.
	args = append(args, "--die-with-parent", "--")
	return append(args, argv...), nil
}
