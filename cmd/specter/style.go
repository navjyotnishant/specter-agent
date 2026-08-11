package main

import (
	"fmt"
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
func bold(s string) string  { return colourise("1", s) }

// 256-colour rather than truecolour: every terminal emulator worth supporting
// handles 256, while 24-bit escapes render as literal garbage on the ones that
// do not. The gradient is violet into blue — cool, and distinct from the green
// and red that carry pass/fail meaning elsewhere.
//
// Attributes are composed into ONE escape rather than nested. bold(violet(s))
// would emit the inner reset first, ending the bold early and leaving a
// redundant second reset behind.
func violet(s string) string { return colourise("1;38;5;99", s) }
func indigo(s string) string { return colourise("1;38;5;62", s) }

// banner is the first thing a new user sees.
//
// Drawn only on a terminal. Piped or redirected, the art is noise in a log file
// and box-drawing characters can arrive as mojibake on a terminal that cannot
// render them, so the plain form carries exactly the same facts: what this is,
// and which version.
func banner() {
	if !useColour {
		fmt.Printf("specter %s\n\n", version)
		return
	}

	// Half-block glyphs rather than full ASCII art: they read as a wordmark at
	// one line per row and stay legible in a narrow terminal.
	fmt.Println()
	fmt.Println(violet("  ▄▀▀ █▀▄ ▄▀▀ ▄▀▀ ▀█▀ ▄▀▀ █▀▄"))
	fmt.Println(indigo("  ▀▄▄ █▀  █▄▄ ▀▄▄  █  ██▄ █▀▄"))
	fmt.Printf("\n  %s\n\n", dim("governed agent workflows · "+version))
}
