// CLI agent status: what is installed, what is signed in.
//
// This endpoint is POLLED by the Models page, which shapes every decision here:
//
//   - Gemini's auth is read from ~/.gemini/google_accounts.json rather than by
//     invoking the CLI. A real prompt costs a quota call on every poll.
//   - Claude and Cursor have no credential file to read, so they are probed by
//     running the binary — and that is why the whole thing is CACHED. Spawning
//     two agents every few seconds while a settings page is open is not free.
//   - A probe that hangs must not hang the page, so each carries a timeout.
package hostops

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func writeExecutable(t *testing.T, dir, name, body string) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAnAgentThatIsNotInstalledIsNotAuthenticated(t *testing.T) {
	// Reporting "authenticated" for a binary that does not exist would show a
	// green tick beside an agent that cannot run.
	probe := &Prober{Roots: []string{t.TempDir()}, HomeDir: t.TempDir()}
	statuses := probe.AgentStatus()

	if len(statuses) == 0 {
		t.Fatal("no agents reported")
	}
	for _, s := range statuses {
		if s.Installed {
			t.Errorf("%s reported installed from an empty directory", s.Key)
		}
		if s.Authenticated {
			t.Errorf("%s reported authenticated while not installed", s.Key)
		}
		if s.AuthNote == "" {
			t.Errorf("%s gives no hint about what to do", s.Key)
		}
	}
}

func TestGeminiAuthIsReadFromDiskNotByInvokingIt(t *testing.T) {
	// A real prompt costs a quota call, and this endpoint is polled.
	binDir := t.TempDir()
	home := t.TempDir()
	// A gemini that FAILS if executed — proving the credential file is what is read.
	writeExecutable(t, binDir, "gemini", `echo "SHOULD NOT BE INVOKED" >&2; exit 1`)

	geminiDir := filepath.Join(home, ".gemini")
	os.MkdirAll(geminiDir, 0o755)
	os.WriteFile(filepath.Join(geminiDir, "google_accounts.json"),
		[]byte(`{"account":"a@b.co"}`), 0o600)

	probe := &Prober{Roots: []string{binDir}, HomeDir: home}
	status := findAgent(t, probe.AgentStatus(), "gemini")

	if !status.Installed {
		t.Fatal("gemini was not detected as installed")
	}
	if !status.Authenticated {
		t.Error("a populated google_accounts.json did not count as signed in")
	}
}

func TestGeminiWithAnEmptyCredentialFileIsNotSignedIn(t *testing.T) {
	binDir := t.TempDir()
	home := t.TempDir()
	writeExecutable(t, binDir, "gemini", `echo v1.0`)
	os.MkdirAll(filepath.Join(home, ".gemini"), 0o755)
	// Present but empty — the file existing is not the same as being signed in.
	os.WriteFile(filepath.Join(home, ".gemini", "google_accounts.json"), []byte(`{}`), 0o600)

	probe := &Prober{Roots: []string{binDir}, HomeDir: home}
	status := findAgent(t, probe.AgentStatus(), "gemini")
	if status.Authenticated {
		t.Error("an empty credential file counted as signed in")
	}
}

func TestClaudeIsProbedAndItsRefusalIsRead(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", `echo "Not logged in"`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir()}
	status := findAgent(t, probe.AgentStatus(), "claude")

	if !status.Installed {
		t.Fatal("claude was not detected")
	}
	if status.Authenticated {
		t.Error("\"Not logged in\" was read as signed in")
	}
	if status.AuthNote == "" {
		t.Error("no hint about how to sign in")
	}
}

func TestAWorkingClaudeReportsSignedIn(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", `echo "pong"`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir()}
	status := findAgent(t, probe.AgentStatus(), "claude")
	if !status.Authenticated {
		t.Errorf("a working claude was not reported as signed in (note: %q)", status.AuthNote)
	}
}

func TestAHangingProbeDoesNotHangTheCaller(t *testing.T) {
	// The Models page polls this. One stuck binary must not freeze it.
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", `sleep 60`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir(), ProbeTimeout: 300 * time.Millisecond}
	start := time.Now()
	probe.AgentStatus()
	// Four agents probed CONCURRENTLY, each bounded by ProbeTimeout. Sequential
	// probing would make this the sum, not the max.
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Errorf("probing took %s — a stuck agent froze the status endpoint", elapsed)
	}
}

func TestVersionIsReportedWhenAvailable(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", `echo "1.2.3 (build 99)"`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir()}
	status := findAgent(t, probe.AgentStatus(), "claude")
	if status.Version == "" {
		t.Error("no version reported for an installed agent")
	}
}

func TestStatusIsCachedBetweenPolls(t *testing.T) {
	// Without a cache, an open settings page spawns two agents every few
	// seconds forever.
	binDir := t.TempDir()
	counter := filepath.Join(t.TempDir(), "calls")
	writeExecutable(t, binDir, "claude", `echo x >> `+counter+`; echo pong`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir(), CacheTTL: time.Minute}

	probe.DirectCLIStatus()
	body, _ := os.ReadFile(counter)
	firstPoll := len(body)
	if firstPoll == 0 {
		t.Fatal("the first poll invoked nothing")
	}

	// Two more polls inside the TTL must add nothing. Counting total
	// invocations would only measure how many probes one poll makes.
	probe.DirectCLIStatus()
	probe.DirectCLIStatus()
	body, _ = os.ReadFile(counter)
	if len(body) != firstPoll {
		t.Errorf("polls 2 and 3 invoked the agent %d more times — the cache is not working",
			len(body)-firstPoll)
	}
}

func TestOverallStatusReflectsWhatIsUsable(t *testing.T) {
	binDir := t.TempDir()
	writeExecutable(t, binDir, "claude", `echo pong`)

	probe := &Prober{Roots: []string{binDir}, HomeDir: t.TempDir()}
	status := probe.DirectCLIStatus()

	if status.RuntimeID != "direct-cli" {
		t.Errorf("runtime_id = %q", status.RuntimeID)
	}
	if !status.Available {
		t.Error("a signed-in agent did not make the runtime available")
	}
	if status.Status != "ready" {
		t.Errorf("status = %q, want ready", status.Status)
	}

	// Nothing installed at all reads differently from something half-configured.
	empty := &Prober{Roots: []string{t.TempDir()}, HomeDir: t.TempDir()}
	if got := empty.DirectCLIStatus().Status; got != "missing" {
		t.Errorf("with no agents installed, status = %q, want missing", got)
	}
}

func findAgent(t *testing.T, statuses []AgentStatus, key string) AgentStatus {
	t.Helper()
	for _, s := range statuses {
		if s.Key == key {
			return s
		}
	}
	t.Fatalf("no status reported for %q", key)
	return AgentStatus{}
}
