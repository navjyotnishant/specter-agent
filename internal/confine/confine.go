// Package confine restricts what a running agent can reach.
//
// Before this, "no isolation" was literally true: an agent ran as the host user
// with the host user's credentials and full filesystem access, and the only
// acknowledgement was a warning banner. This makes the boundary real.
//
// It is a kernel-enforced boundary on the same kernel, not a virtual machine.
// That is proportionate for the actual threat — a confused agent following a bad
// prompt — and not sufficient for running genuinely untrusted code. The
// difference is stated rather than implied.
package confine

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

type Mechanism string

const (
	MechanismSandboxExec Mechanism = "sandbox-exec" // macOS
	MechanismBubblewrap  Mechanism = "bwrap"        // Linux
	MechanismNone        Mechanism = "none"
)

const (
	sandboxExec = "/usr/bin/sandbox-exec"
	// RequireEnv makes an unconfined run fail instead of warning. Off by
	// default: turning it on by default would break every Windows and
	// bwrap-less Linux user on upgrade.
	RequireEnv = "SPECTER_REQUIRE_CONFINEMENT"
)

// Info describes what confinement is available, and why not when it is not.
type Info struct {
	Mechanism Mechanism `json:"mechanism"`
	Reason    string    `json:"reason,omitempty"`
}

// Detect reports the mechanism for this platform.
//
// Always names something, including MechanismNone. A caller must never have to
// guess whether confinement is active — an unconfined run that reads as confined
// is worse than one that admits it.
func Detect() Info {
	switch runtime.GOOS {
	case "darwin":
		if _, err := os.Stat(sandboxExec); err == nil {
			return Info{Mechanism: MechanismSandboxExec}
		}
		return Info{MechanismNone, "sandbox-exec is not present on this system"}
	case "linux":
		if path := lookPath("bwrap"); path != "" {
			return Info{Mechanism: MechanismBubblewrap}
		}
		return Info{MechanismNone, "bubblewrap (bwrap) is not installed"}
	default:
		return Info{MechanismNone, fmt.Sprintf("no confinement mechanism on %s", runtime.GOOS)}
	}
}

// Required reports whether an unconfined run should fail.
func Required() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(RequireEnv)))
	return value == "1" || value == "true" || value == "yes"
}

// Wrap returns argv wrapped in the platform's confinement, plus what was applied.
//
// With no mechanism available the command is returned unchanged and Info says
// so. Refusing to run would break platforms that have no equivalent; pretending
// would be a lie. Set SPECTER_REQUIRE_CONFINEMENT=1 to turn absence into a
// failure.
func Wrap(argv []string, workspace string) ([]string, Info, error) {
	if len(argv) == 0 {
		return nil, Info{}, fmt.Errorf("no command to run")
	}

	info := Detect()
	if info.Mechanism == MechanismNone {
		if Required() {
			return nil, info, fmt.Errorf(
				"%s is set but no confinement is available: %s", RequireEnv, info.Reason)
		}
		return argv, info, nil
	}

	switch info.Mechanism {
	case MechanismSandboxExec:
		profile, err := macOSProfile(workspace)
		if err != nil {
			return nil, info, err
		}
		return append([]string{sandboxExec, "-p", profile}, argv...), info, nil

	case MechanismBubblewrap:
		wrapped, err := linuxCommand(argv, workspace)
		if err != nil {
			return nil, info, err
		}
		return wrapped, info, nil
	}

	return argv, info, nil
}

