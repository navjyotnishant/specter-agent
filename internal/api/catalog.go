// Handlers for the three catalog routers: agents, connectors, model-providers.
//
// Two serialization formats live side by side here, and that is deliberate:
//
//	agent_definitions.allowed_skill_ids   str(list)     ['a', 'b']
//	connectors.config_json                json.dumps()  {"a":"b"}
//
// Unifying them would be tidier and wrong. A row written by Go has to be
// readable by Python during cutover, and vice versa, so each column keeps
// whatever format Python already writes.
package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

// --- agents ---

type agentRequest struct {
	Name                    string   `json:"name"`
	Role                    string   `json:"role"`
	Description             string   `json:"description"`
	SystemInstructions      string   `json:"system_instructions"`
	DefaultProviderID       *string  `json:"default_provider_id"`
	DefaultModel            *string  `json:"default_model"`
	AllowedSkillIDs         []string `json:"allowed_skill_ids"`
	AllowedConnectorIDs     []string `json:"allowed_connector_ids"`
	MemoryScopeDefault      *string  `json:"memory_scope_default"`
	MaxIterations           *int     `json:"max_iterations"`
	RequiresApprovalDefault bool     `json:"requires_approval_default"`
}

type agentDefinition struct {
	ID                      string  `json:"id"`
	Name                    string  `json:"name"`
	Role                    string  `json:"role"`
	Description             string  `json:"description"`
	SystemInstructions      string  `json:"system_instructions"`
	DefaultProviderID       *string `json:"default_provider_id"`
	DefaultModel            *string `json:"default_model"`
	AllowedSkillIDs         string  `json:"allowed_skill_ids"`
	AllowedConnectorIDs     string  `json:"allowed_connector_ids"`
	MemoryScopeDefault      string  `json:"memory_scope_default"`
	MaxIterations           int     `json:"max_iterations"`
	RequiresApprovalDefault bool    `json:"requires_approval_default"`
	CreatedBy               *string `json:"created_by"`
	CreatedAt               string  `json:"created_at"`
	UpdatedAt               string  `json:"updated_at"`
}

const agentColumns = `id, name, role, description, system_instructions, default_provider_id,
	default_model, allowed_skill_ids, allowed_connector_ids, memory_scope_default,
	max_iterations, requires_approval_default, created_by, created_at, updated_at`

func scanAgent(row interface{ Scan(...any) error }) (agentDefinition, error) {
	var a agentDefinition
	var providerID, model, createdBy sql.NullString
	var requiresApproval int
	err := row.Scan(&a.ID, &a.Name, &a.Role, &a.Description, &a.SystemInstructions,
		&providerID, &model, &a.AllowedSkillIDs, &a.AllowedConnectorIDs,
		&a.MemoryScopeDefault, &a.MaxIterations, &requiresApproval,
		&createdBy, &a.CreatedAt, &a.UpdatedAt)
	if err != nil {
		return agentDefinition{}, err
	}
	a.RequiresApprovalDefault = requiresApproval != 0
	if providerID.Valid {
		a.DefaultProviderID = &providerID.String
	}
	if model.Valid {
		a.DefaultModel = &model.String
	}
	if createdBy.Valid {
		a.CreatedBy = &createdBy.String
	}
	return a, nil
}

