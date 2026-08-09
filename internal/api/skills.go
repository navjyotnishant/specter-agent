// Handlers for /api/skills, ported from backend/app/routers/skills.py.
package api

import (
	"database/sql"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
)

type skillRequest struct {
	Name                 string   `json:"name"`
	Description          string   `json:"description"`
	PromptTemplate       string   `json:"prompt_template"`
	CompatibleAgentRoles []string `json:"compatible_agent_roles"`
	// A repo import supplies a slug so an imported skill resolves by the same key
	// the source repo uses, and upserts so a re-import updates in place rather
	// than duplicating.
	ID         *string `json:"id"`
	Upsert     bool    `json:"upsert"`
	SourceRepo string  `json:"source_repo"`
}

type skill struct {
	ID                   string `json:"id"`
	Name                 string `json:"name"`
	Description          string `json:"description"`
	PromptTemplate       string `json:"prompt_template"`
	CompatibleAgentRoles string `json:"compatible_agent_roles"`
	SourceRepo           string `json:"source_repo"`
	CreatedAt            string `json:"created_at"`
}

// pythonListRepr formats a slice the way Python's str(list) does — single
// quotes, comma-space separated.
//
// This is deliberate and load-bearing. Python writes str(request.compatible_
// agent_roles) into the column, and src/lib/types.ts types the field as
// `string`, so the UI renders it VERBATIM and never parses it. Existing rows
// hold "['Codex CLI', 'read-only']". Emitting real JSON here would silently
// change what every existing skill displays, with nothing failing to say so.
func pythonListRepr(items []string) string {
	if len(items) == 0 {
		return "[]"
	}
	quoted := make([]string, len(items))
	for i, item := range items {
		// Python's repr escapes a contained single quote by switching to double
		// quotes for the whole string; that nuance does not arise for role names
		// and is not reproduced here.
		quoted[i] = "'" + strings.ReplaceAll(item, "'", `\'`) + "'"
	}
	return "[" + strings.Join(quoted, ", ") + "]"
}

const skillColumns = `id, name, description, prompt_template, compatible_agent_roles, source_repo, created_at`

func scanSkill(row interface{ Scan(...any) error }) (skill, error) {
	var s skill
	err := row.Scan(&s.ID, &s.Name, &s.Description, &s.PromptTemplate,
		&s.CompatibleAgentRoles, &s.SourceRepo, &s.CreatedAt)
	return s, err
}

func (d *Deps) getSkillByID(id string) (skill, error) {
	return scanSkill(d.Store.DB().QueryRow(
		`SELECT `+skillColumns+` FROM skills WHERE id = ?`, id))
}

func (d *Deps) listSkills(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(`SELECT ` + skillColumns + ` FROM skills ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list skills")
		return
	}
	defer rows.Close()

	out := []skill{}
	for rows.Next() {
		s, err := scanSkill(rows)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read skills")
			return
		}
		out = append(out, s)
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) getSkill(w http.ResponseWriter, r *http.Request) {
	s, err := d.getSkillByID(chi.URLParam(r, "skillID"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "Skill not found")
		return
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the skill")
		return
	}
	writeJSON(w, http.StatusOK, s)
}

// rejectDuplicateSkillName enforces case-insensitive uniqueness: names are how
// a skill is picked in the builder, so two called the same thing are
// indistinguishable there.
func (d *Deps) rejectDuplicateSkillName(name, excludeID string) error {
	var clashID string
	err := d.Store.DB().QueryRow(
		`SELECT id FROM skills WHERE LOWER(name) = LOWER(?) AND id != ?`,
		strings.TrimSpace(name), excludeID).Scan(&clashID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	return errors.New("A skill named '" + strings.TrimSpace(name) + "' already exists (id '" + clashID + "').")
}

var skillSlug = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,79}$`)

func (d *Deps) createSkill(w http.ResponseWriter, r *http.Request) {
	var req skillRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if len(name) > 140 {
		writeError(w, http.StatusBadRequest, "Name must be 140 characters or fewer")
		return
	}

	id := uuid.NewString()
	if req.ID != nil && *req.ID != "" {
		if !skillSlug.MatchString(*req.ID) {
			writeError(w, http.StatusBadRequest,
				"Id must be lowercase letters, digits, dot, dash or underscore")
			return
		}
		id = *req.ID
	}

	if err := d.rejectDuplicateSkillName(name, id); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	var existing string
	err := d.Store.DB().QueryRow(`SELECT id FROM skills WHERE id = ?`, id).Scan(&existing)
	exists := err == nil

	if exists && !req.Upsert {
		writeError(w, http.StatusConflict, "Skill '"+id+"' already exists.")
		return
	}

	roles := pythonListRepr(req.CompatibleAgentRoles)
	if exists {
		_, err = d.Store.DB().Exec(
			`UPDATE skills SET name = ?, description = ?, prompt_template = ?,
			        compatible_agent_roles = ?, source_repo = ?
			  WHERE id = ?`,
			name, req.Description, req.PromptTemplate, roles, req.SourceRepo, id)
	} else {
		_, err = d.Store.DB().Exec(
			`INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles, source_repo)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			id, name, req.Description, req.PromptTemplate, roles, req.SourceRepo)
	}
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not save the skill")
		return
	}

	s, err := d.getSkillByID(id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read the saved skill")
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (d *Deps) updateSkill(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "skillID")
	var req skillRequest
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "Name is required")
		return
	}
	if err := d.rejectDuplicateSkillName(name, id); err != nil {
		writeError(w, http.StatusConflict, err.Error())
		return
	}

	res, err := d.Store.DB().Exec(
		`UPDATE skills SET name = ?, description = ?, prompt_template = ?,
		        compatible_agent_roles = ?, source_repo = ?
		  WHERE id = ?`,
		name, req.Description, req.PromptTemplate,
		pythonListRepr(req.CompatibleAgentRoles), req.SourceRepo, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the skill")
		return
	}
	if n, _ := res.RowsAffected(); n == 0 {
		writeError(w, http.StatusNotFound, "Skill not found")
		return
	}

	s, err := d.getSkillByID(id)
	if err != nil {
		writeError(w, http.StatusNotFound, "Skill not found")
		return
	}
	writeJSON(w, http.StatusOK, s)
}

func (d *Deps) deleteSkill(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "skillID")
	res, err := d.Store.DB().Exec(`DELETE FROM skills WHERE id = ?`, id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the skill")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "skill_id": id})
}
