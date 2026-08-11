// Package worktree gives each run its own checkout of the repository.
//
// An agent must not edit the repository you are working in. A bad run should
// cost a discarded directory, not your uncommitted work.
//
// git worktree rather than a copy: it is nearly free because git shares the
// object store, and — more importantly — it produces a real branch. A copy
// cannot, and the branch is what lets a read-write run arrive as a pull request
// rather than as edits already applied to your tree.
package worktree

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/specterhome"
)

type Mode string

const (
	ModeReadOnly  Mode = "read-only"
	ModeReadWrite Mode = "read-write"
)

type Method string

const (
	MethodWorktree Method = "worktree"
	MethodCopy     Method = "copy"
)

// Worktree is one run's isolated checkout.
type Worktree struct {
	Path   string // where the agent runs
	Branch string // "" for read-only — no branch is created
	Method Method // how it was made; a copy behaves differently and must say so
	Source string // the repository it came from
}

// Root is where run worktrees live. Under the state directory rather than
// beside the repository, so a run never puts anything inside the tree it is
// examining.
func Root() string {
	return specterhome.Path("runs")
}

// safeToken rejects anything that could escape the runs directory.
//
// The destination is derived from the token, never supplied by a caller — the
// same rule the repository clone helper follows. A token like "../../etc" would
// otherwise choose where files land on disk.
var safeToken = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// Prepare creates an isolated checkout for one run.
//
// Read-only gets a detached worktree: no branch, nothing left behind for a run
// that never intended to write. Read-write gets specter/<token>, which survives
// the worktree so its commits can be pushed and reviewed.
func Prepare(source, jobToken string, mode Mode) (*Worktree, error) {
	if !safeToken.MatchString(jobToken) {
		return nil, fmt.Errorf("job token %q is not a safe directory name", jobToken)
	}

	source, err := filepath.EvalSymlinks(source)
	if err != nil {
		return nil, fmt.Errorf("resolving %s: %w", source, err)
	}

	dest := filepath.Join(Root(), jobToken)
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return nil, fmt.Errorf("creating the runs directory: %w", err)
	}
	if _, err := os.Stat(dest); err == nil {
		return nil, fmt.Errorf("a run directory already exists at %s", dest)
	}

	if !isGitRepo(source) {
		// Not every approved workspace is a git repository. Copy, and record
		// that it was a copy — the caller must be able to tell, because a copy
		// has no branch and cannot produce a PR.
		if err := copyTree(source, dest); err != nil {
			return nil, err
		}
		return &Worktree{Path: dest, Method: MethodCopy, Source: source}, nil
	}

	branch := ""
	args := []string{"-C", source, "worktree", "add"}
	if mode == ModeReadWrite {
		branch = "specter/" + jobToken
		args = append(args, "-b", branch, dest)
	} else {
		// Detached: a read-only run needs no ref, and creating one would leave
		// a branch behind for every run that never wrote anything.
		args = append(args, "--detach", dest)
	}

	if out, err := exec.Command("git", args...).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("creating worktree: %w\n%s", err, out)
	}

	return &Worktree{Path: dest, Branch: branch, Method: MethodWorktree, Source: source}, nil
}

// Remove tears the worktree down.
//
// Never touches the source repository. `git worktree remove` is used rather than
// deleting the directory, so git's own bookkeeping stays consistent — a stale
// worktree entry makes later `git worktree add` calls fail with a confusing
// message about a path that no longer exists.
func (w *Worktree) Remove() error {
	if w == nil || w.Path == "" {
		return nil
	}

	if w.Method == MethodWorktree {
		// --force because the agent has almost certainly left changes; that is
		// the point of the worktree.
		if out, err := exec.Command("git", "-C", w.Source, "worktree", "remove", "--force", w.Path).
			CombinedOutput(); err != nil {
			// Fall through to a plain delete: leaving the directory behind is
			// worse than a stale git entry, which `git worktree prune` fixes.
			_ = out
		} else {
			return nil
		}
	}
	return os.RemoveAll(w.Path)
}

// Reap deletes run directories older than maxAge.
//
// Failed runs are retained deliberately so they can be inspected, which means
// something has to clean up eventually or ~/.specter/runs grows without bound.
func Reap(maxAge time.Duration) (int, error) {
	entries, err := os.ReadDir(Root())
	if err != nil {
		if os.IsNotExist(err) {
			return 0, nil
		}
		return 0, err
	}

	removed := 0
	cutoff := time.Now().Add(-maxAge)
	for _, entry := range entries {
		info, err := entry.Info()
		if err != nil || info.ModTime().After(cutoff) {
			continue
		}
		if err := os.RemoveAll(filepath.Join(Root(), entry.Name())); err == nil {
			removed++
		}
	}
	return removed, nil
}

func isGitRepo(dir string) bool {
	cmd := exec.Command("git", "-C", dir, "rev-parse", "--git-dir")
	return cmd.Run() == nil
}

// copyTree copies a directory, skipping what an agent has no use for.
func copyTree(source, dest string) error {
	return filepath.Walk(source, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		// Skipped rather than copied: these are large, regenerable, and copying
		// node_modules turns a fast operation into a slow one.
		if info.IsDir() {
			switch filepath.Base(path) {
			case "node_modules", ".venv", "__pycache__", ".git":
				if rel != "." {
					return filepath.SkipDir
				}
			}
		}
		target := filepath.Join(dest, rel)
		if info.IsDir() {
			return os.MkdirAll(target, info.Mode().Perm())
		}
		if !info.Mode().IsRegular() {
			// Symlinks and devices are skipped: following one could copy
			// something from outside the workspace entirely.
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		return os.WriteFile(target, body, info.Mode().Perm())
	})
}

// Describe is what the run view shows for this worktree.
func (w *Worktree) Describe() string {
	if w == nil {
		return "in place"
	}
	if w.Branch != "" {
		return w.Branch
	}
	if w.Method == MethodCopy {
		return "copy (not a git repository)"
	}
	return "detached"
}

var _ = strings.TrimSpace