func (d *Deps) listAgents(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(`SELECT ` + agentColumns + ` FROM agent_definitions ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list agents")
		return
	}
	defer rows.Close()
	out := []agentDefinition{}
	for rows.Next() {
		a, err := scanAgent(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read agents")
			return
		}
		out = append(out, a)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) getAgentByID(id string) (agentDefinition, error) {
	return scanAgent(d.Store.DB().QueryRow(
		`SELECT `+agentColumns+` FROM agent_definitions WHERE id = ?`, id))
}

func (d *Deps) getAgent(w http.ResponseWriter, r *http.Request) {
	a, err := d.getAgentByID(chi.URLParam(r, "agentID"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the agent")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (d *Deps) createAgent(w http.ResponseWriter, r *http.Request) {
	var req agentRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Role) == "" {
		writeError(w, http.StatusBadRequest, "Name and role are required")
		return
	}

	scope := "workflow"
	if req.MemoryScopeDefault != nil && *req.MemoryScopeDefault != "" {
		scope = *req.MemoryScopeDefault
	}
	iterations := 3
	if req.MaxIterations != nil {
		iterations = *req.MaxIterations
	}
	approval := 0
	if req.RequiresApprovalDefault {
		approval = 1
	}

	id := uuid.NewString()
	if _, err := d.Store.DB().Exec(
		`INSERT INTO agent_definitions
		   (id, name, role, description, system_instructions, default_provider_id,
		    default_model, allowed_skill_ids, allowed_connector_ids, memory_scope_default,
		    max_iterations, requires_approval_default, created_by)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, req.Name, req.Role, req.Description, req.SystemInstructions,
		req.DefaultProviderID, req.DefaultModel,
		pythonListRepr(req.AllowedSkillIDs), pythonListRepr(req.AllowedConnectorIDs),
		scope, iterations, approval, userFrom(r).ID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the agent")
		return
	}

	a, err := d.getAgentByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the new agent")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (d *Deps) updateAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "agentID")
	var req agentRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.Role) == "" {
		writeError(w, http.StatusBadRequest, "Name and role are required")
		return
	}

	existing, err := d.getAgentByID(id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Agent not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the agent")
		return
	}

	scope := existing.MemoryScopeDefault
	if req.MemoryScopeDefault != nil && *req.MemoryScopeDefault != "" {
		scope = *req.MemoryScopeDefault
	}
	iterations := existing.MaxIterations
	if req.MaxIterations != nil {
		iterations = *req.MaxIterations
	}
	approval := 0
	if req.RequiresApprovalDefault {
		approval = 1
	}

	if _, err := d.Store.DB().Exec(
		`UPDATE agent_definitions
		    SET name = ?, role = ?, description = ?, system_instructions = ?,
		        default_provider_id = ?, default_model = ?, allowed_skill_ids = ?,
		        allowed_connector_ids = ?, memory_scope_default = ?, max_iterations = ?,
		        requires_approval_default = ?, updated_at = CURRENT_TIMESTAMP
		  WHERE id = ?`,
		req.Name, req.Role, req.Description, req.SystemInstructions,
		req.DefaultProviderID, req.DefaultModel,
		pythonListRepr(req.AllowedSkillIDs), pythonListRepr(req.AllowedConnectorIDs),
		scope, iterations, approval, id); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the agent")
		return
	}

	a, err := d.getAgentByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "Agent not found")
		return
	}
	writeJSON(w, http.StatusOK, a)
}

func (d *Deps) deleteAgent(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "agentID")
	res, err := d.Store.DB().Exec(`DELETE FROM agent_definitions WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the agent")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "agent_id": id})
}

// --- connectors ---

type connectorRequest struct {
	Name          string          `json:"name"`
	ConnectorType string          `json:"connector_type"`
	Config        json.RawMessage `json:"config"`
	IsConfigured  bool            `json:"is_configured"`
}

type connector struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	ConnectorType string `json:"connector_type"`
	ConfigJSON    string `json:"config_json"`
	IsConfigured  bool   `json:"is_configured"`
	CreatedAt     string `json:"created_at"`
}

func scanConnector(row interface{ Scan(...any) error }) (connector, error) {
	var c connector
	var configured int
	err := row.Scan(&c.ID, &c.Name, &c.ConnectorType, &c.ConfigJSON, &configured, &c.CreatedAt)
	c.IsConfigured = configured != 0
	return c, err
}

func (d *Deps) listConnectors(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, name, connector_type, config_json, is_configured, created_at
		   FROM connectors ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list connectors")
		return
	}
	defer rows.Close()
	out := []connector{}
	for rows.Next() {
		c, err := scanConnector(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read connectors")
			return
		}
		out = append(out, c)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) createConnector(w http.ResponseWriter, r *http.Request) {
	var req connectorRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" || strings.TrimSpace(req.ConnectorType) == "" {
		writeError(w, http.StatusBadRequest, "Name and connector type are required")
		return
	}

	id := uuid.NewString()
	configured := 0
	if req.IsConfigured {
		configured = 1
	}
	if _, err := d.Store.DB().Exec(
		`INSERT INTO connectors (id, name, connector_type, config_json, is_configured)
		 VALUES (?, ?, ?, ?, ?)`,
		id, req.Name, req.ConnectorType, normalizeGraph(req.Config), configured); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the connector")
		return
	}
	c, err := scanConnector(d.Store.DB().QueryRow(
		`SELECT id, name, connector_type, config_json, is_configured, created_at FROM connectors WHERE id = ?`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the new connector")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (d *Deps) updateConnector(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "connectorID")
	var req connectorRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	configured := 0
	if req.IsConfigured {
		configured = 1
	}
	res, err := d.Store.DB().Exec(
		`UPDATE connectors SET name = ?, connector_type = ?, config_json = ?, is_configured = ?
		  WHERE id = ?`,
		req.Name, req.ConnectorType, normalizeGraph(req.Config), configured, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the connector")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Connector not found")
		return
	}
	c, err := scanConnector(d.Store.DB().QueryRow(
		`SELECT id, name, connector_type, config_json, is_configured, created_at FROM connectors WHERE id = ?`, id))
	if err != nil {
		writeError(w, http.StatusNotFound, "Connector not found")
		return
	}
	writeJSON(w, http.StatusOK, c)
}

func (d *Deps) deleteConnector(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "connectorID")
	res, err := d.Store.DB().Exec(`DELETE FROM connectors WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the connector")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "connector_id": id})
}

