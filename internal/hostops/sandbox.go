package hostops

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
)

// PolicyValues are the only network policies that may be applied.
var PolicyValues = []string{"allow-all", "balanced", "deny-all"}

// Sandbox drives the Docker Sandboxes CLI (`sbx`).
type Sandbox struct {
	Roots   []string
	HomeDir string
	// DaemonWait bounds how long StartDaemon polls for readiness.
	DaemonWait time.Duration
}

type SandboxStatus struct {
	RuntimeID      string `json:"runtime_id"`
	DisplayName    string `json:"display_name"`
	Status         string `json:"status"`
	Available      bool   `json:"available"`
	Installed      bool   `json:"installed"`
	ExecutablePath string `json:"executable_path"`
	Version        string `json:"version"`
	DaemonRunning  bool   `json:"daemon_running"`
	Message        string `json:"message"`
	InstallCommand string `json:"install_command"`
	DocsURL        string `json:"docs_url"`
}

type PolicyStatus struct {
	OK              bool     `json:"ok"`
	Status          string   `json:"status"`
	CurrentPolicy   string   `json:"current_policy"`
	AvailablePolicy []string `json:"available_policies"`
	Message         string   `json:"message"`
	Diagnostic      string   `json:"diagnostic,omitempty"`
	Raw             string   `json:"raw,omitempty"`
}

type DaemonResult struct {
	OK      bool   `json:"ok"`
	Message string `json:"message"`
}

const defaultDaemonWait = 10 * time.Second

func (s *Sandbox) home() string {
	if s.HomeDir != "" {
		return s.HomeDir
	}
	home, _ := os.UserHomeDir()
	return home
}

func (s *Sandbox) executable() string {
	if len(s.Roots) > 0 {
		return execpkg.ResolveCLIIn([]string{"sbx"}, s.Roots)
	}
	return execpkg.ResolveCLI([]string{"sbx"}, nil)
}

func (s *Sandbox) run(timeout time.Duration, args ...string) execpkg.Result {
	exe := s.executable()
	if exe == "" {
		return execpkg.Result{ExitCode: -1, Err: "sbx is not installed"}
	}
	return execpkg.RunStreaming(context.Background(), execpkg.Command{
		Argv: append([]string{exe}, args...), Dir: s.home(), Timeout: timeout,
	})
}

func (s *Sandbox) Status() SandboxStatus {
	status := SandboxStatus{
		RuntimeID: "docker-sandbox", DisplayName: "Docker Sandbox Runtime",
		InstallCommand: "brew install docker/tap/sbx",
		DocsURL:        "https://docs.docker.com/ai/sandboxes/",
	}

	exe := s.executable()
	if exe == "" {
		status.Status = "missing"
		status.Message = "Docker Sandboxes CLI is not installed. Install it with: brew install docker/tap/sbx"
		return status
	}
	status.Installed = true
	status.ExecutablePath = exe
	status.Version = firstLine(s.run(5*time.Second, "--version").Stdout)

	status.DaemonRunning = s.DaemonRunning()
	if status.DaemonRunning {
		status.Status = "ready"
		status.Available = true
		status.Message = "Docker Sandbox is ready."
	} else {
		// Installed but not running is a DIFFERENT problem from not installed:
		// one is a button, the other is a download.
		status.Status = "setup_required"
		status.Message = "Docker Sandboxes is installed but its daemon is not running."
	}
	return status
}

// DaemonRunning asks the CLI whether a daemon is live.
func (s *Sandbox) DaemonRunning() bool {
	if s.executable() == "" {
		return false
	}
	result := s.run(10*time.Second, "daemon", "status")
	combined := strings.ToLower(result.Stdout + result.Stderr)
	return result.ExitCode == 0 && strings.Contains(combined, "running")
}

