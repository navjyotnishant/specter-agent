package hostops

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
)

// MCP reads and writes MCP server configuration for the agent CLIs.
//
// Two clients, two mechanisms: Codex is asked (`codex mcp list --json`), Claude
// Code is asked AND has a settings file. Neither is a database, and the rule
// that matters is about not destroying what is already there — settings.json is
// the USER'S Claude Code configuration, holding their permissions, hooks and
// model preference alongside their MCP servers.
type MCP struct {
	HomeDir string
	Roots   []string
}

type MCPServer struct {
	Name       string         `json:"name"`
	Enabled    bool           `json:"enabled"`
	AuthStatus string         `json:"auth_status"`
	URL        string         `json:"url,omitempty"`
	Transport  map[string]any `json:"transport,omitempty"`
}

func (m *MCP) home() string {
	if m.HomeDir != "" {
		return m.HomeDir
	}
	home, _ := os.UserHomeDir()
	return home
}

func (m *MCP) resolve(binaries []string) string {
	if len(m.Roots) > 0 {
		return execpkg.ResolveCLIIn(binaries, m.Roots)
	}
	return execpkg.ResolveCLI(binaries, nil)
}

func (m *MCP) claudeSettingsPath() string {
	return filepath.Join(m.home(), ".claude", "settings.json")
}

// readClaudeSettings returns the whole file, not just the MCP section.
//
// The distinction between "absent" and "unparseable" is load-bearing: absent is
// a fresh install and safe to create, unparseable means configuration we cannot
// read and therefore must not overwrite.
func (m *MCP) readClaudeSettings() (map[string]any, error) {
	body, err := os.ReadFile(m.claudeSettingsPath())
	if errors.Is(err, os.ErrNotExist) {
		return map[string]any{}, nil
	}
	if err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return map[string]any{}, nil
	}
	var settings map[string]any
	if err := json.Unmarshal(body, &settings); err != nil {
		// REFUSED, not overwritten. Truncating a file we cannot parse destroys
		// configuration we cannot read back; refusing leaves something to fix.
		return nil, errors.New("~/.claude/settings.json is not valid JSON, so it was left untouched: " + err.Error())
	}
	return settings, nil
}

func (m *MCP) writeClaudeSettings(settings map[string]any) error {
	path := m.claudeSettingsPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	body, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	// 0600: this file can hold credentials for MCP servers.
	return os.WriteFile(path, append(body, '\n'), 0o600)
}

// AddClaudeServer adds a server, preserving every other key in the file.
func (m *MCP) AddClaudeServer(name string, config map[string]any) error {
	settings, err := m.readClaudeSettings()
	if err != nil {
		return err
	}
	servers, _ := settings["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	servers[name] = config
	settings["mcpServers"] = servers
	return m.writeClaudeSettings(settings)
}

// RemoveClaudeServer removes one server and leaves the rest of the file alone.
func (m *MCP) RemoveClaudeServer(name string) error {
	settings, err := m.readClaudeSettings()
	if err != nil {
		return err
	}
	servers, _ := settings["mcpServers"].(map[string]any)
	if servers == nil {
		// Nothing configured: the caller wanted it gone, and it is gone.
		return nil
	}
	delete(servers, name)
	settings["mcpServers"] = servers
	return m.writeClaudeSettings(settings)
}

// ListClaudeServers asks the CLI, because only the CLI knows the live auth
// state. A server in settings.json may still need a login.
func (m *MCP) ListClaudeServers() []MCPServer {
	exe := m.resolve([]string{"claude"})
	if exe == "" {
		// Not an error: the settings page must still render on a machine where
		// the CLI is not installed.
		return nil
	}

	result := execpkg.RunStreaming(context.Background(), execpkg.Command{
		Argv:    []string{exe, "mcp", "list"},
		Dir:     m.home(),
		Timeout: 15 * time.Second,
	})

	var servers []MCPServer
	for _, line := range strings.Split(result.Stdout, "\n") {
		line = strings.TrimSpace(line)
		// "Checking MCP server health..." is a status header, not a server.
		if line == "" || strings.HasPrefix(line, "Checking") {
			continue
		}
		name, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		name = strings.TrimSpace(name)
		if name == "" {
			continue
		}

		urlPart, statusPart, _ := strings.Cut(strings.TrimSpace(rest), " - ")
		// The transport is appended as "(SSE)" or "(HTTP)"; keep only the URL.
		url := strings.Fields(strings.TrimSpace(urlPart))
		serverURL := ""
		if len(url) > 0 {
			serverURL = url[0]
		}

		// "needs_auth" and "unknown" are DIFFERENT states: one the user can act
		// on, the other means the check could not tell.
		auth := "unknown"
		switch {
		case strings.Contains(statusPart, "Connected"):
			auth = "active"
		case strings.Contains(statusPart, "Needs authentication"):
			auth = "needs_auth"
		}

		servers = append(servers, MCPServer{
			Name: name, Enabled: true, AuthStatus: auth, URL: serverURL,
			Transport: map[string]any{"type": "streamable_http", "url": serverURL},
		})
	}
	return servers
}

// ListCodexServers asks the codex CLI, which reports JSON directly.
func (m *MCP) ListCodexServers() []MCPServer {
	exe := m.resolve([]string{"codex"})
	if exe == "" {
		return nil
	}
	result := execpkg.RunStreaming(context.Background(), execpkg.Command{
		Argv:    []string{exe, "mcp", "list", "--json"},
		Dir:     m.home(),
		Timeout: 15 * time.Second,
	})

	var raw map[string]map[string]any
	if json.Unmarshal([]byte(result.Stdout), &raw) != nil {
		return nil
	}
	servers := make([]MCPServer, 0, len(raw))
	for name, config := range raw {
		url, _ := config["url"].(string)
		servers = append(servers, MCPServer{
			Name: name, Enabled: true, AuthStatus: "unknown", URL: url, Transport: config,
		})
	}
	return servers
}
