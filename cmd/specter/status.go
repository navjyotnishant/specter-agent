package main

import (
	"fmt"
	osexec "os/exec"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/hostops"
	"github.com/navjyotnishant/specter-agent/internal/isolation"
	"github.com/navjyotnishant/specter-agent/internal/models"
	"github.com/navjyotnishant/specter-agent/internal/specterhome"
)

// Marks carry meaning through the GLYPH, not the colour. Colour reinforces; it
// never carries the only signal — for colour-blind readers, and because piped
// output has no colour at all.
const (
	markOK   = "✓"
	markWarn = "!"
	markNone = "·"
)

func ok(label string) string   { return green(markOK) + " " + label }
func warn(label string) string { return amber(markWarn) + " " + label }
func none(label string) string { return dim(markNone + " " + label) }

// section prints a heading with a one-line explanation of what it answers, so
// the output teaches rather than just lists.
func section(title, subtitle string) {
	fmt.Printf("\n  %s  %s\n", bold(title), dim(subtitle))
}

// status answers "what can this machine do right now", leading with the verdict.
//
// The detail below it exists to explain the verdict, which is why every line
// that reports a problem also says what to do about it. A status page that
// reports a state without an action makes the reader go and find out.
func status() {
	agents := agentLines()
	fmt.Println()
	fmt.Printf("  %s\n", verdict(agents))

	section("agents", "who does the work")
	for _, line := range agents {
		fmt.Println("    " + line)
	}

	section("tools", "not bundled — they carry your credentials")
	for _, tool := range []struct{ name, without string }{
		{"git", "runs cannot take a worktree, so the agent works in your checkout"},
		{"gh", "a write run reports its branch instead of opening a pull request"},
	} {
		// Plain PATH lookup: git and gh are system tools, not Homebrew installs
		// that launchd's stripped PATH hides.
		if path, err := osexec.LookPath(tool.name); err == nil {
			fmt.Printf("    %s  %s\n", ok(pad(tool.name)), dim(shorten(path)))
			continue
		}
		fmt.Printf("    %s  %s\n", none(pad(tool.name)), dim("without it, "+tool.without))
	}

	wardenSummary()

	sandboxSummary()
	modelSummary()

	section("state", "where your runs and credentials live")
	fmt.Printf("    %s  %s\n", dim(pad("home")), shorten(specterhome.Dir()))
	fmt.Printf("    %s  %s\n", dim(pad("database")), shorten(defaultDBPath()))

	fmt.Println()
}

// verdict is the headline: can this machine run a workflow at all?
//
// First line rather than last, because it is the question being asked. Someone
// whose answer is "yes" should not have to read four sections to learn it.
func verdict(agents []string) string {
	ready := 0
	for _, line := range agents {
		if strings.Contains(line, markOK) {
			ready++
		}
	}
	switch {
	case ready == 0:
		return red("✗") + " " + bold("No agent is ready") +
			dim(" — install one, or sign in to one you have")
	case ready == 1:
		return green(markOK) + " " + bold("Ready") + dim(" — 1 agent can run")
	default:
		return green(markOK) + " " + bold("Ready") + dim(fmt.Sprintf(" — %d agents can run", ready))
	}
}

// agentLines reports each agent as its two layers: installed, and signed in.
// They are different questions, and an agent that is installed but signed out
// needs a different action from one that is absent.
func agentLines() []string {
	status := (&hostops.Prober{}).DirectCLIStatus()
	out := make([]string, 0, len(status.AgentStatus))
	for _, agent := range status.AgentStatus {
		switch {
		case !agent.Installed:
			out = append(out, fmt.Sprintf("%s  %s", none(pad(agent.Key)), dim("not installed")))
		case !agent.Authenticated:
			out = append(out, fmt.Sprintf("%s  %s", warn(pad(agent.Key)), amber(agent.AuthNote)))
		default:
			detail := shorten(agent.ExecutablePath)
			if agent.Version != "" {
				detail += dim("  " + firstLine(agent.Version))
			}
			out = append(out, fmt.Sprintf("%s  %s", ok(pad(agent.Key)), dim(detail)))
		}
	}
	return out
}

func pad(s string) string { return fmt.Sprintf("%-9s", s) }

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if len(line) > 34 {
		return line[:34]
	}
	return line
}

// modelSummary reports what each agent can actually run.
func modelSummary() {
	section("models", "discovered from each CLI, never hardcoded")
	for _, c := range models.All(false) {
		if c.Error != "" {
			fmt.Printf("    %s  %s\n", none(pad(c.Agent)), dim(c.Error))
			continue
		}
		fmt.Printf("    %s  %s  %s\n", ok(pad(c.Agent)),
			fmt.Sprintf("%3d available", len(c.Models)), dim(c.Source))
	}
}

// wardenSummary reports every boundary, including the ones that do not hold.
//
// Reporting only the good news is how `sandbox-exec ✓` came to sit above an
// execution path that applied no confinement at all. A reader needs to see the
// gaps to know what they are trusting.
func wardenSummary() {
	w := isolation.Warden()

	section("warden", "what stands between an agent and your machine")

	if !w.Active {
		fmt.Printf("    %s  %s\n", warn(pad("none")), dim(w.Reason))
		fmt.Printf("    %s\n", amber("agents run unconfined — SPECTER_REQUIRE_CONFINEMENT=1 refuses instead"))
		return
	}

	// Widest layer name sets the column, so the details line up whatever the
	// layer list grows to.
	width := 0
	for _, layer := range w.Layers {
		if len(layer.Name) > width {
			width = len(layer.Name)
		}
	}
	name := func(s string) string { return fmt.Sprintf("%-*s", width, s) }
	indent := strings.Repeat(" ", width+8)

	for _, layer := range w.Layers {
		if layer.Held {
			fmt.Printf("    %s  %s\n", ok(name(layer.Name)), dim(layer.Detail))
			continue
		}
		// The gap, not just the state. "reads: open" tells a reader nothing they
		// can act on; naming what is exposed does.
		fmt.Printf("    %s  %s\n", none(name(layer.Name)), dim(layer.Detail))
		if layer.Gap != "" {
			fmt.Printf("%s%s\n", indent, dim(layer.Gap))
		}
	}
}
