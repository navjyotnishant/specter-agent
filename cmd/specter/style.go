package main

import (
	"os"

	"golang.org/x/term"
)

// Colour is applied only when it can be seen and is wanted.
//
// Two rules, both of which the Python CLI got wrong: it emitted escape codes when
// piped, and ignored NO_COLOR entirely. Output that is read by another program
// must be plain, and a user who has asked for no colour has asked once for
// everything.
var useColour = term.IsTerminal(int(os.Stdout.Fd())) && os.Getenv("NO_COLOR") == ""

func colourise(code, text string) string {
	if !useColour {
		return text
	}
	return "\033[" + code + "m" + text + "\033[0m"
}

// Colour reinforces a glyph, never carries meaning alone — ✓ and ✗ are already
// distinguishable without it, for colour-blind readers and piped output alike.
func green(s string) string { return colourise("32", s) }
func red(s string) string   { return colourise("31", s) }
func dim(s string) string   { return colourise("2", s) }
