package hostops

import (
	"context"
	"encoding/xml"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// LaunchdLabel identifies the service to launchctl.
const LaunchdLabel = "com.specter.agent"

// Service manages the launchd job that keeps the backend running.
//
// The plist's PURPOSE changed in this port. It used to keep the Python host
// runner alive; there is no host runner now, so it supervises `specter serve`
// itself — one binary, kept running across logins, with nothing else to install.
type Service struct {
	BinaryPath    string
	PlistPath     string
	DBPath        string
	Addr          string
	LaunchctlPath string
}

type ServiceStatus struct {
	Installed bool   `json:"installed"`
	Running   bool   `json:"running"`
	PlistPath string `json:"plist_dst"`
	PIDLine   string `json:"pid_line"`
	Label     string `json:"label"`
	Supported bool   `json:"supported"`
	Message   string `json:"message"`
}

type ServiceResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

func DefaultPlistPath() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Library", "LaunchAgents", LaunchdLabel+".plist")
}

func (s *Service) launchctl() string {
	if s.LaunchctlPath != "" {
		return s.LaunchctlPath
	}
	return "launchctl"
}

// xmlEscape escapes a value for a plist string.
//
// Not cosmetic: a path containing & or < produces XML launchd silently refuses
// to parse, and the service then simply never starts — with no error anywhere
// pointing at the path.
func xmlEscape(value string) string {
	var out strings.Builder
	xml.EscapeText(&out, []byte(value))
	return out.String()
}

func (s *Service) plistContent() string {
	args := []string{s.BinaryPath, "serve"}
	if s.Addr != "" {
		args = append(args, "--addr", s.Addr)
	}
	if s.DBPath != "" {
		args = append(args, "--db", s.DBPath)
	}

	var argXML strings.Builder
	for _, arg := range args {
		fmt.Fprintf(&argXML, "        <string>%s</string>\n", xmlEscape(arg))
	}

	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>` + LaunchdLabel + `</string>
    <key>ProgramArguments</key>
    <array>
` + argXML.String() + `    </array>
    <key>StandardOutPath</key>
    <string>/tmp/specter-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/specter-agent.log</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
</dict>
</plist>
`
}

func (s *Service) run(timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, s.launchctl(), args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// Install writes the plist and loads it.
func (s *Service) Install() ServiceResult {
	// The LaunchAgents directory may not exist on a fresh machine.
	if err := os.MkdirAll(filepath.Dir(s.PlistPath), 0o755); err != nil {
		return ServiceResult{Message: "Could not create the LaunchAgents directory: " + err.Error()}
	}
	if err := os.WriteFile(s.PlistPath, []byte(s.plistContent()), 0o644); err != nil {
		return ServiceResult{Message: "Could not write the service file: " + err.Error()}
	}

	out, err := s.run(10*time.Second, "load", "-w", s.PlistPath)
	if err != nil {
		// Surfaced, not swallowed: reporting success here would show a running
		// service in the UI that is not running.
		message := out
		if message == "" {
			message = err.Error()
		}
		return ServiceResult{Message: "launchctl load failed: " + message}
	}
	return ServiceResult{OK: true,
		Message: "Specter is installed as a background service and will start automatically on login."}
}

// Uninstall unloads the job and removes the plist.
func (s *Service) Uninstall() ServiceResult {
	// The unload result is deliberately ignored: a job that was never loaded
	// makes launchctl exit non-zero, and the caller's intent is satisfied
	// either way.
	s.run(10*time.Second, "unload", "-w", s.PlistPath)

	if err := os.Remove(s.PlistPath); err != nil && !os.IsNotExist(err) {
		return ServiceResult{Message: "Could not remove the service file: " + err.Error()}
	}
	return ServiceResult{OK: true,
		Message: "Specter's background service was removed. It will no longer start automatically."}
}

// Restart kickstarts the job.
func (s *Service) Restart() ServiceResult {
	status := s.Status()
	if !status.Installed {
		return ServiceResult{Message: "Specter is not installed as a background service."}
	}
	out, err := s.run(10*time.Second, "kickstart", "-k", fmt.Sprintf("gui/%d/%s", os.Getuid(), LaunchdLabel))
	if err != nil {
		message := out
		if message == "" {
			message = err.Error()
		}
		return ServiceResult{Message: "launchctl kickstart failed: " + message}
	}
	return ServiceResult{OK: true, Message: "Specter's background service was restarted."}
}

// Status reports whether the service is installed and running.
//
// On a platform with no launchctl this reports "not installed" rather than
// erroring: on Linux the feature does not apply, and an error would make the
// settings page look broken on a machine where nothing is wrong.
func (s *Service) Status() ServiceStatus {
	status := ServiceStatus{PlistPath: s.PlistPath, Label: LaunchdLabel}

	if _, err := os.Stat(s.PlistPath); err == nil {
		status.Installed = true
	}

	out, err := s.run(5*time.Second, "print", fmt.Sprintf("gui/%d/%s", os.Getuid(), LaunchdLabel))
	if err == nil {
		status.Running = true
		status.Supported = true
		for _, line := range strings.Split(out, "\n") {
			if strings.Contains(strings.ToLower(line), "pid") {
				status.PIDLine = strings.TrimSpace(line)
				break
			}
		}
	} else if _, lookErr := exec.LookPath(s.launchctl()); lookErr != nil {
		status.Message = "Background service management is only available on macOS."
	} else {
		status.Supported = true
	}
	return status
}
