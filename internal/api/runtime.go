package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/navjyotnishant/specter-agent/internal/agenthost"
	"github.com/navjyotnishant/specter-agent/internal/hostops"
	"github.com/navjyotnishant/specter-agent/internal/models"
	"github.com/navjyotnishant/specter-agent/internal/secretbox"
)

// The runtime-adapter surface, answered by this binary.
//
// These were HTTP calls to a Python host runner. Removing that process removes
// a whole failure mode with it: a backend that worked only while a second thing
// happened to be alive, and reported "unreachable" the moment it was not.

type runtimeWorkspace struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Path      string `json:"path"`
	IsActive  bool   `json:"is_active"`
	CreatedBy string `json:"created_by"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// prober returns ONE long-lived prober, because its cache lives on the struct.
//
// This used to hand back a fresh &hostops.Prober{} whenever Deps.Prober was nil
// — which is every production request, since only tests inject one. A new
// struct has an empty cache, so the 60-second TTL never survived a single
// request and every page view re-probed all four agents: 5s on /direct-cli/status,
// 4.5s on /codex-cli/status, on an endpoint the settings page polls.
func (d *Deps) prober() *hostops.Prober {
	if d.Prober != nil {
		return d.Prober
	}
	d.proberOnce.Do(func() { d.sharedProber = &hostops.Prober{} })
	return d.sharedProber
}

func (d *Deps) service() *hostops.Service {
	if d.Service != nil {
		return d.Service
	}
	return &hostops.Service{
		BinaryPath: currentBinary(),
		PlistPath:  hostops.DefaultPlistPath(),
		DBPath:     d.DBPath,
	}
}

func (d *Deps) listWorkspaces(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, name, path, is_active, COALESCE(created_by,''), created_at, COALESCE(updated_at,created_at)
		   FROM runtime_workspaces ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list workspaces")
		return
	}
	defer rows.Close()

	out := []runtimeWorkspace{}
	for rows.Next() {
		var ws runtimeWorkspace
		var active int
		if err := rows.Scan(&ws.ID, &ws.Name, &ws.Path, &active,
			&ws.CreatedBy, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read workspaces")
			return
		}
		ws.IsActive = active != 0
		out = append(out, ws)
	}
	writeJSON(w, http.StatusOK, out)
}

// createWorkspace adds a directory to the agent allowlist.
//
// Re-adding a path that was previously removed REACTIVATES it rather than
// inserting a second row: two rows for one directory makes the allowlist
// ambiguous, and re-adding is the common case.
func (d *Deps) createWorkspace(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
		Path string `json:"path"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || strings.TrimSpace(req.Path) == "" {
		writeError(w, http.StatusBadRequest, "A name and a path are both required.")
		return
	}

	// Resolved before storage: the allowlist compares RESOLVED paths, so storing
	// an unresolved one means an approved directory never matches. On macOS
	// /tmp is a symlink to /private/tmp.
	path := resolvePath(req.Path)

	user := userFrom(r)
	createdBy := ""
	if user != nil {
		createdBy = user.ID
	}

	if _, err := d.Store.DB().Exec(
		`INSERT INTO runtime_workspaces (id, name, path, created_by) VALUES (?, ?, ?, ?)
		 ON CONFLICT(path) DO UPDATE SET
		   name = excluded.name, is_active = 1, updated_at = CURRENT_TIMESTAMP`,
		uuid.NewString(), name, path, createdBy); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save the workspace")
		return
	}

	var ws runtimeWorkspace
	var active int
	if err := d.Store.DB().QueryRow(
		`SELECT id, name, path, is_active, COALESCE(created_by,''), created_at, COALESCE(updated_at,created_at)
		   FROM runtime_workspaces WHERE path = ?`, path).
		Scan(&ws.ID, &ws.Name, &ws.Path, &active, &ws.CreatedBy, &ws.CreatedAt, &ws.UpdatedAt); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the saved workspace")
		return
	}
	ws.IsActive = active != 0
	writeJSON(w, http.StatusOK, ws)
}

