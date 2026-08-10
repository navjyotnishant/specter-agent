// MCP server configuration, per client.
//
// Two clients, two mechanisms: Codex is asked (`codex mcp list --json`), Claude
// Code both is asked and has a settings file. Neither is a database, so the
// rules that matter are about not destroying what is already there.
//
// The one that bites: writing settings.json must PRESERVE every key the file
// already holds. It is the user's Claude Code configuration, not ours — a naive
// write of {"mcpServers": ...} silently deletes their permissions, hooks, model
// preference and everything else.
package hostops

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestAddingAnMCPServerPreservesTheRestOfSettings(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	os.WriteFile(settingsPath, []byte(`{
	  "model": "opus",
	  "permissions": {"allow": ["Bash(ls:*)"]},
	  "hooks": {"PreToolUse": []},
	  "mcpServers": {"existing": {"url": "https://a.example"}}
	}`), 0o600)

	mcp := &MCP{HomeDir: home}
	if err := mcp.AddClaudeServer("newone", map[string]any{"url": "https://b.example"}); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(settingsPath)
	var settings map[string]any
	if err := json.Unmarshal(body, &settings); err != nil {
		t.Fatalf("settings.json is no longer valid JSON: %v", err)
	}

	// Everything that was there must still be there. This is the user's own
	// Claude Code configuration.
	for _, key := range []string{"model", "permissions", "hooks"} {
		if _, ok := settings[key]; !ok {
			t.Errorf("writing an MCP server deleted %q from the user's settings", key)
		}
	}
	servers, _ := settings["mcpServers"].(map[string]any)
	if _, ok := servers["existing"]; !ok {
		t.Error("an existing MCP server was removed")
	}
	if _, ok := servers["newone"]; !ok {
		t.Error("the new MCP server was not added")
	}
}

func TestAddingToAMissingSettingsFileCreatesIt(t *testing.T) {
	home := t.TempDir()
	mcp := &MCP{HomeDir: home}
	if err := mcp.AddClaudeServer("first", map[string]any{"url": "https://a.example"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, ".claude", "settings.json")); err != nil {
		t.Errorf("settings.json was not created: %v", err)
	}
}

func TestCorruptSettingsAreNotOverwritten(t *testing.T) {
	// Truncating a file we cannot parse destroys configuration we cannot read
	// back. Refusing leaves the user something to fix.
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	original := []byte(`{"model": "opus", TRUNCATED`)
	os.WriteFile(settingsPath, original, 0o600)

	mcp := &MCP{HomeDir: home}
	if err := mcp.AddClaudeServer("x", map[string]any{"url": "https://a.example"}); err == nil {
		t.Error("a corrupt settings file was overwritten instead of refused")
	}

	body, _ := os.ReadFile(settingsPath)
	if string(body) != string(original) {
		t.Error("the corrupt file was modified — its contents are now unrecoverable")
	}
}

func TestRemovingAServerLeavesTheOthers(t *testing.T) {
	home := t.TempDir()
	settingsPath := filepath.Join(home, ".claude", "settings.json")
	os.MkdirAll(filepath.Dir(settingsPath), 0o755)
	os.WriteFile(settingsPath, []byte(`{
	  "model": "opus",
	  "mcpServers": {"keep": {"url": "https://a"}, "drop": {"url": "https://b"}}
	}`), 0o600)

	mcp := &MCP{HomeDir: home}
	if err := mcp.RemoveClaudeServer("drop"); err != nil {
		t.Fatal(err)
	}

	body, _ := os.ReadFile(settingsPath)
	var settings map[string]any
	json.Unmarshal(body, &settings)
	servers, _ := settings["mcpServers"].(map[string]any)
	if _, ok := servers["drop"]; ok {
		t.Error("the server was not removed")
	}
	if _, ok := servers["keep"]; !ok {
		t.Error("removing one server removed another")
	}
	if _, ok := settings["model"]; !ok {
		t.Error("removing a server deleted an unrelated setting")
	}
}

func TestRemovingAServerThatIsNotThereIsNotAnError(t *testing.T) {
	home := t.TempDir()
	mcp := &MCP{HomeDir: home}
	if err := mcp.RemoveClaudeServer("ghost"); err != nil {
		t.Errorf("removing an absent server errored: %v", err)
	}
}

func TestClaudeServerListIsParsedFromTheCLI(t *testing.T) {
	dir := t.TempDir()
	// The real output shape: "Name: url (transport) - status"
	writeExecutable(t, dir, "claude", `cat <<'OUT'
Checking MCP server health...

linear: https://mcp.linear.app/sse (SSE) - ✓ Connected
notion: https://mcp.notion.com/mcp (HTTP) - ✗ Needs authentication
OUT`)

	mcp := &MCP{HomeDir: t.TempDir(), Roots: []string{dir}}
	servers := mcp.ListClaudeServers()

	if len(servers) != 2 {
		t.Fatalf("parsed %d servers, want 2: %+v", len(servers), servers)
	}
	byName := map[string]MCPServer{}
	for _, s := range servers {
		byName[s.Name] = s
	}
	if byName["linear"].AuthStatus != "active" {
		t.Errorf("linear auth_status = %q, want active", byName["linear"].AuthStatus)
	}
	// "Needs authentication" is a DIFFERENT state from "unknown": one is
	// actionable by the user, the other means we could not tell.
	if byName["notion"].AuthStatus != "needs_auth" {
		t.Errorf("notion auth_status = %q, want needs_auth", byName["notion"].AuthStatus)
	}
	if byName["linear"].URL != "https://mcp.linear.app/sse" {
		t.Errorf("linear url = %q — the transport suffix leaked in", byName["linear"].URL)
	}
}

func TestAMissingClaudeCLIYieldsNoServersNotAnError(t *testing.T) {
	// The settings page must still render when the CLI is not installed.
	mcp := &MCP{HomeDir: t.TempDir(), Roots: []string{t.TempDir()}}
	if servers := mcp.ListClaudeServers(); len(servers) != 0 {
		t.Errorf("got %d servers with no claude installed", len(servers))
	}
}

func TestTheHealthCheckHeaderIsNotParsedAsAServer(t *testing.T) {
	dir := t.TempDir()
	writeExecutable(t, dir, "claude", `echo "Checking MCP server health..."`)

	mcp := &MCP{HomeDir: t.TempDir(), Roots: []string{dir}}
	if servers := mcp.ListClaudeServers(); len(servers) != 0 {
		t.Errorf("the status header was parsed as a server: %+v", servers)
	}
}
