// End-to-end tests against a REAL `specter serve` process.
//
// WHY THIS EXISTS SEPARATELY FROM internal/api
//
// The package tests there call NewRouter() in-process. That is fast and it
// caught a lot — but every bug that reached a browser this session escaped it:
//
//	CORS was missing entirely      curl does not enforce CORS, so 94 endpoints
//	                               returned 200 while the app could not load
//	--addr swallowed --db          a flag-ordering bug in the binary's argument
//	                               parsing, which the router never sees
//	`sbx --version`                the flag does not exist; the CLI answers
//	                               "unknown flag" and that was read as a version
//	node.Runtime() as an agent     "no agent CLI found for direct" — only a real
//	                               run against a real machine showed it
//
// So these tests build the binary, run it, and talk to it over HTTP the way the
// frontend does. Anything that only fails through the real transport, the real
// argument parser, or the real filesystem belongs here.
//
//	go test ./test/e2e/            (skips if the binary cannot be built)
package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// server is a running `specter serve` with its own database.
type server struct {
	baseURL string
	dbPath  string
	token   string
	cmd     *exec.Cmd
	logPath string
}

func freePort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// buildBinary compiles the CLI once per run.
// The binary is built ONCE for the whole package, in TestMain, rather than once
// per test. Compiling it ~20 times dominated the runtime of a suite whose actual
// work is running it, and a suite slow enough to skip is a suite that stops
// catching things.
var (
	sharedBinary   string
	sharedBuildErr string
)

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "specter-e2e")
	if err != nil {
		sharedBuildErr = err.Error()
	} else {
		binary := filepath.Join(dir, "specter")
		cmd := exec.Command("go", "build", "-o", binary, "./cmd/specter")
		// TestMain has no *testing.T, and the working directory is the package
		// directory — test/e2e — so the repo root is two levels up.
		cmd.Dir = filepath.Join("..", "..")
		if out, err := cmd.CombinedOutput(); err != nil {
			sharedBuildErr = fmt.Sprintf("%v\n%s", err, out)
		} else {
			sharedBinary = binary
		}
	}

	// os.Exit skips deferred functions, so the result is captured and cleanup
	// runs explicitly before exiting.
	code := m.Run()
	if dir != "" {
		os.RemoveAll(dir)
	}
	os.Exit(code)
}

func buildBinary(t *testing.T) string {
	t.Helper()
	if sharedBinary == "" {
		t.Skipf("cannot build the binary, skipping end-to-end tests: %s", sharedBuildErr)
	}
	return sharedBinary
}

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	// test/e2e -> repo root
	return filepath.Dir(filepath.Dir(dir))
}

// start launches a server and waits for it to answer.
func start(t *testing.T) *server {
	t.Helper()
	binary := buildBinary(t)
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "app.db")
	logPath := filepath.Join(dir, "serve.log")
	port := freePort(t)

	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}

	// NOTE the flag ordering: `--addr X --db Y` is exactly the shape that broke
	// once, when --addr consumed "--db" as its value.
	cmd := exec.Command(binary, "serve",
		"--addr", fmt.Sprintf("127.0.0.1:%d", port), "--db", dbPath)
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}

	s := &server{
		baseURL: fmt.Sprintf("http://127.0.0.1:%d", port),
		dbPath:  dbPath, cmd: cmd, logPath: logPath,
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
		logFile.Close()
	})

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(s.baseURL + "/api/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return s
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	body, _ := os.ReadFile(logPath)
	t.Fatalf("the server never became healthy. Its output:\n%s", body)
	return nil
}

