package exec

import (
	"os"
	"os/exec"
	"path/filepath"
)

// Locating agent CLIs on the host.
//
// WHY THIS IS NOT JUST exec.LookPath
// Under launchd the host process inherits PATH=/usr/bin:/bin:/usr/sbin:/sbin —
// none of the places a developer's CLIs live. LookPath alone therefore reports
// every Homebrew- and npm-installed agent as "not installed" while it sits in
// /opt/homebrew/bin. The explicit roots below are the fix, and the reason this
// is a file rather than a one-liner.

// CLIInstallRoots is where CLIs actually live, in the order to try. Homebrew
// first: on macOS it is where nearly everything lands.
func CLIInstallRoots() []string {
	roots := []string{"/opt/homebrew/bin", "/usr/local/bin"}
	if home, err := os.UserHomeDir(); err == nil {
		roots = append(roots,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, "bin"),
		)
	}
	return roots
}

// ResolveCLI returns the first match for any of names, or "".
//
// Several names because a CLI can ship under more than one — cursor-agent and
// cursor are the same tool. PATH is tried first so a developer's own build wins;
// the roots are the launchd fallback.
func ResolveCLI(names []string, roots []string) string {
	if roots == nil {
		roots = CLIInstallRoots()
	}
	for _, name := range names {
		if found, err := exec.LookPath(name); err == nil {
			return found
		}
		for _, root := range roots {
			candidate := filepath.Join(root, name)
			info, err := os.Stat(candidate)
			if err != nil || info.IsDir() {
				continue
			}
			// Executable bit, or "not installed" surfaces later as a confusing
			// "permission denied" from the spawn.
			if info.Mode().Perm()&0o111 != 0 {
				return candidate
			}
		}
	}
	return ""
}

func ClaudePath() string { return ResolveCLI([]string{"claude"}, nil) }
func CursorPath() string { return ResolveCLI([]string{"cursor-agent", "cursor"}, nil) }
func GeminiPath() string { return ResolveCLI([]string{"gemini"}, nil) }
func CodexPath() string  { return ResolveCLI([]string{"codex"}, nil) }
