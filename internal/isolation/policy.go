// The policy Specter enforces, separate from the mechanism that applies it.
//
// Author: Navjyot Nishant
// Created: 2026-08-11
// Last updated: 2026-08-11
// Description: what an agent may read, write and reach — expressed once, per platform.
//
// WHY POLICY IS OURS AND ENFORCEMENT IS NOT
// The enforcement primitives are kernel features: Seatbelt on macOS, namespaces
// and seccomp on Linux. Those are audited by people whose full-time job that is,
// and a hand-rolled replacement that is subtly wrong looks identical to one that
// works — right up until it does not. So Specter drives them rather than
// reimplementing them.
//
// What Specter owns is the POLICY: which paths, which domains, and what happens
// when a boundary cannot be established. That is the part specific to running
// someone else's coding agent against your repository, and the part no general
// sandbox can decide on your behalf.
//
// Keeping it in one file means the rules can be read AS rules. Spread across
// dispatch code they become invisible, and an invisible security policy is one
// nobody reviews.
package isolation

import (
	"os"
	"path/filepath"
)

// Policy is what an agent may do during one run.
//
// Built per run rather than configured globally, because the interesting
// boundary — the worktree — is different every time.
type Policy struct {
	// Workspace is the one directory the agent may write to. Everything below
	// is expressed relative to the fact that this is the only writable place.
	Workspace string

	// WritablePaths are additional directories the agent may write to.
	//
	// These exist because denying them produces confusing failures rather than
	// security: npm, pip and cargo write to their caches constantly, and the
	// agent CLIs write their own session state. An agent that cannot write
	// ~/.npm fails in a way that looks nothing like confinement, and the user
	// disables confinement to make it work — which is the worst outcome.
	WritablePaths []string

	// UnreadablePaths are denied outright. Writes alone are not enough: with
	// only write denials, an agent can still read every private key on the
	// machine. Verified, and the reason this field exists separately.
	UnreadablePaths []string

	// AllowedDomains, when non-empty, is the only network the agent may reach.
	// Empty means unrestricted — which is the current behaviour and is stated
	// plainly rather than implied, because "no policy" and "deny all" are
	// opposite defaults and confusing them is how a boundary silently vanishes.
	AllowedDomains []string
}

// DefaultPolicy is what a run gets when nothing overrides it.
//
// Deliberately NOT deny-everything. A coding agent needs its toolchain, and a
// policy so tight that users turn it off protects nothing. The line drawn here:
// writes are confined to the worktree and the caches tools genuinely need,
// credentials are unreadable, and everything else is left alone.
func DefaultPolicy(workspace string) Policy {
	home, _ := os.UserHomeDir()

	return Policy{
		Workspace: workspace,

		// Agent state, then toolchain caches. Both are written during a normal
		// run; neither is a credential store.
		WritablePaths: prefixed(home,
			".claude", ".codex", ".cursor", ".gemini", ".config/gh",
			".cache", ".npm", ".config", ".local/state", ".gitconfig",
		),

		// The credential directories. This list is the one part of the policy
		// that should only ever grow.
		UnreadablePaths: prefixed(home, ".ssh", ".aws", ".gnupg", ".kube"),
	}
}

func prefixed(base string, names ...string) []string {
	out := make([]string, 0, len(names))
	for _, name := range names {
		out = append(out, filepath.Join(base, name))
	}
	return out
}

// NetworkRestricted reports whether this policy bounds the network.
//
// Currently always false: sandbox-exec can express network rules, but they are
// undocumented and deprecated, so a policy built on them would be guesswork
// dressed as a boundary. Domain filtering belongs in a CONNECT-level proxy that
// this package can point an agent at — see the network work tracked separately.
//
// Reported rather than assumed, so `specter status` can say which boundaries are
// real instead of implying the whole machine is contained.
func (p Policy) NetworkRestricted() bool {
	return len(p.AllowedDomains) > 0
}
