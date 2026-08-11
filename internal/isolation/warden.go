// The Warden — what stands between an agent and the rest of your machine.
//
// Author: Navjyot Nishant
// Created: 2026-08-11
// Last updated: 2026-08-11
// Description: names the boundaries, reports which hold, and says what is missing.
//
// WHY THIS IS ONE REPORT RATHER THAN SCATTERED CHECKS
// Isolation is four layers, not one, and the interesting question is never "is
// there a sandbox" — it is "which boundaries hold right now, and which do not".
// Answering that from four separate call sites produced the exact failure this
// file exists to prevent: a status line saying `sandbox-exec ✓` while runs
// started from the web app were not confined at all.
//
// So the Warden reports every layer, including the ones that are missing, and
// says which entry points apply them. A boundary someone assumes exists is worse
// than one they know is absent — the first gets trusted.
package isolation

import "strings"

// Layer is one boundary, and whether it currently holds.
type Layer struct {
	Name string `json:"name"`
	// Held is the only field a caller should branch on. Detail explains it.
	Held   bool   `json:"held"`
	Detail string `json:"detail"`
	// Gap names what is still exposed when a layer does NOT hold, so a reader
	// learns the consequence rather than only the state.
	Gap string `json:"gap,omitempty"`
}

// WardenStatus is every boundary at once.
type WardenStatus struct {
	// Active is whether a run can be confined AT ALL. False means, under the
	// confinement-is-the-gate rule, that runs are refused.
	Active    bool      `json:"active"`
	Mechanism Mechanism `json:"mechanism"`
	Reason    string    `json:"reason,omitempty"`
	Layers    []Layer   `json:"layers"`
}

// Warden reports what is protecting this machine right now.
//
// Deliberately reports the WHOLE picture, including layers that do not hold.
// Reporting only the good news is how `sandbox-exec ✓` came to sit above an
// unconfined execution path.
func Warden() WardenStatus {
	info := Detect()
	status := WardenStatus{
		Active:    info.Mechanism != MechanismNone,
		Mechanism: info.Mechanism,
		Reason:    info.Reason,
	}

	// Layer 1 — the OS boundary. The only one an agent cannot talk its way
	// past: a CLI's own --permission-mode flag is advisory, and an agent that
	// shells out ignores it.
	if status.Active {
		status.Layers = append(status.Layers, Layer{
			Name: "filesystem", Held: true,
			Detail: string(info.Mechanism) + " — writes confined to the worktree",
		})
	} else {
		status.Layers = append(status.Layers, Layer{
			Name: "filesystem", Held: false,
			Detail: info.Reason,
			Gap:    "an agent could write anywhere you can",
		})
	}

	// Layer 2 — credentials. Separate from the filesystem layer because write
	// denial alone leaves every private key on the machine readable. Verified,
	// and the reason this is its own line rather than a footnote.
	status.Layers = append(status.Layers, Layer{
		Name: "credentials", Held: status.Active,
		Detail: "~/.ssh, ~/.aws, ~/.gnupg, ~/.kube unreadable",
		Gap:    gapWhenUnheld(status.Active, "private keys and cloud credentials are readable"),
	})

	// Layer 3 — reads. Held only when confinement is active, because the
	// denial is expressed in the profile itself: $HOME is unreadable except for
	// the toolchain paths the policy re-allows.
	status.Layers = append(status.Layers, Layer{
		Name: "reads", Held: status.Active,
		Detail: "confined to the worktree; $HOME denied except toolchain paths",
		Gap:    gapWhenUnheld(status.Active, "an agent can read repositories you did not point it at"),
	})

	// Layer 4 — network. sandbox-exec can express network rules, but they are
	// undocumented and deprecated; a boundary built on them would be guesswork
	// dressed as containment.
	status.Layers = append(status.Layers, Layer{
		Name: "network", Held: false,
		Detail: "unrestricted",
		Gap:    "an agent can reach any host your machine can",
	})

	return status
}

func gapWhenUnheld(held bool, gap string) string {
	if held {
		return ""
	}
	return gap
}

// Summary is the one-line verdict, for a caller that has room for nothing else.
func (w WardenStatus) Summary() string {
	if !w.Active {
		return "unconfined — " + w.Reason
	}
	// Built from the layers rather than hardcoded, so it cannot fall out of
	// date the way this line already did once when reads became confined.
	held, open := []string{}, []string{}
	for _, layer := range w.Layers {
		if layer.Held {
			held = append(held, layer.Name)
		} else {
			open = append(open, layer.Name)
		}
	}
	summary := string(w.Mechanism) + " — " + strings.Join(held, ", ") + " held"
	if len(open) > 0 {
		summary += "; " + strings.Join(open, ", ") + " open"
	}
	return summary
}