// deactivateWorkspace is a SOFT delete. The row stays so run history that
// references the path still resolves; only the allowlist entry goes.
func (d *Deps) deactivateWorkspace(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "workspaceID")
	res, err := d.Store.DB().Exec(
		`UPDATE runtime_workspaces SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not deactivate the workspace")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"updated": n > 0, "workspace_id": id})
}

// --- telegram ---

func (d *Deps) box() (*secretbox.Box, error) {
	key, err := d.integrationKey()
	if err != nil {
		return nil, err
	}
	return secretbox.New(key)
}

func (d *Deps) telegramConfig(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	secret, config, updatedAt, err := d.readIntegration(user.ID, "telegram")
	if err != nil || secret == "" && len(config) == 0 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "configured": false, "bot_token_set": false,
			"bot_token_hint": "", "allowed_chat_ids": []string{},
		})
		return
	}

	chatIDs := stringSlice(config["allowed_chat_ids"])
	// The token itself is NEVER returned — only a last-four hint. Returning it
	// would put a live bot credential into browser history, proxy logs and any
	// error tracker running on the page.
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"configured":       secret != "" && len(chatIDs) > 0,
		"bot_token_set":    secret != "",
		"bot_token_hint":   secretHint(secret),
		"allowed_chat_ids": chatIDs,
		"updated_at":       updatedAt,
	})
}

// secretHint shows only enough to recognise which credential is stored.
func secretHint(secret string) string {
	if len([]rune(secret)) <= 4 {
		return ""
	}
	runes := []rune(secret)
	return "…" + string(runes[len(runes)-4:])
}

func (d *Deps) saveTelegramConfig(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BotToken       string   `json:"bot_token"`
		AllowedChatIDs []string `json:"allowed_chat_ids"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user := userFrom(r)

	existing, _, _, _ := d.readIntegration(user.ID, "telegram")
	secret := strings.TrimSpace(req.BotToken)
	if secret == "" {
		// A blank token means "keep the stored one", so editing the chat list
		// never requires re-pasting the credential and the UI never holds it.
		secret = existing
	}
	if secret == "" {
		writeError(w, http.StatusBadRequest, "A bot token is required.")
		return
	}

	config := map[string]any{"allowed_chat_ids": req.AllowedChatIDs}
	if err := d.writeIntegration(user.ID, "telegram", secret, config); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save the Telegram configuration: "+err.Error())
		return
	}

	// No poller to notify. Python had to push the credential to the host runner
	// and warn when that failed; the process that long-polls Telegram is now
	// this one.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "configured": true})
}

func (d *Deps) deleteTelegramConfig(w http.ResponseWriter, r *http.Request) {
	user := userFrom(r)
	res, err := d.Store.DB().Exec(
		`DELETE FROM user_integrations WHERE user_id = ? AND provider = 'telegram'`, user.ID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not remove the Telegram configuration")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "removed": n > 0})
}

func (d *Deps) readIntegration(userID, provider string) (secret string, config map[string]any, updatedAt string, err error) {
	var encrypted, configJSON string
	err = d.Store.DB().QueryRow(
		`SELECT secret_enc, config_json, updated_at FROM user_integrations
		  WHERE user_id = ? AND provider = ?`, userID, provider).
		Scan(&encrypted, &configJSON, &updatedAt)
	if err != nil {
		return "", nil, "", err
	}
	config = map[string]any{}
	json.Unmarshal([]byte(configJSON), &config)

	if encrypted != "" {
		box, boxErr := d.box()
		if boxErr != nil {
			return "", config, updatedAt, boxErr
		}
		secret, err = box.Decrypt(encrypted)
		if err != nil {
			// A credential that will not decrypt is reported as absent rather
			// than as an error: the user's path forward is to set it again.
			return "", config, updatedAt, nil
		}
	}
	return secret, config, updatedAt, nil
}

func (d *Deps) writeIntegration(userID, provider, secret string, config map[string]any) error {
	box, err := d.box()
	if err != nil {
		return err
	}
	encrypted, err := box.Encrypt(secret)
	if err != nil {
		return err
	}
	configJSON, _ := json.Marshal(config)

	// The users row is a foreign key here.
	_, err = d.Store.DB().Exec(
		`INSERT INTO user_integrations (user_id, provider, secret_enc, config_json, updated_at)
		 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
		 ON CONFLICT(user_id, provider) DO UPDATE SET
		   secret_enc = excluded.secret_enc,
		   config_json = excluded.config_json,
		   updated_at = CURRENT_TIMESTAMP`,
		userID, provider, encrypted, string(configJSON))
	return err
}

func stringSlice(value any) []string {
	items, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(items))
	for _, item := range items {
		if s, ok := item.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

// --- runtime status ---

// directCLIStatus reports which agents are usable.
//
// When an agent host is configured, it is ASKED rather than the local filesystem
// probed: a containerized backend is being asked about a machine it cannot see,
// and probing itself reports every agent missing while the host beside it has
// all four working — a red page describing a healthy system.
func (d *Deps) directCLIStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, d.agentStatus(r))
}

