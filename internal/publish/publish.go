// Package publish turns a read-write run's work into a pull request.
//
// An agent's changes arrive as a branch and a PR, never as edits already applied
// to the branch you are on. The point is that you review before it is yours —
// "the agent changed your working tree while you were at lunch" is the outcome
// this exists to prevent.
package publish

import (
	"fmt"
	"os/exec"
	"strings"
)

// ScratchDir is the per-run temp directory confinement creates inside the
// workspace. Never part of an agent's work, and must never reach a commit.
const ScratchDir = ".specter-tmp"

// Result describes what was published.
type Result struct {
	Committed    bool   `json:"committed"`
	FilesChanged int    `json:"files_changed"`
	Branch       string `json:"branch,omitempty"`
	PushedTo     string `json:"pushed_to,omitempty"`
	PullRequest  string `json:"pull_request,omitempty"`
	// Set when the branch exists but could not be published — the work is safe
	// locally, and the user needs to know how to pick it up.
	Manual string `json:"manual,omitempty"`
}

// Commit records whatever the agent changed.
//
// Nothing to commit is a success with Committed false: an agent that decided no
// change was needed did its job, and reporting that as an error would be wrong.
func Commit(repoDir, branch, objective string) (Result, error) {
	changed, err := changedFiles(repoDir)
	if err != nil {
		return Result{}, err
	}
	if changed == 0 {
		return Result{Committed: false, Branch: branch}, nil
	}

	// Exclude the run's own scratch directory. Confinement redirects TMPDIR into
	// the workspace (a shared temp root would let one run write into another's),
	// so `add -A` alone swept hundreds of Node cache files into the commit
	// alongside the agent's actual one-line edit.
	if out, err := git(repoDir, "add", "-A", ":(exclude).specter-tmp"); err != nil {
		return Result{}, fmt.Errorf("staging changes: %w\n%s", err, out)
	}

	// The message names its origin. A reviewer finding this branch months later
	// should not have to work out what produced it.
	message := fmt.Sprintf("%s\n\nProduced by a Specter agent run.\nObjective: %s\n",
		firstLine(objective), objective)

	if out, err := git(repoDir, "commit", "-m", message); err != nil {
		return Result{}, fmt.Errorf("committing: %w\n%s", err, out)
	}
	return Result{Committed: true, FilesChanged: changed, Branch: branch}, nil
}

// Push sends the branch to the remote over HTTPS, using gh for credentials.
//
// HTTPS specifically, and gh as the credential helper, because confinement
// denies ~/.ssh — an SSH remote cannot authenticate from inside a confined run.
// gh keeps its token in the OS keyring rather than on disk, so it still works.
//
// The user's own remote is never rewritten: the HTTPS URL is passed to this one
// push. Changing a developer's remote as a side effect of running an agent would
// be an unpleasant surprise.
func Push(repoDir, branch string) (string, error) {
	origin, err := git(repoDir, "remote", "get-url", "origin")
	if err != nil {
		return "", fmt.Errorf("this repository has no origin remote")
	}

	remote, err := httpsRemote(strings.TrimSpace(origin))
	if err != nil {
		return "", err
	}

	out, err := git(repoDir,
		"-c", "credential.helper=!gh auth git-credential",
		"push", "--set-upstream", remote, branch)
	if err != nil {
		return "", fmt.Errorf("pushing %s: %w\n%s", branch, err, out)
	}
	return remote, nil
}

// OpenPR creates a draft pull request.
//
// Draft, always. The agent proposes; a person decides when it is ready for
// review, and a non-draft PR can trigger CI, reviewers and notifications that
// nobody asked for.
func OpenPR(repoDir, branch, title, body string) (string, error) {
	if !ghAvailable() {
		return "", fmt.Errorf("gh is not installed")
	}
	out, err := run(repoDir, "gh", "pr", "create",
		"--draft", "--head", branch, "--title", title, "--body", body)
	if err != nil {
		return "", fmt.Errorf("creating the pull request: %w\n%s", err, out)
	}
	// gh prints the URL last.
	lines := strings.Fields(strings.TrimSpace(out))
	if len(lines) == 0 {
		return "", fmt.Errorf("gh reported no pull request URL")
	}
	return lines[len(lines)-1], nil
}

// httpsRemote converts a git remote to an HTTPS URL.
//
// An unrecognised host is an error rather than a guess. Pushing somewhere
// unintended is far worse than refusing and telling the user the branch name.
func httpsRemote(origin string) (string, error) {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return "", fmt.Errorf("no remote configured")
	}
	origin = strings.TrimSuffix(origin, ".git")

	switch {
	case strings.HasPrefix(origin, "https://"):
		return origin, nil

	case strings.HasPrefix(origin, "ssh://git@"):
		rest := strings.TrimPrefix(origin, "ssh://git@")
		return "https://" + rest, nil

	case strings.HasPrefix(origin, "git@"):
		// scp-style: git@host:owner/repo
		rest := strings.TrimPrefix(origin, "git@")
		host, path, found := strings.Cut(rest, ":")
		if !found || host == "" || path == "" {
			return "", fmt.Errorf("cannot derive an HTTPS URL from %q", origin)
		}
		return "https://" + host + "/" + path, nil
	}
	return "", fmt.Errorf("unsupported remote %q — expected an https or ssh git remote", origin)
}

func changedFiles(repoDir string) (int, error) {
	// --porcelain includes untracked files: an agent that only ADDS files has
	// still done work, and missing that would silently discard it.
	out, err := git(repoDir, "status", "--porcelain")
	if err != nil {
		return 0, fmt.Errorf("reading repository status: %w", err)
	}
	count := 0
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		// The scratch directory is not the agent's work.
		if strings.Contains(trimmed, ScratchDir) {
			continue
		}
		count++
	}
	return count, nil
}

func ghAvailable() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

func git(dir string, args ...string) (string, error) {
	return run(dir, "git", args...)
}

func run(dir, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	if len(line) > 68 {
		line = line[:68]
	}
	if line == "" {
		return "Specter agent changes"
	}
	return line
}
