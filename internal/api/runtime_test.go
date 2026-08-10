// The runtime-adapter endpoints, natively.
//
// These were HTTP calls to the Python host runner. There is no host runner now,
// so the same binary answers them — which is the point of the migration, and
// also removes a failure mode: a backend that worked only while a second
// process happened to be alive.
//
// The credential rules are the ones that matter. A bot token is written
// encrypted, is never returned, and a blank one means "keep the stored one" so
// the secret never round-trips through the UI.
package api

import (
	"net/http"
	"strings"
	"testing"
)

func TestWorkspaceLifecycle(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	path := t.TempDir()

	code, created := call(t, srv, "POST", "/api/runtime-adapters/workspaces", token,
		map[string]any{"name": "Scratch", "path": path})
	if code != http.StatusOK {
		t.Fatalf("create returned %d", code)
	}
	id, _ := created["id"].(string)
	if id == "" {
		t.Fatal("no workspace id returned")
	}
	if created["is_active"] != true {
		t.Error("a new workspace is not active")
	}

	if list := callArray(t, srv, "GET", "/api/runtime-adapters/workspaces", token); len(list) != 1 {
		t.Errorf("listed %d workspaces, want 1", len(list))
	}

	// Deactivation is a SOFT delete: the row stays so run history that
	// references the path still resolves.
	if code, _ := call(t, srv, "DELETE", "/api/runtime-adapters/workspaces/"+id, token, nil); code != http.StatusOK {
		t.Errorf("delete returned %d", code)
	}
	var active int
	s.DB().QueryRow(`SELECT is_active FROM runtime_workspaces WHERE id = ?`, id).Scan(&active)
	if active != 0 {
		t.Error("the workspace is still active after deletion")
	}
	var rows int
	s.DB().QueryRow(`SELECT COUNT(*) FROM runtime_workspaces WHERE id = ?`, id).Scan(&rows)
	if rows != 1 {
		t.Error("the row was hard-deleted — run history referencing it would no longer resolve")
	}
}

func TestAddingTheSamePathTwiceReactivatesRatherThanDuplicating(t *testing.T) {
	// Re-adding a path someone previously removed is the common case, and two
	// rows for one directory makes the allowlist ambiguous.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	path := t.TempDir()

	_, first := call(t, srv, "POST", "/api/runtime-adapters/workspaces", token,
		map[string]any{"name": "First", "path": path})
	firstID, _ := first["id"].(string)
	call(t, srv, "DELETE", "/api/runtime-adapters/workspaces/"+firstID, token, nil)

	_, second := call(t, srv, "POST", "/api/runtime-adapters/workspaces", token,
		map[string]any{"name": "Renamed", "path": path})
	if second["is_active"] != true {
		t.Error("re-adding a removed path did not reactivate it")
	}
	if second["name"] != "Renamed" {
		t.Errorf("name = %v, want the new name", second["name"])
	}

	var count int
	s.DB().QueryRow(`SELECT COUNT(*) FROM runtime_workspaces`).Scan(&count)
	if count != 1 {
		t.Errorf("%d rows for one path — the allowlist is ambiguous", count)
	}
}

func TestWorkspacePathsAreResolvedBeforeStorage(t *testing.T) {
	// The allowlist compares resolved paths, so storing an unresolved one means
	// an approved directory never matches. On macOS /tmp is a symlink.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	call(t, srv, "POST", "/api/runtime-adapters/workspaces", token,
		map[string]any{"name": "T", "path": "/tmp"})

	var stored string
	s.DB().QueryRow(`SELECT path FROM runtime_workspaces`).Scan(&stored)
	if strings.HasSuffix(stored, "/") && stored != "/" {
		t.Errorf("stored path has a trailing slash: %q", stored)
	}
	if stored == "" {
		t.Fatal("no path stored")
	}
}

func TestWorkspaceRequiresANameAndPath(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	for _, body := range []map[string]any{
		{"name": "", "path": "/tmp"},
		{"name": "X", "path": ""},
		{"name": "  ", "path": "  "},
	} {
		if code, _ := call(t, srv, "POST", "/api/runtime-adapters/workspaces", token, body); code != http.StatusBadRequest {
			t.Errorf("%v was accepted (%d)", body, code)
		}
	}
}

