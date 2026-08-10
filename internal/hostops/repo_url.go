package hostops

import (
	"context"
	"errors"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	execpkg "github.com/navjyotnishant/specter-agent/internal/exec"
)

type ParsedRepository struct {
	OK       bool   `json:"ok"`
	URL      string `json:"url"`
	Host     string `json:"host"`
	Owner    string `json:"owner"`
	Name     string `json:"name"`
	CloneURL string `json:"clone_url"`
}

// ParseRepositoryURL accepts the forms people actually paste: an https URL, an
// scp-style git address, or owner/name.
func ParseRepositoryURL(raw string) (ParsedRepository, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return ParsedRepository{}, errors.New("A repository URL is required.")
	}
	value = strings.TrimSuffix(value, ".git")

	// scp-style: git@github.com:owner/name
	if strings.HasPrefix(value, "git@") {
		hostPart, pathPart, found := strings.Cut(strings.TrimPrefix(value, "git@"), ":")
		if !found {
			return ParsedRepository{}, errors.New("That does not look like a repository address.")
		}
		owner, name, ok := splitOwnerName(pathPart)
		if !ok {
			return ParsedRepository{}, errors.New("That address is missing an owner or repository name.")
		}
		return ParsedRepository{
			OK: true, URL: raw, Host: hostPart, Owner: owner, Name: name,
			// https, not ssh: the clone path uses the gh credential helper, and
			// ~/.ssh is denied to confined runs.
			CloneURL: "https://" + hostPart + "/" + owner + "/" + name + ".git",
		}, nil
	}

	if strings.Contains(value, "://") {
		parsed, err := url.Parse(value)
		if err != nil || parsed.Host == "" {
			return ParsedRepository{}, errors.New("That does not look like a repository URL.")
		}
		owner, name, ok := splitOwnerName(strings.Trim(parsed.Path, "/"))
		if !ok {
			return ParsedRepository{}, errors.New("That URL is missing an owner or repository name.")
		}
		return ParsedRepository{
			OK: true, URL: raw, Host: parsed.Host, Owner: owner, Name: name,
			CloneURL: "https://" + parsed.Host + "/" + owner + "/" + name + ".git",
		}, nil
	}

	// Bare owner/name defaults to GitHub, which is what people mean.
	owner, name, ok := splitOwnerName(value)
	if !ok {
		return ParsedRepository{}, errors.New("Use owner/name, or a full repository URL.")
	}
	return ParsedRepository{
		OK: true, URL: raw, Host: "github.com", Owner: owner, Name: name,
		CloneURL: "https://github.com/" + owner + "/" + name + ".git",
	}, nil
}

func splitOwnerName(path string) (owner, name string, ok bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 2 || parts[0] == "" || parts[len(parts)-1] == "" {
		return "", "", false
	}
	return parts[0], parts[len(parts)-1], true
}

type CloneResult struct {
	OK      bool   `json:"ok"`
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

// CloneRepository clones into an ALREADY-APPROVED destination.
//
// The caller checks the allowlist; this does not, because it cannot see the
// database. Calling it with an unchecked path writes wherever the process can
// reach.
func CloneRepository(rawURL, destination string) CloneResult {
	parsed, err := ParseRepositoryURL(rawURL)
	if err != nil {
		return CloneResult{Message: err.Error()}
	}
	target := filepath.Join(destination, parsed.Name)

	result := execpkg.RunStreaming(context.Background(), execpkg.Command{
		// The gh credential helper, so a private repository works without SSH
		// keys — which confined runs cannot read anyway.
		Argv: []string{"git", "-c", "credential.helper=!gh auth git-credential",
			"clone", parsed.CloneURL, target},
		Dir:     destination,
		Timeout: 5 * time.Minute,
	})
	if result.TimedOut {
		return CloneResult{Message: "The clone took too long and was stopped."}
	}
	if !result.OK() {
		detail := strings.TrimSpace(result.Stderr)
		if detail == "" {
			detail = "the clone failed"
		}
		return CloneResult{Message: lastRunes(detail, 2000)}
	}
	return CloneResult{OK: true, Path: target, Message: "Cloned into " + target + "."}
}
