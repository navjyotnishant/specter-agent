// Package models discovers which models each installed agent CLI supports.
//
// Author: Navjyot Nishant
// Created: 2026-08-11
// Last updated: 2026-08-11
// Description: runtime model discovery, shared by the CLI and the HTTP API.
//
// WHY THIS IS A PACKAGE AND NOT AN HTTP HANDLER
// The previous implementation lived inside the Python host runner and was
// reachable only by proxying to it over HTTP. When that process was deleted the
// endpoint survived with an empty body, and nothing failed to compile because
// nothing referenced the implementation. `specter status` and the Models page
// now call the same function in-process, so a gap in one is a gap in both.
//
// EVERY LIST IS DISCOVERED, NEVER HARDCODED
// A baked-in list drifts from what the CLI actually accepts, and the failure is
// silent: a run is configured with a model name the agent rejects at spawn time.
// Asking the CLI costs seconds, which is what the cache is for.
package models

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
)

// Model is one model an agent CLI accepts.
type Model struct {
	Slug        string `json:"slug"`
	DisplayName string `json:"display_name"`
	Family      string `json:"family"`
	Description string `json:"description,omitempty"`
	// Efforts are the reasoning levels a model supports, where the CLI reports
	// them. Only Codex does today.
	Efforts       []string `json:"efforts,omitempty"`
	DefaultEffort string   `json:"default_effort,omitempty"`
}

// AgentModels is one agent's catalogue, or the reason there isn't one.
//
// An error is data rather than a failure: "signed out" and "no models" are
// different states, and collapsing them into an empty list is what made the
// Models page look broken when it was merely unauthenticated.
type AgentModels struct {
	Agent  string  `json:"agent"`
	Source string  `json:"source"`
	Models []Model `json:"models"`
	Error  string  `json:"error,omitempty"`
}

// families maps a substring of a slug to the family it belongs to. Ordered,
// because "codex" must beat "gpt" for a slug like gpt-5-codex.
var families = []struct{ needle, label string }{
	{"claude", "Claude"}, {"opus", "Claude"}, {"sonnet", "Claude"},
	{"haiku", "Claude"}, {"fable", "Claude"},
	{"codex", "GPT"}, {"gpt", "GPT"}, {"o1", "GPT"}, {"o3", "GPT"}, {"o4", "GPT"},
	{"gemini", "Gemini"}, {"grok", "Grok"}, {"composer", "Composer"},
	{"deepseek", "DeepSeek"}, {"kimi", "Kimi"}, {"qwen", "Qwen"}, {"llama", "Llama"},
}

func family(slug string) string {
	lowered := strings.ToLower(slug)
	for _, f := range families {
		if strings.Contains(lowered, f.needle) {
			return f.label
		}
	}
	return "Other"
}

// probeTimeout bounds a single CLI call. `cursor-agent models` and
// `ant models list` both take seconds; a hung one must not hold the page.
const probeTimeout = 45 * time.Second

// cacheTTL is how long a discovered catalogue is reused. Long enough that
// opening the Models page twice does not spawn six subprocesses, short enough
// that a newly released model appears the same day.
// CacheTTL is exported so the API can tell a client how long a list stays warm.
const CacheTTL = 10 * time.Minute

type cacheEntry struct {
	at     time.Time
	result AgentModels
}

var (
	cacheMu sync.Mutex
	cache   = map[string]cacheEntry{}
)

// Agents are the agents that can report a model list, in display order.
func Agents() []string { return []string{"claude", "codex", "cursor"} }

// For returns one agent's models, using the cache unless refresh is set.
func For(agent string, refresh bool) AgentModels {
	if !refresh {
		cacheMu.Lock()
		entry, ok := cache[agent]
		cacheMu.Unlock()
		if ok && time.Since(entry.at) < CacheTTL {
			return entry.result
		}
	}

	var result AgentModels
	switch agent {
	case "claude":
		result = fromAnt()
	case "cursor":
		result = fromCursor()
	case "codex":
		result = fromCodexCache()
	default:
		return AgentModels{Agent: agent, Error: "no model source for " + agent}
	}
	result.Agent = agent

	for i := range result.Models {
		result.Models[i].Family = family(result.Models[i].Slug)
	}

	cacheMu.Lock()
	cache[agent] = cacheEntry{at: time.Now(), result: result}
	cacheMu.Unlock()
	return result
}

// All returns every agent's catalogue. Probes run concurrently: three agents
// probed in sequence, each with a 45-second ceiling, is a two-minute page load
// in the worst case.
func All(refresh bool) []AgentModels {
	agents := Agents()
	out := make([]AgentModels, len(agents))
	var wg sync.WaitGroup
	for i, agent := range agents {
		wg.Add(1)
		go func(i int, agent string) {
			defer wg.Done()
			out[i] = For(agent, refresh)
		}(i, agent)
	}
	wg.Wait()
	return out
}