// agentStatus prefers the agent host, falling back to a local probe.
//
// A host that is configured but unreachable is REPORTED, not silently replaced
// by the local answer: "every agent missing" and "the machine that has them is
// not answering" send an operator to entirely different places.
func (d *Deps) agentStatus(r *http.Request) hostops.RuntimeStatus {
	host := agenthost.Configured()
	if host == "" {
		return d.prober().DirectCLIStatus()
	}

	status, err := agenthost.NewClient().Agents(r.Context())
	if err != nil {
		return hostops.RuntimeStatus{
			RuntimeID: "direct-cli", DisplayName: "Direct CLI Runtime",
			Status: "setup_required",
			// err already names the host, so this does not repeat it.
			Message: "Agents run on the agent host, and it is not reachable: " + err.Error(),
		}
	}
	return status
}

func (d *Deps) codexCLIStatus(w http.ResponseWriter, r *http.Request) {
	status := d.agentStatus(r)
	for _, agent := range status.AgentStatus {
		if agent.Key == "codex" {
			writeJSON(w, http.StatusOK, map[string]any{
				"runtime_id": "codex-cli", "display_name": "Codex CLI",
				"installed": agent.Installed, "available": agent.Installed && agent.Authenticated,
				"version": agent.Version, "executable_path": agent.ExecutablePath,
				"status": statusWord(agent), "message": agent.AuthNote,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"runtime_id": "codex-cli", "installed": false, "available": false, "status": "missing"})
}

func statusWord(agent hostops.AgentStatus) string {
	switch {
	case agent.Installed && agent.Authenticated:
		return "ready"
	case agent.Installed:
		return "setup_required"
	default:
		return "missing"
	}
}

func (d *Deps) launchdStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, d.service().Status())
}

func (d *Deps) launchdAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		svc := d.service()
		var result hostops.ServiceResult
		switch action {
		case "install":
			result = svc.Install()
		case "uninstall":
			result = svc.Uninstall()
		default:
			result = svc.Restart()
		}
		writeJSON(w, http.StatusOK, result)
	}
}

func (d *Deps) mcpList(w http.ResponseWriter, r *http.Request) {
	mcp := &hostops.MCP{}
	client := r.URL.Query().Get("client")
	servers := mcp.ListClaudeServers()
	if client == "codex" {
		servers = mcp.ListCodexServers()
	}
	if servers == nil {
		servers = []hostops.MCPServer{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "servers": servers})
}

