// Seatbelt profile generation — the macOS mechanism.
//
// Named for the mechanism rather than the platform (seatbelt.go, not darwin.go)
// because these files are NOT build-tagged: they compile everywhere, and
// Detect() picks between them at runtime. A _darwin.go suffix would imply a
// compile-time split that does not exist, and Go would enforce it.
//
// The policy Specter enforces lives here — sandbox-exec is only the mechanism
// that applies it. Keeping profile construction in its own file makes the rules
// reviewable as rules, rather than buried in dispatch code.
package isolation

import (
	"fmt"
	"os"
	"strings"
)

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

	// Read from the policy rather than repeating it. Two copies of a security
	// rule drift, and the copy nobody edits is the one still being enforced.
	policy := DefaultPolicy(workspace)
	for _, dir := range policy.WritablePaths {
		fmt.Fprintf(&b, "(allow file-write* (subpath %q))\n", dir)
	}

	// LAST, so it wins over the denies above. Temp lives inside the workspace
	// (see TempDir) rather than in a shared root a confined agent could use to
	// reach another run.
	fmt.Fprintf(&b, "\n(allow file-write* (subpath %q))\n", workspace)

	// Reads. Writes alone are not enough: with only deny file-write*, an agent
	// can still read every private key on the machine. Verified.
	b.WriteString("\n")
	for _, dir := range policy.UnreadablePaths {
		fmt.Fprintf(&b, "(deny file-read* (subpath %q))\n", dir)
	}

	return b.String(), nil
}