// fromAnt reads Claude's catalogue from the Anthropic CLI, which refreshes its
// own OAuth token — so this reports the models the account can actually use
// rather than a public list.
func fromAnt() AgentModels {
	out := AgentModels{Source: "ant models list", Models: []Model{}}

	exe := resolve("ant")
	if exe == "" {
		out.Error = "the ant CLI is not installed — Claude models cannot be listed"
		return out
	}

	result := run(exe, "models", "list", "--transform", "{id,display_name}", "--format", "jsonl")
	if result.err != "" {
		out.Error = "ant models list failed: " + result.err
		return out
	}

	for _, line := range strings.Split(result.stdout, "\n") {
		line = strings.TrimSpace(line)
		// Only object lines are rows; anything else is a header or a notice.
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var row struct {
			ID          string `json:"id"`
			DisplayName string `json:"display_name"`
		}
		if json.Unmarshal([]byte(line), &row) != nil || row.ID == "" {
			continue
		}
		name := row.DisplayName
		if name == "" {
			name = row.ID
		}
		out.Models = append(out.Models, Model{Slug: row.ID, DisplayName: name})
	}
	if len(out.Models) == 0 && out.Error == "" {
		out.Error = "ant returned no models — the CLI may not be signed in"
	}
	return out
}

// fromCursor parses `slug - Display Name`, one per line, under a header.
func fromCursor() AgentModels {
	out := AgentModels{Source: "cursor-agent models", Models: []Model{}}

	exe := resolve("cursor-agent", "cursor")
	if exe == "" {
		out.Error = "cursor-agent is not installed — Cursor models cannot be listed"
		return out
	}

	result := run(exe, "models")
	if result.err != "" {
		out.Error = "cursor-agent models failed: " + result.err
		return out
	}

	for _, line := range strings.Split(result.stdout, "\n") {
		slug, name, found := strings.Cut(strings.TrimSpace(line), " - ")
		// A slug never contains a space, which is what separates a real row from
		// the "Available models" header and any trailing prose.
		if !found || slug == "" || strings.Contains(slug, " ") {
			continue
		}
		display := strings.TrimSpace(name)
		if display == "" {
			display = slug
		}
		out.Models = append(out.Models, Model{Slug: slug, DisplayName: display})
	}
	if len(out.Models) == 0 && out.Error == "" {
		out.Error = "cursor-agent listed no models — it may not be signed in"
	}
	return out
}

// fromCodexCache reads the catalogue Codex writes for itself.
//
// Codex has no list command (openai/codex#8871, closed as not planned), but it
// caches its own catalogue on disk — richer than a hardcoded list, and it
// carries the per-model reasoning levels.
func fromCodexCache() AgentModels {
	out := AgentModels{Source: "~/.codex/models_cache.json", Models: []Model{}}

	home, err := os.UserHomeDir()
	if err != nil {
		out.Error = "no home directory, so the codex model cache cannot be found"
		return out
	}
	path := filepath.Join(home, ".codex", "models_cache.json")

	raw, err := os.ReadFile(path)
	if err != nil {
		out.Error = "no codex model cache at " + path + " — run codex once to create it"
		return out
	}

	var payload struct {
		Models []struct {
			Slug        string `json:"slug"`
			DisplayName string `json:"display_name"`
			Description string `json:"description"`
			Levels      []struct {
				Effort string `json:"effort"`
			} `json:"supported_reasoning_levels"`
			DefaultLevel string `json:"default_reasoning_level"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		out.Error = fmt.Sprintf("could not read the codex model cache: %v", err)
		return out
	}

	for _, entry := range payload.Models {
		if entry.Slug == "" {
			continue
		}
		name := entry.DisplayName
		if name == "" {
			name = entry.Slug
		}
		model := Model{
			Slug:          entry.Slug,
			DisplayName:   name,
			Description:   entry.Description,
			DefaultEffort: entry.DefaultLevel,
		}
		for _, level := range entry.Levels {
			if level.Effort != "" {
				model.Efforts = append(model.Efforts, level.Effort)
			}
		}
		out.Models = append(out.Models, model)
	}
	return out
}

type runResult struct {
	stdout string
	err    string
}

// run executes a CLI and folds a failure into a message rather than raising it.
// What matters is what the binary SAID; a non-zero exit with usable output is
// still usable.
func run(argv ...string) runResult {
	// context.Background(), not nil: RunStreaming derives a timeout from it, and
	// context.WithTimeout(nil, …) panics.
	result := execpkg.RunStreaming(context.Background(), execpkg.Command{
		Argv:    argv,
		Timeout: probeTimeout,
	})
	if result.TimedOut {
		return runResult{err: "timed out after " + probeTimeout.String()}
	}
	if result.ExitCode != 0 {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = strings.TrimSpace(result.Stdout)
		}
		if detail == "" {
			detail = "unknown error"
		}
		return runResult{stdout: result.Stdout, err: lastLine(detail)}
	}
	return runResult{stdout: result.Stdout}
}

// resolve finds a CLI the same way agent resolution does — explicit roots as
// well as PATH, because under launchd PATH is /usr/bin:/bin:/usr/sbin:/sbin and
// every Homebrew install is invisible.
func resolve(names ...string) string {
	if path := execpkg.ResolveCLI(names, nil); path != "" {
		return path
	}
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return ""
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
