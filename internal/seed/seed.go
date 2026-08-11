// Package seed installs the built-in skill library and workflow templates.
//
// Author: Navjyot Nishant
// Created: 2026-08-10
// Last updated: 2026-08-10
// Description: insert-if-missing seeding of built-in skills and workflow templates on startup.
//
// WHY THIS RUNS ON EVERY STARTUP
// A fresh database has no skills and no templates, so the palette and the
// template gallery are empty and the product looks broken before the user has
// done anything wrong. Seeding on startup means a new install, a wiped database
// and a container without a mounted volume all reach the same state.
//
// INSERT-IF-MISSING, NEVER UPDATE
// A seeded row is a starting point, not a managed resource. Once it exists the
// user owns it: edits survive every restart because an existing id is skipped
// outright rather than reconciled. The cost is that a deleted built-in comes
// back on the next start — edit it to a no-op instead of deleting it if you
// want it gone from prompts but not from the list.
//
// The skill ids here are byte-identical to the Python seeder's
// (backend/app/runtime/skill_seeds.py). That is deliberate: both backends can
// point at one database during cutover, and matching ids mean the second one to
// start finds the rows already there instead of inserting a duplicate set under
// different ids.
package seed

import (
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed data/skills.json
var skillsJSON []byte

//go:embed data/workflows.json
var workflowsJSON []byte

type skill struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Description    string `json:"description"`
	PromptTemplate string `json:"prompt_template"`
}

type workflow struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Graph       json.RawMessage `json:"graph"`
}

// Result reports what was actually inserted, so startup can log it.
type Result struct {
	Skills    int
	Workflows int
}

// Run inserts any missing built-in skills and workflow templates.
func Run(db *sql.DB) (Result, error) {
	var out Result

	var skills []skill
	if err := json.Unmarshal(skillsJSON, &skills); err != nil {
		return out, fmt.Errorf("embedded skills.json is not valid JSON: %w", err)
	}
	var workflows []workflow
	if err := json.Unmarshal(workflowsJSON, &workflows); err != nil {
		return out, fmt.Errorf("embedded workflows.json is not valid JSON: %w", err)
	}

	for _, s := range skills {
		inserted, err := insertIfMissing(db, "skills", s.ID,
			`INSERT INTO skills (id, name, description, prompt_template, compatible_agent_roles)
			 VALUES (?, ?, ?, ?, '[]')`,
			s.ID, s.Name, s.Description, s.PromptTemplate)
		if err != nil {
			return out, fmt.Errorf("seeding skill %s: %w", s.ID, err)
		}
		if inserted {
			out.Skills++
		}
	}

	for _, w := range workflows {
		// A template row is an ordinary workflow with is_template=1 — that flag
		// is the only thing the UI uses to separate the gallery from the user's
		// own workflows, so it is what makes a seeded row a template rather
		// than an unexplained workflow the user never created.
		inserted, err := insertIfMissing(db, "workflows", w.ID,
			`INSERT INTO workflows (id, name, description, graph_json, is_template)
			 VALUES (?, ?, ?, ?, 1)`,
			w.ID, w.Name, w.Description, string(w.Graph))
		if err != nil {
			return out, fmt.Errorf("seeding workflow template %s: %w", w.ID, err)
		}
		if inserted {
			out.Workflows++
		}
	}

	return out, nil
}

// insertIfMissing runs the insert only when no row already holds that id.
//
// The check and the insert are not in one transaction because they do not need
// to be: two backends racing on the same id both find nothing, both insert, and
// the second one loses to the PRIMARY KEY constraint. Treating that specific
// conflict as success is simpler than locking, and lands in the same state.
func insertIfMissing(db *sql.DB, table, id, insertSQL string, args ...any) (bool, error) {
	var existing string
	err := db.QueryRow("SELECT id FROM "+table+" WHERE id = ?", id).Scan(&existing)
	if err == nil {
		return false, nil
	}
	if err != sql.ErrNoRows {
		return false, err
	}
	if _, err := db.Exec(insertSQL, args...); err != nil {
		if isUniqueViolation(err) {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "constraint failed")
}