// StartDaemon launches the daemon DETACHED and polls for readiness.
//
// `sbx daemon start` runs in the FOREGROUND — it does not fork. Waiting on it
// blocks until the timeout and then kills the daemon that was just started,
// which is why starting it from the app appeared never to work. So it is
// spawned into its own process group and readiness is established by polling
// `daemon status` instead of by waiting for an exit that never comes.
func (s *Sandbox) StartDaemon() DaemonResult {
	exe := s.executable()
	if exe == "" {
		return DaemonResult{Message: "Docker Sandboxes CLI is not installed."}
	}
	if s.DaemonRunning() {
		return DaemonResult{OK: true, Message: "The sbx daemon is already running."}
	}

	logPath := filepath.Join(s.home(), ".specter", "sbx-daemon.log")
	os.MkdirAll(filepath.Dir(logPath), 0o755)
	logFile, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		logFile = nil
	}

	cmd := exec.Command(exe, "daemon", "start")
	cmd.Dir = s.home()
	if logFile != nil {
		cmd.Stdout, cmd.Stderr = logFile, logFile
	}
	// Its own session, so it outlives this request and is not killed when the
	// server's process group goes away.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}

	if err := cmd.Start(); err != nil {
		if logFile != nil {
			logFile.Close()
		}
		return DaemonResult{Message: "Could not launch the sbx daemon: " + err.Error()}
	}
	// Deliberately NOT waited on. Reaped in the background so the process does
	// not become a zombie, but nothing blocks on it.
	go func() {
		cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
	}()

	wait := s.DaemonWait
	if wait == 0 {
		wait = defaultDaemonWait
	}
	deadline := time.Now().Add(wait)
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		if s.DaemonRunning() {
			return DaemonResult{OK: true, Message: "The sbx daemon started successfully."}
		}
	}
	return DaemonResult{Message: "The sbx daemon did not report ready in time. See " + logPath + "."}
}

// PolicyStatus infers the active network policy from the rule list.
//
// There is no command that reports the policy directly, so it is read out of
// `sbx policy ls`. Because it is inferred, an output nobody anticipated must
// read as "custom" — telling someone their network is denied when it is open is
// worse than admitting the answer is not known.
func (s *Sandbox) PolicyStatus() PolicyStatus {
	available := append([]string(nil), PolicyValues...)
	sort.Strings(available)

	if s.executable() == "" {
		return PolicyStatus{
			Status: "missing", AvailablePolicy: available,
			Message: "Docker Sandboxes CLI is not installed.",
		}
	}

	result := s.run(10*time.Second, "policy", "ls")
	output := strings.TrimSpace(result.Stdout)
	if output == "" {
		output = strings.TrimSpace(result.Stderr)
	}
	if result.ExitCode != 0 {
		// Not a policy value: "your network is open" and "I could not find out"
		// are different answers.
		return PolicyStatus{
			Status: "unavailable", AvailablePolicy: available,
			Message:    "Docker Sandboxes policy status is unavailable.",
			Diagnostic: lastRunes(output, 2000),
		}
	}

	policy := inferPolicy(output)
	return PolicyStatus{
		OK: true, Status: "ready", CurrentPolicy: policy, AvailablePolicy: available,
		Message: "Docker Sandboxes network policy is " + policy + ".",
		Raw:     lastRunes(output, 8000),
	}
}

func inferPolicy(output string) string {
	switch {
	case strings.Contains(output, "default-ai-services") && strings.Contains(output, "default-package-managers"):
		return "balanced"
	case strings.Contains(output, "allow-all"), strings.Contains(output, "default-allow-all"):
		return "allow-all"
	case strings.TrimSpace(output) == "",
		strings.Contains(output, "No policy rules"),
		strings.Contains(output, "deny-all"):
		return "deny-all"
	default:
		// Unrecognised. Naming a specific policy here would be a guess
		// presented as a fact about the user's network.
		return "custom"
	}
}

// SetPolicy applies one of the known policies.
func (s *Sandbox) SetPolicy(policy string) DaemonResult {
	valid := false
	for _, known := range PolicyValues {
		if policy == known {
			valid = true
			break
		}
	}
	if !valid {
		// Not passed through to the CLI: an unrecognised value might mean
		// something there, and a typo must not silently apply nothing.
		return DaemonResult{Message: "Policy must be one of: allow-all, balanced, deny-all."}
	}
	if s.executable() == "" {
		return DaemonResult{Message: "Docker Sandboxes CLI is not installed."}
	}

	result := s.run(20*time.Second, "policy", "set", policy)
	if result.ExitCode != 0 {
		detail := strings.TrimSpace(result.Stderr + result.Stdout)
		return DaemonResult{Message: "Could not apply the policy: " + lastRunes(detail, 2000)}
	}
	return DaemonResult{OK: true, Message: "Network policy set to " + policy + "."}
}

func lastRunes(s string, n int) string {
	runes := []rune(s)
	if len(runes) <= n {
		return s
	}
	return string(runes[len(runes)-n:])
}
