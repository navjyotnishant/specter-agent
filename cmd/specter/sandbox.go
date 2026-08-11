package main

import (
	"fmt"
	"strings"

	"github.com/navjyotnishant/specter-agent/internal/hostops"
)

// sandboxSummary reports the Docker Sandbox runtime for `specter status`.
//
// The web UI has shown this since the Models page existed; the CLI did not,
// which is the same web/terminal split that hid model discovery. One prober,
// both surfaces.
func sandboxSummary() {
	status := (&hostops.Sandbox{}).Status()

	section("docker sandbox", "an optional runtime — agents in a disposable microVM")

	if !status.Installed {
		// Not a failure. Docker Sandbox is optional — agents run directly unless
		// a node asks for the sandbox runtime — so an absent one is reported as
		// absent, not as a problem.
		fmt.Printf("    %s  %s\n", none(pad("sbx")), dim("not installed — optional; "+status.InstallCommand))
		return
	}

	detail := shorten(status.ExecutablePath)
	if status.Version != "" {
		detail += dim("  " + shortVersion(status.Version))
	}

	if status.DaemonRunning {
		fmt.Printf("    %s  %s\n", ok(pad("sbx")), dim(detail))
		return
	}
	// Installed but not running is the ACTIONABLE state: a sandbox node will
	// fail until the daemon is up, and the command to fix it goes on the line.
	fmt.Printf("    %s  %s\n", warn(pad("sbx")), dim(detail))
	fmt.Printf("    %s\n", amber("daemon not running — start it with: sbx daemon start"))
}

// shortVersion trims `sbx version: v0.34.0 <long git sha>` to the version.
func shortVersion(s string) string {
	fields := strings.Fields(s)
	if len(fields) == 0 {
		return s
	}
	// `sbx version: v0.34.0 <sha>` — the version is the field starting "v"
	// followed by a digit. Matching a bare "v" prefix picked up the literal word
	// "version:" and printed it as the version.
	for _, f := range fields {
		if len(f) > 1 && f[0] == 'v' && f[1] >= '0' && f[1] <= '9' {
			return f
		}
	}
	return fields[len(fields)-1]
}
