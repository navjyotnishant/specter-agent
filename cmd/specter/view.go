package main

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/navjyotnishant/specter-agent/internal/graph"
)

// The live run view: the workflow graph, redrawn in place as nodes change state.
//
// A run takes minutes. A wall of scrolling log lines answers "what is happening"
// but not "how far along is this" — the tree answers both, and mirrors the shape
// the user already knows from the builder.
//
// Only on a TTY. Piped output takes the line-oriented path in run.go instead,
// because a redrawing view in a log file is unreadable.

type nodeState int

const (
	stateQueued nodeState = iota
	stateRunning
	statePassed
	stateFailed
)

// Glyphs carry the meaning; colour only reinforces it. A colour-blind reader, a
// piped stream, and NO_COLOR all still get the state.
func (s nodeState) glyph() string {
	switch s {
	case stateRunning:
		return "●"
	case statePassed:
		return "✓"
	case stateFailed:
		return "✗"
	default:
		return "○"
	}
}

func (s nodeState) label() string {
	switch s {
	case stateRunning:
		return "running"
	case statePassed:
		return "passed"
	case stateFailed:
		return "failed"
	default:
		return "queued"
	}
}

type nodeView struct {
	name     string
	state    nodeState
	detail   string // the agent's latest progress line
	started  time.Time
	finished time.Time
}

func (n nodeView) elapsed() time.Duration {
	if n.started.IsZero() {
		return 0
	}
	if n.finished.IsZero() {
		return time.Since(n.started)
	}
	return n.finished.Sub(n.started)
}

// runModel is the Bubble Tea model for one workflow run.
type runModel struct {
	workflow    string
	workspace   string
	confinement string
	mode        string
	worktree    string
	nodes       []nodeView
	started     time.Time
	done        bool
	err         error
	spinnerAt   int
}

// Messages the executor sends as the run proceeds.
type (
	nodeStartedMsg  struct{ index int }
	nodeProgressMsg struct {
		index int
		line  string
	}
	nodeFinishedMsg struct {
		index int
		err   error
	}
	runFinishedMsg struct{ err error }
	tickMsg        time.Time
)

func newRunModel(workflow, workspace, confinement, mode, worktree string, nodes []graph.Node) runModel {
	views := make([]nodeView, len(nodes))
	for i, node := range nodes {
		views[i] = nodeView{name: node.Name()}
	}
	return runModel{
		workflow:    workflow,
		workspace:   workspace,
		confinement: confinement,
		mode:        mode,
		worktree:    worktree,
		nodes:       views,
		started:     time.Now(),
	}
}

func (m runModel) Init() tea.Cmd { return tick() }

// tick drives the spinner and the elapsed clock. 120ms is fast enough to read as
// motion and slow enough not to burn CPU on a run that takes minutes.
func tick() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m runModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		// Ctrl-C reaches the executor through the context; quitting here only
		// stops drawing. The run is cancelled by the signal handler, not by
		// tearing down the view.
		if msg.Type == tea.KeyCtrlC {
			return m, tea.Quit
		}

	case tickMsg:
		m.spinnerAt++
		if m.done {
			return m, tea.Quit
		}
		return m, tick()

	case nodeStartedMsg:
		m.nodes[msg.index].state = stateRunning
		m.nodes[msg.index].started = time.Now()

	case nodeProgressMsg:
		m.nodes[msg.index].detail = msg.line

	case nodeFinishedMsg:
		node := &m.nodes[msg.index]
		node.finished = time.Now()
		node.detail = ""
		if msg.err != nil {
			node.state = stateFailed
			node.detail = msg.err.Error()
		} else {
			node.state = statePassed
		}

	case runFinishedMsg:
		m.done = true
		m.err = msg.err
		return m, tea.Quit
	}
	return m, nil
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

var (
	styleDim    = lipgloss.NewStyle().Faint(true)
	styleGreen  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	styleRed    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	styleBlue   = lipgloss.NewStyle().Foreground(lipgloss.Color("4"))
	styleAmber  = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	styleBright = lipgloss.NewStyle().Bold(true)
)

func (m runModel) View() string {
	var b strings.Builder

	fmt.Fprintf(&b, "\n  %s%s\n\n",
		styleBright.Render(m.workflow),
		styleDim.Render(strings.Repeat(" ", max(1, 42-len(m.workflow)))+fmtDuration(time.Since(m.started))))

	for i, node := range m.nodes {
		branch := "├─"
		if i == len(m.nodes)-1 {
			branch = "└─"
		}

		glyph := node.state.glyph()
		switch node.state {
		case stateRunning:
			glyph = styleBlue.Render(spinnerFrames[m.spinnerAt%len(spinnerFrames)])
		case statePassed:
			glyph = styleGreen.Render(glyph)
		case stateFailed:
			glyph = styleRed.Render(glyph)
		default:
			glyph = styleDim.Render(glyph)
		}

		elapsed := ""
		if node.state != stateQueued {
			elapsed = fmtDuration(node.elapsed())
		}

		fmt.Fprintf(&b, "  %s %s %-24s %-10s %s\n",
			styleDim.Render(branch), glyph, node.name,
			styleDim.Render(node.state.label()), styleDim.Render(elapsed))

		// The agent's own words, indented under its node — the difference
		// between "something is happening" and knowing what.
		if node.detail != "" {
			detail := node.detail
			if len(detail) > 62 {
				detail = detail[:62] + "…"
			}
			continuation := "│"
			if i == len(m.nodes)-1 {
				continuation = " "
			}
			fmt.Fprintf(&b, "  %s     %s\n",
				styleDim.Render(continuation), styleDim.Render(detail))
		}
	}

	// Confinement and mode stay on screen DURING the run, not buried in a config
	// file. If a run is unconfined, that is visible while it happens rather than
	// discovered afterwards.
	confinement := styleGreen.Render(m.confinement)
	if m.confinement == "none" {
		confinement = styleAmber.Render("unconfined")
	}
	fmt.Fprintf(&b, "\n  %s %-22s %s %s\n",
		styleDim.Render("repo"), shorten(m.workspace),
		styleDim.Render("confined"), confinement)
	fmt.Fprintf(&b, "  %s %-22s %s %s\n\n",
		styleDim.Render("mode"), m.mode,
		styleDim.Render("worktree"), styleDim.Render(m.worktree))

	return b.String()
}

func fmtDuration(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	return fmt.Sprintf("%dm %02ds", int(d.Minutes()), int(d.Seconds())%60)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
