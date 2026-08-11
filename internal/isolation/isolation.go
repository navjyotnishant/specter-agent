// Package isolation restricts what a running agent can reach.
//
// Before this, "no isolation" was literally true: an agent ran as the host user
// with the host user's credentials and full filesystem access, and the only
// acknowledgement was a warning banner. This makes the boundary real.
//
// It is a kernel-enforced boundary on the same kernel, not a virtual machine.
// That is proportionate for the actual threat — a confused agent following a bad
// prompt — and not sufficient for running genuinely untrusted code. The
// difference is stated rather than implied.
package isolation

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

// ResolveWorkspace decides whether a run may proceed, and where.
//
// CONFINEMENT IS THE GATE. Any repository may be run against, provided the
// agent can be confined to it — the OS boundary denies writes outside the
// worktree and reads of ~/.ssh, ~/.aws, ~/.gnupg and ~/.kube, which is a
// stronger promise than a list of paths someone remembered to approve.
//
// The approved-workspace list existed BECAUSE there was no confinement: it was
// the only thing standing between an agent and the wrong repository. With
// confinement applied that job is done, and requiring both means asking the user
// to register every repository for a boundary the OS is already enforcing.
//
// So the rule is one sentence: no confinement, no run. Not "warn and continue" —
// the whole premise of the product is running agents against your code, and
// doing that unconfined while printing a notice is the failure this layer exists
// to prevent. Windows has no mechanism today and is therefore refused rather
// than quietly downgraded.
//
// SPECTER_ALLOWLIST_ONLY=1 restores the old gate on top, for a shared or
// production machine where "any repo on this host" is too wide even confined.
func ResolveWorkspace(path string, allowlist func(string) (string, string)) (string, Info, error) {
	info := Detect()
	if info.Mechanism == MechanismNone {
		return "", info, fmt.Errorf(
			"agents cannot be confined on this machine (%s), so the run was refused. "+
				"Confinement is what keeps an agent inside its worktree and away from "+
				"your credentials", info.Reason)
	}

	// Opt-in tightening. Off by default: the OS boundary is the gate.
	if allowlistOnly() {
		approved, reason := allowlist(path)
		if approved == "" {
			return "", info, fmt.Errorf("%s", reason)
		}
		return approved, info, nil
	}

	resolved, err := resolve(path)
	if err != nil {
		return "", info, fmt.Errorf("resolving the workspace: %w", err)
	}
	return resolved, info, nil
}

// AllowlistOnlyEnv restores the approved-workspace requirement on top of
// confinement.
const AllowlistOnlyEnv = "SPECTER_ALLOWLIST_ONLY"

func allowlistOnly() bool {
	value := strings.ToLower(strings.TrimSpace(os.Getenv(AllowlistOnlyEnv)))
	return value == "1" || value == "true" || value == "yes"
}