func TestWorkspaceWritesRequireAdmin(t *testing.T) {
	// The workspace list IS the agent allowlist. An operator who can add to it
	// can point an agent at any directory on the machine.
	srv, s := testServer(t)
	adminToken, _ := bootstrapAdmin(t, srv)
	approveWorkspace(t, s, t.TempDir())

	call(t, srv, "POST", "/api/auth/users", adminToken,
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2", "role": "operator"})
	_, login := call(t, srv, "POST", "/api/auth/login", "",
		map[string]string{"email": "op@local.dev", "password": "hunter2hunter2"})
	opToken, _ := login["token"].(string)

	if code, _ := call(t, srv, "POST", "/api/runtime-adapters/workspaces", opToken,
		map[string]any{"name": "X", "path": t.TempDir()}); code != http.StatusForbidden {
		t.Errorf("an operator added a workspace (%d) — that is the agent allowlist", code)
	}
	// Reading it is fine.
	if code, _ := call(t, srv, "GET", "/api/runtime-adapters/workspaces", opToken, nil); code != http.StatusOK {
		t.Errorf("an operator could not list workspaces (%d)", code)
	}
}

func TestTelegramTokenIsNeverReturned(t *testing.T) {
	// Only a last-4 hint. Returning it would put a live bot credential into
	// browser history, proxy logs and any error tracker on the page.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	const botToken = "1234567:AAH-secret-telegram-token-value"

	code, _ := call(t, srv, "POST", "/api/runtime-adapters/telegram/config", token,
		map[string]any{"bot_token": botToken, "allowed_chat_ids": []string{"111"}})
	if code != http.StatusOK {
		t.Fatalf("save returned %d", code)
	}

	_, config := call(t, srv, "GET", "/api/runtime-adapters/telegram/config", token, nil)
	body := strings.Join([]string{
		asString(config["bot_token_hint"]), asString(config["bot_token"]),
	}, " ")
	if strings.Contains(body, "AAH-secret") {
		t.Error("the bot token was returned to the client")
	}
	if config["bot_token_set"] != true {
		t.Error("bot_token_set is false after saving one")
	}
	hint := asString(config["bot_token_hint"])
	if hint == "" || !strings.HasSuffix(hint, "alue") {
		t.Errorf("hint = %q, want the last four characters", hint)
	}
}

func TestTelegramTokenIsStoredEncrypted(t *testing.T) {
	// The database is a file on disk; a plaintext bot token in it is a
	// credential anyone with the file can use.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	const botToken = "1234567:AAH-secret-telegram-token-value"

	call(t, srv, "POST", "/api/runtime-adapters/telegram/config", token,
		map[string]any{"bot_token": botToken, "allowed_chat_ids": []string{"111"}})

	var stored string
	s.DB().QueryRow(`SELECT secret_enc FROM user_integrations WHERE provider = 'telegram'`).Scan(&stored)
	if stored == "" {
		t.Fatal("nothing was stored")
	}
	if strings.Contains(stored, "AAH-secret") {
		t.Error("the bot token is stored in plaintext")
	}
	if !strings.HasPrefix(stored, "gAAAAA") {
		t.Errorf("the stored value is not a Fernet token: %.12s", stored)
	}
}

func TestABlankTokenKeepsTheStoredOne(t *testing.T) {
	// So editing the chat list does not require re-pasting the secret, and the
	// UI never has to hold it.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	call(t, srv, "POST", "/api/runtime-adapters/telegram/config", token,
		map[string]any{"bot_token": "1234567:ORIGINAL-TOKEN", "allowed_chat_ids": []string{"111"}})
	var first string
	s.DB().QueryRow(`SELECT secret_enc FROM user_integrations WHERE provider = 'telegram'`).Scan(&first)

	// Update only the chat list.
	call(t, srv, "POST", "/api/runtime-adapters/telegram/config", token,
		map[string]any{"bot_token": "", "allowed_chat_ids": []string{"111", "222"}})

	_, config := call(t, srv, "GET", "/api/runtime-adapters/telegram/config", token, nil)
	if config["bot_token_set"] != true {
		t.Error("a blank token wiped the stored credential")
	}
	ids, _ := config["allowed_chat_ids"].([]any)
	if len(ids) != 2 {
		t.Errorf("allowed_chat_ids = %v, want both", config["allowed_chat_ids"])
	}
}

