package agenthost

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// approvedWorkspace writes an allowlist naming dir, and returns its path.
func approvedWorkspace(t *testing.T, dir string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "workspaces.json")
	// The real format: {"paths": [...]}. An earlier version of this helper
	// invented a shape, so the list parsed as empty and every request was
	// refused for the RIGHT reason with the WRONG cause.
	body, _ := json.Marshal(map[string]any{"paths": []string{resolved}})
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// fakeAgent writes a script standing in for an agent CLI.
func fakeAgent(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fake-agent")
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func post(t *testing.T, srv *httptest.Server, token string, req SpawnRequest) (int, SpawnResponse) {
	t.Helper()
	body, _ := json.Marshal(req)
	httpReq, err := http.NewRequest(http.MethodPost, srv.URL+"/spawn", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		httpReq.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := srv.Client().Do(httpReq)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out SpawnResponse
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// This endpoint spawns processes, so an unauthenticated one is a remote code
// execution service. That is the single most important property here.
func TestSpawnRequiresTheRunnerToken(t *testing.T) {
	workspace := t.TempDir()
	server := &Server{
		Token:         "the-real-token",
		AllowlistPath: approvedWorkspace(t, workspace),
		ResolveAgent:  func(string) string { return fakeAgent(t, `echo "should not run"`) },
	}
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	for _, c := range []struct{ name, token string }{
		{"no token", ""},
		{"wrong token", "not-the-token"},
		{"prefix of the real token", "the-real"},
	} {
		t.Run(c.name, func(t *testing.T) {
			code, out := post(t, srv, c.token, SpawnRequest{
				Agent: "claude", Prompt: "hello", Workspace: workspace,
			})
			if code != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", code)
			}
			if out.Stdout != "" {
				t.Error("an unauthenticated request produced agent output")
			}
		})
	}
}

// The allowlist is the whole security boundary: without it, anything that can
// reach the port runs an agent against any directory on the machine.
func TestAnUnapprovedWorkspaceIsRefusedBeforeSpawning(t *testing.T) {
	spawned := false
	server := &Server{
		Token:         "t",
		AllowlistPath: approvedWorkspace(t, t.TempDir()), // approves a DIFFERENT dir
		ResolveAgent: func(string) string {
			spawned = true
			return fakeAgent(t, `echo ran`)
		},
	}
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	code, out := post(t, srv, "t", SpawnRequest{
		Agent: "claude", Prompt: "hello", Workspace: t.TempDir(),
	})
	if code != http.StatusForbidden {
		t.Errorf("status = %d, want 403", code)
	}
	if out.Refused == "" {
		t.Error("no reason given for the refusal")
	}
	// Resolution happens AFTER the allowlist check, so this proves the order:
	// nothing about the agent is touched for an unapproved path.
	if spawned {
		t.Error("the agent was resolved for an unapproved workspace")
	}
}

func TestAnApprovedWorkspaceRuns(t *testing.T) {
	workspace := t.TempDir()
	server := &Server{
		Token:         "t",
		AllowlistPath: approvedWorkspace(t, workspace),
		ResolveAgent:  func(string) string { return fakeAgent(t, `echo "the agent replied"`) },
	}
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	code, out := post(t, srv, "t", SpawnRequest{
		Agent: "claude", Prompt: "hello", Workspace: workspace,
	})
	if code != http.StatusOK {
		t.Fatalf("status = %d: %s", code, out.Refused)
	}
	if !out.OK {
		t.Errorf("run not ok: %+v", out)
	}
	if !strings.Contains(out.Stdout, "the agent replied") {
		t.Errorf("stdout = %q", out.Stdout)
	}
}

// "Not installed" has to say WHERE. The backend cannot see this filesystem, so
// an unqualified message sends the operator to the wrong machine.
func TestAMissingAgentNamesTheHost(t *testing.T) {
	workspace := t.TempDir()
	server := &Server{
		Token:         "t",
		AllowlistPath: approvedWorkspace(t, workspace),
		ResolveAgent:  func(string) string { return "" },
	}
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	code, out := post(t, srv, "t", SpawnRequest{
		Agent: "codex", Prompt: "hello", Workspace: workspace,
	})
	if code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", code)
	}
	if !strings.Contains(out.Refused, "agent host") {
		t.Errorf("refusal does not say which machine: %q", out.Refused)
	}
	if !strings.Contains(out.Refused, "codex") {
		t.Errorf("refusal does not name the agent: %q", out.Refused)
	}
}

// Health is unauthenticated on purpose: it lets a backend tell "misconfigured"
// from "not running" without holding a credential, and reveals nothing.
func TestHealthNeedsNoToken(t *testing.T) {
	srv := httptest.NewServer((&Server{Token: "t"}).Handler())
	defer srv.Close()

	resp, err := srv.Client().Get(srv.URL + "/health")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d", resp.StatusCode)
	}
}

// A host that is unreachable must be reported as such. Falling back to a local
// spawn would silently run an agent in the very place the operator containerized
// to avoid.
func TestAnUnreachableHostIsAnErrorNotAFallback(t *testing.T) {
	client := &Client{BaseURL: "http://127.0.0.1:1", Token: "t", HTTP: http.DefaultClient}

	_, err := client.Spawn(context.Background(), SpawnRequest{
		Agent: "claude", Prompt: "hello", Workspace: "/tmp",
	})
	if err == nil {
		t.Fatal("an unreachable agent host did not error")
	}
	if !strings.Contains(err.Error(), "could not be reached") {
		t.Errorf("error does not name the problem: %v", err)
	}
}

// A refusal from the host must reach the caller as a refusal, with its reason —
// not as an empty successful run.
func TestARefusalReachesTheCaller(t *testing.T) {
	server := &Server{Token: "t", AllowlistPath: approvedWorkspace(t, t.TempDir())}
	srv := httptest.NewServer(server.Handler())
	defer srv.Close()

	client := &Client{BaseURL: srv.URL, Token: "t", HTTP: srv.Client()}
	_, err := client.Spawn(context.Background(), SpawnRequest{
		Agent: "claude", Prompt: "hello", Workspace: t.TempDir(),
	})
	if err == nil {
		t.Fatal("a refused run was reported as success")
	}
	if !strings.Contains(err.Error(), "refused") {
		t.Errorf("error does not say it was refused: %v", err)
	}
}