// --- model providers ---

var supportedProviderTypes = map[string]bool{
	"ollama": true, "openai-compatible": true, "anthropic-compatible": true,
}

type modelProviderRequest struct {
	Name         string  `json:"name"`
	ProviderType string  `json:"provider_type"`
	BaseURL      *string `json:"base_url"`
	IsConfigured bool    `json:"is_configured"`
}

type modelProvider struct {
	ID           string  `json:"id"`
	Name         string  `json:"name"`
	ProviderType string  `json:"provider_type"`
	BaseURL      *string `json:"base_url"`
	IsConfigured bool    `json:"is_configured"`
	CreatedAt    string  `json:"created_at"`
}

func scanProvider(row interface{ Scan(...any) error }) (modelProvider, error) {
	var p modelProvider
	var baseURL sql.NullString
	var configured int
	err := row.Scan(&p.ID, &p.Name, &p.ProviderType, &baseURL, &configured, &p.CreatedAt)
	if baseURL.Valid {
		p.BaseURL = &baseURL.String
	}
	p.IsConfigured = configured != 0
	return p, err
}

// validateBaseURL mirrors the Python validator: empty becomes null, and
// anything else must be a real http/https URL with a host. A malformed URL
// stored now surfaces as a connection failure much later, far from its cause.
func validateBaseURL(raw *string) (any, error) {
	if raw == nil || strings.TrimSpace(*raw) == "" {
		return nil, nil
	}
	normalized := strings.TrimSpace(*raw)
	parsed, err := url.Parse(normalized)
	if err != nil {
		return nil, errors.New("Base URL must be a valid HTTP or HTTPS URL.")
	}
	if (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, errors.New("Base URL must be a valid HTTP or HTTPS URL.")
	}
	return normalized, nil
}

func (d *Deps) listModelProviders(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, name, provider_type, base_url, is_configured, created_at
		   FROM model_providers ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list model providers")
		return
	}
	defer rows.Close()
	out := []modelProvider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read model providers")
			return
		}
		out = append(out, p)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) createModelProvider(w http.ResponseWriter, r *http.Request) {
	var req modelProviderRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if !supportedProviderTypes[strings.TrimSpace(req.ProviderType)] {
		writeError(w, http.StatusBadRequest, "Unsupported model provider type.")
		return
	}
	baseURL, err := validateBaseURL(req.BaseURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	id := uuid.NewString()
	configured := 0
	if req.IsConfigured {
		configured = 1
	}
	if _, err := d.Store.DB().Exec(
		`INSERT INTO model_providers (id, name, provider_type, base_url, is_configured)
		 VALUES (?, ?, ?, ?, ?)`,
		id, req.Name, strings.TrimSpace(req.ProviderType), baseURL, configured); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the model provider")
		return
	}
	p, err := scanProvider(d.Store.DB().QueryRow(
		`SELECT id, name, provider_type, base_url, is_configured, created_at FROM model_providers WHERE id = ?`, id))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the new provider")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (d *Deps) updateModelProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "providerID")
	var req modelProviderRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if !supportedProviderTypes[strings.TrimSpace(req.ProviderType)] {
		writeError(w, http.StatusBadRequest, "Unsupported model provider type.")
		return
	}
	baseURL, err := validateBaseURL(req.BaseURL)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	configured := 0
	if req.IsConfigured {
		configured = 1
	}
	res, err := d.Store.DB().Exec(
		`UPDATE model_providers SET name = ?, provider_type = ?, base_url = ?, is_configured = ?
		  WHERE id = ?`,
		req.Name, strings.TrimSpace(req.ProviderType), baseURL, configured, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the provider")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Model provider not found")
		return
	}
	p, err := scanProvider(d.Store.DB().QueryRow(
		`SELECT id, name, provider_type, base_url, is_configured, created_at FROM model_providers WHERE id = ?`, id))
	if err != nil {
		writeError(w, http.StatusNotFound, "Model provider not found")
		return
	}
	writeJSON(w, http.StatusOK, p)
}

func (d *Deps) deleteModelProvider(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "providerID")
	res, err := d.Store.DB().Exec(`DELETE FROM model_providers WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the provider")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "provider_id": id})
}
