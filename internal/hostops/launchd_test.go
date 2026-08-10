// launchd service management.
//
// The plist's PURPOSE changed in this port. It used to keep the Python host
// runner alive; there is no host runner now, so it supervises `specter serve`
// itself — one binary, kept running across logins.
//
// Everything here is macOS-only and degrades on other platforms rather than
// pretending: reporting "installed: false" on Linux is honest, while an error
// would make the settings page look broken on a machine where the feature
// simply does not apply.
package hostops

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPlistPointsAtTheSpecterBinary(t *testing.T) {
	// Not at python3 and a script — that is what this port removes.
	svc := &Service{
		BinaryPath: "/usr/local/bin/specter",
		PlistPath:  filepath.Join(t.TempDir(), "com.specter.plist"),
		DBPath:     "/data/app.db",
		Addr:       "127.0.0.1:8000",
	}
	plist := svc.plistContent()

	if !strings.Contains(plist, "/usr/local/bin/specter") {
		t.Errorf("the plist does not launch the specter binary:\n%s", plist)
	}
	if strings.Contains(plist, "python3") || strings.Contains(plist, ".py") {
		t.Error("the plist still references Python")
	}
	for _, want := range []string{"serve", "/data/app.db", "127.0.0.1:8000"} {
		if !strings.Contains(plist, want) {
			t.Errorf("the plist is missing %q — the service would start with the wrong arguments", want)
		}
	}
	// KeepAlive is the entire point: a crashed backend must come back.
	if !strings.Contains(plist, "KeepAlive") {
		t.Error("no KeepAlive — a crashed backend would stay down")
	}
	if !strings.Contains(plist, "ThrottleInterval") {
		t.Error("no ThrottleInterval — a crash loop would spin without pause")
	}
}

func TestPlistEscapesPathsForXML(t *testing.T) {
	// A path containing & or < produces a plist launchd silently refuses to
	// parse, and the service simply never starts.
	svc := &Service{
		BinaryPath: "/opt/my & tools/specter",
		PlistPath:  filepath.Join(t.TempDir(), "x.plist"),
		DBPath:     "/data/<db>/app.db",
	}
	plist := svc.plistContent()

	if strings.Contains(plist, "my & tools") {
		t.Error("a raw ampersand was written into XML — launchd cannot parse the plist")
	}
	if strings.Contains(plist, "<db>") {
		t.Error("raw angle brackets were written into XML")
	}
	if !strings.Contains(plist, "&amp;") {
		t.Error("the ampersand was not escaped")
	}
}

func TestInstallWritesThePlistWhereLaunchdLooks(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd is macOS-only")
	}
	dir := t.TempDir()
	svc := &Service{
		BinaryPath: "/usr/local/bin/specter",
		PlistPath:  filepath.Join(dir, "nested", "com.specter.plist"),
		// A launchctl that succeeds without touching the real service manager.
		LaunchctlPath: writeExecutable(t, dir, "launchctl", `exit 0`),
	}

	result := svc.Install()
	if !result.OK {
		t.Fatalf("install failed: %s", result.Message)
	}
	// The parent directory may not exist on a fresh machine.
	if _, err := os.Stat(svc.PlistPath); err != nil {
		t.Errorf("the plist was not written: %v", err)
	}
}

func TestAFailedLaunchctlLoadIsReportedNotSwallowed(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd is macOS-only")
	}
	dir := t.TempDir()
	svc := &Service{
		BinaryPath:    "/usr/local/bin/specter",
		PlistPath:     filepath.Join(dir, "com.specter.plist"),
		LaunchctlPath: writeExecutable(t, dir, "launchctl", `echo "Load failed: 5: Input/output error" >&2; exit 1`),
	}

	result := svc.Install()
	if result.OK {
		t.Error("a failed launchctl load reported success — the UI would show a service that is not running")
	}
	if !strings.Contains(result.Message, "Input/output error") {
		t.Errorf("launchctl's own error was not surfaced: %q", result.Message)
	}
}

func TestUninstallRemovesThePlist(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("launchd is macOS-only")
	}
	dir := t.TempDir()
	plist := filepath.Join(dir, "com.specter.plist")
	os.WriteFile(plist, []byte("<plist/>"), 0o644)

	svc := &Service{
		PlistPath:     plist,
		LaunchctlPath: writeExecutable(t, dir, "launchctl", `exit 0`),
	}
	if result := svc.Uninstall(); !result.OK {
		t.Fatalf("uninstall failed: %s", result.Message)
	}
	if _, err := os.Stat(plist); !os.IsNotExist(err) {
		t.Error("the plist survived uninstall — the service would return on next login")
	}
}

func TestUninstallingWhenNothingIsInstalledSucceeds(t *testing.T) {
	// The caller wants it gone, and it is gone.
	dir := t.TempDir()
	svc := &Service{
		PlistPath:     filepath.Join(dir, "absent.plist"),
		LaunchctlPath: writeExecutable(t, dir, "launchctl", `exit 1`),
	}
	if result := svc.Uninstall(); !result.OK {
		t.Errorf("uninstalling an absent service failed: %s", result.Message)
	}
}

func TestStatusReportsNotInstalledWithoutAPlist(t *testing.T) {
	dir := t.TempDir()
	svc := &Service{
		PlistPath:     filepath.Join(dir, "absent.plist"),
		LaunchctlPath: writeExecutable(t, dir, "launchctl", `exit 1`),
	}
	status := svc.Status()
	if status.Installed {
		t.Error("reported installed with no plist on disk")
	}
	if status.Running {
		t.Error("reported running while not installed")
	}
}

func TestStatusOnAnUnsupportedPlatformIsHonest(t *testing.T) {
	// Reporting "not installed" beats an error: on Linux the feature does not
	// apply, and an error makes the settings page look broken.
	svc := &Service{PlistPath: filepath.Join(t.TempDir(), "x.plist"), LaunchctlPath: "/nonexistent/launchctl"}
	status := svc.Status()
	if status.Running {
		t.Error("reported running with no launchctl available")
	}
}