func (d *Deps) mcpAdd(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name   string         `json:"name"`
		Config map[string]any `json:"config"`
		URL    string         `json:"url"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "A server name is required.")
		return
	}
	config := req.Config
	if config == nil {
		config = map[string]any{"url": req.URL}
	}
	if err := (&hostops.MCP{}).AddClaudeServer(req.Name, config); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": req.Name})
}

func (d *Deps) mcpRemove(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := (&hostops.MCP{}).RemoveClaudeServer(name); err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name})
}

// integrationKey loads the Fernet key, generating it on first use.
//
// Read from the same file the Python backend uses, so credentials saved by
// either are readable by both during cutover.
//
// Created with 0600 FROM THE START, not chmod'd afterwards: a key that is
// briefly world-readable is a key that leaked, and the window is exactly when
// the file is most predictable.
func (d *Deps) integrationKey() (string, error) {
	path := d.SecretsPath
	if path == "" {
		path = defaultSecretsPath(d.DBPath)
	}

	body, err := os.ReadFile(path)
	if err == nil {
		if key := strings.TrimSpace(string(body)); key != "" {
			return key, nil
		}
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	key, err := secretbox.GenerateKey()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return "", err
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err := file.WriteString(key); err != nil {
		return "", err
	}
	return key, nil
}

// defaultSecretsPath mirrors Python: a `secrets` directory beside `data`.
func defaultSecretsPath(dbPath string) string {
	dataDir := filepath.Dir(dbPath)
	if dataDir == "" || dataDir == "." {
		dataDir = "data"
	}
	return filepath.Join(filepath.Dir(dataDir), "secrets", "integration_secret.key")
}

// currentBinary is the path launchd should supervise.
func currentBinary() string {
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			return resolved
		}
		return exe
	}
	return "specter"
}

// --- docker sandbox ---

func (d *Deps) sandbox() *hostops.Sandbox {
	if d.Sandbox != nil {
		return d.Sandbox
	}
	return &hostops.Sandbox{}
}

// sandboxStatus reports the Docker Sandbox runtime, asking the agent host when
// one is configured — sbx is installed on the host, and a container probing
// itself reports "not installed" for a CLI that is right there.
func (d *Deps) sandboxStatus(w http.ResponseWriter, r *http.Request) {
	if agenthost.Configured() != "" {
		status, err := agenthost.NewClient().Sandbox(r.Context())
		if err != nil {
			writeJSON(w, http.StatusOK, hostops.SandboxStatus{
				RuntimeID: "docker-sandbox", DisplayName: "Docker Sandbox Runtime",
				Status:  "missing",
				Message: "Docker Sandbox runs on the agent host: " + err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, status)
		return
	}
	writeJSON(w, http.StatusOK, d.sandbox().Status())
}

func (d *Deps) sandboxDaemonStart(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, d.sandbox().StartDaemon())
}

func (d *Deps) sandboxPolicy(w http.ResponseWriter, r *http.Request) {
	if agenthost.Configured() != "" {
		policy, err := agenthost.NewClient().SandboxPolicy(r.Context())
		if err != nil {
			// The policy is unknown, not permissive. Reporting a specific policy
			// from a host that did not answer would tell the user their network
			// is in a state it may not be in.
			writeJSON(w, http.StatusOK, hostops.PolicyStatus{
				Status: "missing", Message: "Docker Sandbox runs on the agent host: " + err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, policy)
		return
	}
	writeJSON(w, http.StatusOK, d.sandbox().PolicyStatus())
}

func (d *Deps) setSandboxPolicy(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Policy string `json:"policy"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	result := d.sandbox().SetPolicy(req.Policy)
	if !result.OK {
		// A rejected policy is the caller's mistake, not a server failure.
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok": false, "status": "rejected", "message": result.Message,
			"available_policies": hostops.PolicyValues,
		})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// --- repositories ---