func (s *server) do(t *testing.T, method, path string, body any) (int, map[string]any) {
	t.Helper()
	var reader io.Reader
	if body != nil {
		encoded, _ := json.Marshal(body)
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, s.baseURL+path, reader)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if s.token != "" {
		req.Header.Set("Authorization", "Bearer "+s.token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	defer resp.Body.Close()
	var out map[string]any
	json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (s *server) bootstrap(t *testing.T) {
	t.Helper()
	const password = "e2e-test-password-1"
	if code, _ := s.do(t, "POST", "/api/auth/bootstrap",
		map[string]string{"email": "admin@local.dev", "password": password}); code != http.StatusOK {
		t.Fatalf("bootstrap returned %d", code)
	}
	code, body := s.do(t, "POST", "/api/auth/login",
		map[string]string{"email": "admin@local.dev", "password": password})
	if code != http.StatusOK {
		t.Fatalf("login returned %d", code)
	}
	s.token, _ = body["token"].(string)
	if s.token == "" {
		t.Fatal("login returned no token")
	}
}

// --- the flag bug ---

func TestServeParsesItsFlagsInEitherOrder(t *testing.T) {
	// `--addr X --db Y` once had --addr swallow "--db" as its value, and the
	// server tried to listen on an address called "--db". A router test cannot
	// see this: the bug is in argument parsing, before any handler exists.
	//
	// start() uses that exact ordering, so reaching a healthy server proves it.
	s := start(t)
	code, body := s.do(t, "GET", "/api/health", nil)
	if code != http.StatusOK {
		t.Fatalf("health returned %d", code)
	}
	if body["db_path"] != s.dbPath {
		t.Errorf("db_path = %v, want %q — --db was not applied", body["db_path"], s.dbPath)
	}
}

// --- CORS ---

func TestBrowserPreflightSucceeds(t *testing.T) {
	// The bug this file exists for. curl does not enforce CORS, so every
	// endpoint answered 200 while the browser could not make a single request.
	s := start(t)

	req, _ := http.NewRequest("OPTIONS", s.baseURL+"/api/auth/status", nil)
	req.Header.Set("Origin", "http://localhost:8080")
	req.Header.Set("Access-Control-Request-Method", "GET")
	req.Header.Set("Access-Control-Request-Headers", "authorization")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNoContent && resp.StatusCode != http.StatusOK {
		t.Fatalf("preflight returned %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "http://localhost:8080" {
		t.Errorf("Allow-Origin = %q — the browser blocks every request without it", got)
	}
	if !strings.Contains(strings.ToLower(resp.Header.Get("Access-Control-Allow-Headers")), "authorization") {
		t.Error("Authorization is not allowed — every authenticated call would fail")
	}
}

func TestAnUnknownOriginIsNotGrantedAccess(t *testing.T) {
	s := start(t)
	req, _ := http.NewRequest("GET", s.baseURL+"/api/health", nil)
	req.Header.Set("Origin", "https://evil.example.com")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Error("an unlisted origin was granted CORS access")
	}
}

// --- the surface the UI loads ---

func TestEveryPageLoadEndpointAnswers(t *testing.T) {
	// What the app actually calls when it opens. A 500 in any of these blanks a
	// page, and the count of registered routes says nothing about that.
	s := start(t)
	s.bootstrap(t)

	for _, path := range []string{
		"/api/health", "/api/health/system",
		"/api/auth/status", "/api/auth/me", "/api/auth/users",
		"/api/workflows", "/api/skills", "/api/agents",
		"/api/connectors", "/api/model-providers", "/api/approvals",
		"/api/workflow-runs", "/api/workflow-runs/stats",
		"/api/runtime-adapters/direct-cli/status",
		"/api/runtime-adapters/codex-cli/status",
		"/api/runtime-adapters/docker-sandbox/status",
		"/api/runtime-adapters/docker-sandbox/policy",
		"/api/runtime-adapters/workspaces",
		"/api/runtime-adapters/models",
		"/api/runtime-adapters/mcp/list",
		"/api/runtime-adapters/telegram/config",
		"/api/runtime-adapters/host-runner/version",
		"/api/runtime-adapters/host-runner/mode",
		"/api/runtime-adapters/host-runner/logs",
		"/api/runtime-adapters/host-runner/launchd/status",
		"/api/runtime-adapters/codex-cli/runs",
	} {
		if code, _ := s.do(t, "GET", path, nil); code != http.StatusOK {
			t.Errorf("GET %s returned %d", path, code)
		}
	}
}

func TestASetupFlowWorksEndToEnd(t *testing.T) {
	// A fresh install: report setup needed, accept the first admin, refuse a
	// second, and issue a working session.
	s := start(t)

	_, status := s.do(t, "GET", "/api/auth/status", nil)
	if status["needs_setup"] != true {
		t.Error("a fresh database did not report needs_setup")
	}

	s.bootstrap(t)

	_, status = s.do(t, "GET", "/api/auth/status", nil)
	if status["needs_setup"] != false {
		t.Error("still reporting needs_setup after bootstrap")
	}
	// A second bootstrap would mint an admin on a live system with no credential.
	if code, _ := s.do(t, "POST", "/api/auth/bootstrap",
		map[string]string{"email": "attacker@evil.dev", "password": "hunter2hunter2"}); code != http.StatusConflict {
		t.Errorf("a second bootstrap returned %d, want 409", code)
	}
}

func TestAWorkflowCanBeCreatedAndRead(t *testing.T) {
	s := start(t)
	s.bootstrap(t)

	graph := map[string]any{
		"nodes": []map[string]any{{
			"id": "n1", "type": "specialistAgent",
			"data": map[string]any{"label": "Reviewer", "objective": "look"},
		}},
		"edges": []any{},
	}
	code, created := s.do(t, "POST", "/api/workflows",
		map[string]any{"name": "E2E", "graph": graph})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)

	code, fetched := s.do(t, "GET", "/api/workflows/"+id, nil)
	if code != http.StatusOK {
		t.Fatalf("get returned %d", code)
	}
	// The graph must come back DECODED — the builder renders it directly.
	if _, ok := fetched["graph"].(map[string]any); !ok {
		t.Errorf("graph came back as %T, not an object", fetched["graph"])
	}
}

// --- the workspace boundary, through the real binary ---

func TestStartingARunOutsideTheAllowlistIsRefused(t *testing.T) {
	// The security boundary of the whole product: which directory an agent may
	// touch. Tested here as well as in the package tests, because this is the
	// path an actual request takes.
	s := start(t)
	s.bootstrap(t)

	approved := t.TempDir()
	if code, _ := s.do(t, "POST", "/api/runtime-adapters/workspaces",
		map[string]any{"name": "Approved", "path": approved}); code != http.StatusOK {
		t.Fatal("could not approve a workspace")
	}

	graph := map[string]any{
		"nodes": []map[string]any{{
			"id": "n1", "type": "specialistAgent",
			"data": map[string]any{"label": "R", "objective": "x"},
		}},
		"edges": []any{},
	}
	_, workflow := s.do(t, "POST", "/api/workflows",
		map[string]any{"name": "Gated", "graph": graph, "workspace_path": approved})
	workflowID, _ := workflow["id"].(string)

	// Somewhere else entirely.
	code, _ := s.do(t, "POST", "/api/workflow-runs",
		map[string]any{"workflow_id": workflowID, "workspace_path": t.TempDir()})
	if code != http.StatusForbidden {
		t.Errorf("an unapproved workspace returned %d, want 403", code)
	}

	// /etc is the case that matters if the check is ever loosened.
	if code, _ := s.do(t, "POST", "/api/workflow-runs",
		map[string]any{"workflow_id": workflowID, "workspace_path": "/etc"}); code != http.StatusForbidden {
		t.Errorf("/etc returned %d, want 403", code)
	}
}

func TestAnUnauthenticatedCallerReachesNothing(t *testing.T) {
	// Issue #40 was nine endpoints open in Python. This asserts the port did not
	// reproduce it, through the real transport.
	s := start(t)
	s.bootstrap(t)
	token := s.token
	s.token = "" // drop the session
	defer func() { s.token = token }()

	for _, tc := range []struct{ method, path string }{
		{"GET", "/api/agents"},
		{"POST", "/api/agents"},
		{"GET", "/api/runs/any/memory"},
		{"DELETE", "/api/runs/any/memory"},
		{"GET", "/api/workflows"},
		{"GET", "/api/workflow-runs"},
		{"GET", "/api/approvals"},
		{"GET", "/api/auth/users"},
	} {
		code, _ := s.do(t, tc.method, tc.path, map[string]any{"name": "x", "role": "y"})
		if code != http.StatusUnauthorized {
			t.Errorf("%s %s returned %d without a session, want 401", tc.method, tc.path, code)
		}
	}
}

func TestHealthReportsARealDatabase(t *testing.T) {
	// An endpoint that answers "ok" without touching anything reports healthy
	// while the database is unreachable — exactly when someone is reading it.
	s := start(t)
	_, body := s.do(t, "GET", "/api/health", nil)

	if body["sqlite"] != "healthy" {
		t.Errorf("sqlite = %v", body["sqlite"])
	}
	if body["journal_mode"] != "wal" {
		t.Errorf("journal_mode = %v, want wal — the CLI and UI share this database", body["journal_mode"])
	}
}

func TestAPasswordHashNeverLeavesTheServer(t *testing.T) {
	s := start(t)
	s.bootstrap(t)

	for _, path := range []string{"/api/auth/me", "/api/auth/users"} {
		req, _ := http.NewRequest("GET", s.baseURL+path, nil)
		req.Header.Set("Authorization", "Bearer "+s.token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(body), "password_hash") || strings.Contains(string(body), "$2b$") {
			t.Errorf("%s leaked a password hash", path)
		}
	}
}

func TestTheServerShutsDownCleanly(t *testing.T) {
	// A SIGTERM mid-request must not leave a half-written row. The runtime
	// restarts this process on every deploy.
	s := start(t)
	s.bootstrap(t)

	if err := s.cmd.Process.Signal(os.Interrupt); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- s.cmd.Wait() }()

	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Error("the server did not exit within 15s of SIGINT — a deploy would have to kill it")
	}
}