func TestDisconnectingTelegramRemovesTheCredential(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	call(t, srv, "POST", "/api/runtime-adapters/telegram/config", token,
		map[string]any{"bot_token": "1234567:TOKEN", "allowed_chat_ids": []string{"111"}})
	if code, _ := call(t, srv, "DELETE", "/api/runtime-adapters/telegram/config", token, nil); code != http.StatusOK {
		t.Fatal("disconnect failed")
	}

	var rows int
	s.DB().QueryRow(`SELECT COUNT(*) FROM user_integrations WHERE provider = 'telegram'`).Scan(&rows)
	if rows != 0 {
		t.Error("the credential survived disconnection")
	}
	_, config := call(t, srv, "GET", "/api/runtime-adapters/telegram/config", token, nil)
	if config["bot_token_set"] != false {
		t.Error("still reporting a configured bot after disconnecting")
	}
}

func TestTelegramConfigRequiresAdmin(t *testing.T) {
	srv, _ := testServer(t)
	bootstrapAdmin(t, srv)
	if code, _ := call(t, srv, "GET", "/api/runtime-adapters/telegram/config", "", nil); code != http.StatusUnauthorized {
		t.Errorf("unauthenticated read returned %d", code)
	}
}

func TestDirectCLIStatusRenders(t *testing.T) {
	// The Models page calls this on load; it must answer even with no agents
	// installed rather than erroring and blanking the page.
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)

	code, status := call(t, srv, "GET", "/api/runtime-adapters/direct-cli/status", token, nil)
	if code != http.StatusOK {
		t.Fatalf("returned %d", code)
	}
	if status["runtime_id"] != "direct-cli" {
		t.Errorf("runtime_id = %v", status["runtime_id"])
	}
	if _, ok := status["agent_status"]; !ok {
		t.Error("no agent_status — the page renders an empty list")
	}
}

func TestLaunchdStatusRenders(t *testing.T) {
	srv, _ := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	code, status := call(t, srv, "GET", "/api/runtime-adapters/host-runner/launchd/status", token, nil)
	if code != http.StatusOK {
		t.Fatalf("returned %d", code)
	}
	if _, ok := status["installed"]; !ok {
		t.Error("no installed flag")
	}
}

func asString(v any) string {
	s, _ := v.(string)
	return s
}

// Planning runs an agent in a directory, so it is gated exactly like starting a
// run. Treating it as a read-only preview would let anyone point an agent at any
// directory by asking for a plan instead of a run.
func TestPlanningRefusesAnUnapprovedWorkspace(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	approveWorkspace(t, s, t.TempDir())

	code, _ := call(t, srv, "POST", "/api/workflows/plan", token, map[string]any{
		"objective": "review the auth module", "supervisor_node_id": "sup",
		"workspace_path": t.TempDir(), // a different, unapproved directory
	})
	if code != http.StatusForbidden {
		t.Errorf("planning in an unapproved workspace returned %d, want 403", code)
	}
}

func TestPlanningRequiresAnObjective(t *testing.T) {
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	workspace := t.TempDir()
	approveWorkspace(t, s, workspace)

	if code, _ := call(t, srv, "POST", "/api/workflows/plan", token, map[string]any{
		"objective": "  ", "supervisor_node_id": "sup", "workspace_path": workspace,
	}); code != http.StatusBadRequest {
		t.Errorf("a blank objective was accepted (%d)", code)
	}
}

func TestRunEventsStreamsRealState(t *testing.T) {
	// Python emitted four CANNED events describing a demo that no longer runs.
	// This streams the actual run, so a client watching it sees what happened.
	srv, s := testServer(t)
	token, _ := bootstrapAdmin(t, srv)
	seedRun(t, s, "r1", "wf1", "completed", "-1 hours", "-30 minutes")

	req, _ := http.NewRequest("GET", srv.URL+"/api/workflow-runs/r1/events", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	if ct := resp.Header.Get("Content-Type"); !strings.Contains(ct, "text/event-stream") {
		t.Errorf("Content-Type = %q, want an event stream", ct)
	}

	buf := make([]byte, 2048)
	n, _ := resp.Body.Read(buf)
	body := string(buf[:n])
	if !strings.Contains(body, "event: run_status") {
		t.Errorf("no run_status event: %q", body)
	}
	if !strings.Contains(body, "completed") {
		t.Errorf("the stream did not carry the run's real status: %q", body)
	}
}