func (d *Deps) discoverRepositories(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RootPath   string `json:"root_path"`
		MaxDepth   int    `json:"max_depth"`
		MaxResults int    `json:"max_results"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK,
		hostops.DiscoverRepositories(req.RootPath, req.MaxDepth, req.MaxResults))
}

// --- host runner compatibility ---
//
// These endpoints described a SEPARATE PROCESS that no longer exists. They are
// kept because the frontend still calls them, and answer honestly about the
// current architecture rather than 404ing a settings page into an error state.

func (d *Deps) hostRunnerVersion(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "version": Version, "embedded": true,
		"message": "The runner is built into this backend; there is no separate process to update.",
	})
}

func (d *Deps) hostRunnerMode(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "mode": "safe", "embedded": true,
		"message": "Agents run in-process. Maintenance mode belonged to the standalone runner.",
	})
}

func (d *Deps) hostRunnerLogs(w http.ResponseWriter, r *http.Request) {
	// Run logs are per-run and already exposed; there is no separate runner log
	// to tail. Answering with an empty list beats a 404 that blanks the panel.
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "entries": []any{}, "embedded": true})
}

// agentModels reports the models each installed CLI actually supports.
//
// This used to name the installed agents and hand back an empty list for each,
// so the Models page was permanently blank. Discovery lives in internal/models
// and is shared with `specter models` — the previous split, where the real
// implementation sat behind an HTTP hop, is how it was lost in the port without
// anything failing to compile.
func (d *Deps) agentModels(w http.ResponseWriter, r *http.Request) {
	refresh := r.URL.Query().Get("refresh") == "true"

	// Shaped to the contract the frontend already reads (AgentModelsResult):
	// `agents` keyed by agent name, each carrying its own count, families and
	// error. The error travels WITH the set — "signed out" and "no models" are
	// different states, and collapsing them is what made a working install look
	// broken.
	// Asked of the agent host when there is one, for the same reason as agent
	// status: the container has no CLIs to interrogate.
	catalogues := models.All(refresh)
	if agenthost.Configured() != "" {
		fromHost, err := agenthost.NewClient().Models(r.Context(), refresh)
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok": false, "agents": map[string]any{},
				"error": "Models are listed by the agent host: " + err.Error(),
			})
			return
		}
		catalogues = fromHost
	}

	agents := make(map[string]any, len(models.Agents()))
	for _, c := range catalogues {
		seen := map[string]bool{}
		families := []string{}
		for _, m := range c.Models {
			if m.Family != "" && !seen[m.Family] {
				seen[m.Family] = true
				families = append(families, m.Family)
			}
		}
		sort.Strings(families)

		agents[c.Agent] = map[string]any{
			"agent": c.Agent, "source": c.Source, "models": c.Models,
			"count": len(c.Models), "error": c.Error, "families": families,
			"cached": !refresh,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "agents": agents, "ttl_seconds": int(models.CacheTTL.Seconds()),
	})
}

// Version is stamped at build time.
var Version = "dev"

// listCodexRuns returns runs started through the runtime-adapters surface.
// Every run is a workflow run now, so this reads the same table the rest of the
// API does rather than a parallel one.
func (d *Deps) listCodexRuns(w http.ResponseWriter, r *http.Request) {
	d.listRuns(w, r)
}

// --- the remaining runtime-adapter surface ---

// telegramDiscoverChats asks Telegram which chats have messaged the bot, so the
// user does not have to hand-curl a token URL to find their chat id.
func (d *Deps) telegramDiscoverChats(w http.ResponseWriter, r *http.Request) {
	var req struct {
		BotToken string `json:"bot_token"`
	}
	decode(r, &req)

	botToken := strings.TrimSpace(req.BotToken)
	if botToken == "" {
		// Falls back to the stored credential, so the UI never has to hold it.
		if user := userFrom(r); user != nil {
			botToken, _, _, _ = d.readIntegration(user.ID, "telegram")
		}
	}
	if botToken == "" {
		writeError(w, http.StatusBadRequest, "A bot token is required.")
		return
	}
	writeJSON(w, http.StatusOK, hostops.DiscoverTelegramChats(botToken))
}

func (d *Deps) parseRepository(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL string `json:"url"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	parsed, err := hostops.ParseRepositoryURL(req.URL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, parsed)
}

func (d *Deps) cloneRepository(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL         string `json:"url"`
		Destination string `json:"destination"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	// The destination must already be approved: cloning writes to disk, so an
	// unchecked path lets a caller write anywhere the process can reach.
	destination, err := d.approvedWorkspace(req.Destination)
	if err != nil {
		writeError(w, http.StatusForbidden, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, hostops.CloneRepository(req.URL, destination))
}

// installCodexCLI and upgradeCodexCLI are refused rather than performed.
//
// Installing software is the user's decision on their own machine, and doing it
// from a web request means an HTTP call mutates the host's toolchain. The
// command is returned so the UI can show exactly what to run.
func (d *Deps) codexInstaller(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "manual": true,
			"command": "npm install -g @openai/codex",
			"message": "Run this in a terminal to " + action +
				" the Codex CLI. Specter does not install software on your machine for you.",
		})
	}
}

func (d *Deps) mcpLoginInstructions(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	writeJSON(w, http.StatusOK, map[string]any{
		"ok": true, "name": name,
		"command": "claude mcp add " + name,
		"message": "Run this in a terminal, then sign in when prompted.",
	})
}

// startCodexRun and the security-review demo both start a real workflow run.
// The demo used to be a canned event stream; it now goes through the same path
// as everything else rather than pretending.
func (d *Deps) startCodexRun(w http.ResponseWriter, r *http.Request) {
	d.startRun(w, r)
}