// safeForProfile rejects paths that would break out of the s-expression.
//
// A path containing a quote or paren could close the string and inject policy —
// rewriting the very rules meant to contain the run. Rejected rather than
// escaped: escaping invites a subtle bug, and no legitimate repository path
// contains these.
func safeForProfile(path string) error {
	if strings.ContainsAny(path, `"()\`) {
		return fmt.Errorf("path contains characters unsafe for a sandbox profile: %s", path)
	}
	return nil
}

// resolve returns the fully-resolved absolute path.
//
// THE SHARPEST TRAP IN THIS PACKAGE. sandbox-exec matches on resolved paths, and
// /tmp is a symlink to /private/tmp on macOS. A profile written with the
// unresolved path silently permits everything it meant to deny — no error, no
// warning, no protection. Every path in a profile goes through here.
func resolve(path string) (string, error) {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		// A path that does not exist yet cannot be resolved; clean it so at
		// least "." and ".." are gone.
		resolved = filepath.Clean(path)
	}
	return filepath.Abs(resolved)
}

// macOSProfile builds a sandbox-exec profile scoped to one workspace.
//
// Structured as (allow default) then targeted denies rather than deny-by-default.
// A deny-by-default profile breaks node, git and every toolchain immediately, and
// keeping an allowlist of everything a build might touch is unmaintainable — the
// realistic outcome is that people turn it off.
func macOSProfile(workspace string) (string, error) {
	workspace, err := resolve(workspace)
	if err != nil {
		return "", fmt.Errorf("resolving workspace: %w", err)
	}
	if err := safeForProfile(workspace); err != nil {
		return "", err
	}

	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("locating home directory: %w", err)
	}
	home, err = resolve(home)
	if err != nil {
		return "", err
	}
	if err := safeForProfile(home); err != nil {
		return "", err
	}

	var b strings.Builder
	b.WriteString("(version 1)\n(allow default)\n\n")

	// ORDER MATTERS: sandbox-exec is last-match-wins, so every deny comes first
	// and the workspace allow comes last. Written the other way round, the deny
	// on the shared temp roots overrides the workspace itself whenever the
	// workspace happens to live under one -- which it does for every Go test
	// directory, and for any run whose repository sits in /tmp.
	fmt.Fprintf(&b, "(deny file-write* (subpath %q))\n", home)
	b.WriteString(`(deny file-write* (subpath "/private/tmp") (subpath "/private/var/folders"))` + "\n\n")

	// Agent state. These CLIs write session and history files as they run; deny
	// them and the agent fails for reasons that look nothing like confinement.
	for _, dir := range []string{".claude", ".codex", ".cursor", ".gemini", ".config/gh"} {
		fmt.Fprintf(&b, "(allow file-write* (subpath %q))\n", filepath.Join(home, dir))
	}

	// Toolchain caches. npm, pip and cargo write here constantly; denying them
	// produces confusing failures rather than security.
	for _, dir := range []string{".cache", ".npm", ".config", ".local/state", ".gitconfig"} {
		fmt.Fprintf(&b, "(allow file-write* (subpath %q))\n", filepath.Join(home, dir))
	}

	// LAST, so it wins over the denies above. Temp lives inside the workspace
	// (see TempDir) rather than in a shared root a confined agent could use to
	// reach another run.
	fmt.Fprintf(&b, "\n(allow file-write* (subpath %q))\n", workspace)

	// Reads. Writes alone are not enough: with only deny file-write*, an agent
	// can still read every private key on the machine. Verified.
	b.WriteString("\n")
	for _, dir := range []string{".ssh", ".aws", ".gnupg", ".kube"} {
		fmt.Fprintf(&b, "(deny file-read* (subpath %q))\n", filepath.Join(home, dir))
	}

	return b.String(), nil
}

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

func lookPath(name string) string {
	for _, dir := range []string{"/usr/bin", "/bin", "/usr/local/bin"} {
		candidate := filepath.Join(dir, name)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

// TempDir is the scratch directory for one confined run.
//
// Inside the workspace on purpose. Toolchains need somewhere to write, and the
// alternative — allowing a shared temp root — would let a confined agent write
// into another run's directory. Every Go temp dir lives under TMPDIR, so
// allowing TMPDIR re-opens precisely what the profile's deny closes.
func TempDir(workspace string) string {
	return filepath.Join(workspace, ".specter-tmp")
}

// Env returns the environment a confined command should run with.
//
// TMPDIR is redirected into the workspace so tools that honour it keep working
// under a profile that denies the shared temp roots.
func Env(base []string, workspace string) []string {
	tmp := TempDir(workspace)
	_ = os.MkdirAll(tmp, 0o700)

	out := make([]string, 0, len(base)+3)
	for _, entry := range base {
		if strings.HasPrefix(entry, "TMPDIR=") || strings.HasPrefix(entry, "TMP=") ||
			strings.HasPrefix(entry, "TEMP=") {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "TMPDIR="+tmp, "TMP="+tmp, "TEMP="+tmp)
}
