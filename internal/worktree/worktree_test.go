package worktree

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// An agent must not edit the repository you are working in. It gets a worktree —
// a real checkout on its own branch, cheap because git shares the object store.
//
// git worktree rather than a copy: a copy cannot produce a branch, and a branch
// is what makes the PR path in #37 possible.

func gitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dir, _ = filepath.EvalSymlinks(dir)

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// A test must not inherit the developer's identity or hooks.
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}

	run("init", "--initial-branch=main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "-m", "initial")
	return dir
}

func TestReadOnlyWorktreeIsDetached(t *testing.T) {
	repo := gitRepo(t)

	wt, err := Prepare(repo, "job-abc123", ModeReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Remove()

	if wt.Path == repo {
		t.Fatal("the agent must not be pointed at the real repository")
	}
	if _, err := os.Stat(filepath.Join(wt.Path, "README.md")); err != nil {
		t.Fatalf("the worktree must carry the repository's content: %v", err)
	}
	// Read-only work needs no branch, and creating one would leave refs behind
	// for every run that never intended to write.
	if wt.Branch != "" {
		t.Fatalf("read-only must not create a branch, got %q", wt.Branch)
	}
}

func TestReadWriteWorktreeGetsItsOwnBranch(t *testing.T) {
	repo := gitRepo(t)

	wt, err := Prepare(repo, "job-def456", ModeReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Remove()

	if wt.Branch != "specter/job-def456" {
		t.Fatalf("branch = %q", wt.Branch)
	}

	// The branch must exist in the REAL repository — that is what lets the run's
	// work be pushed and reviewed rather than vanishing with the worktree.
	cmd := exec.Command("git", "branch", "--list", wt.Branch)
	cmd.Dir = repo
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "specter/job-def456") {
		t.Fatalf("branch missing from the origin repo: %q", out)
	}
}

// THE POINT OF ALL THIS: edits land in the worktree, never in the user's tree.
func TestEditsDoNotReachTheSourceRepository(t *testing.T) {
	repo := gitRepo(t)

	wt, err := Prepare(repo, "job-ghi789", ModeReadWrite)
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Remove()

	if err := os.WriteFile(filepath.Join(wt.Path, "README.md"), []byte("agent was here\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	original, err := os.ReadFile(filepath.Join(repo, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(original) != "hello\n" {
		t.Fatalf("the source repository was modified: %q", original)
	}

	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = repo
	status, _ := cmd.Output()
	if len(strings.TrimSpace(string(status))) != 0 {
		t.Fatalf("the source working tree is dirty: %q", status)
	}
}

// A directory that is not a repository still has to work — not every workspace
// is under git. It falls back to a copy and SAYS SO, rather than behaving
// differently in silence.
func TestNonGitDirectoryFallsBackToACopy(t *testing.T) {
	plain := t.TempDir()
	plain, _ = filepath.EvalSymlinks(plain)
	if err := os.WriteFile(filepath.Join(plain, "notes.txt"), []byte("data\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	wt, err := Prepare(plain, "job-jkl012", ModeReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	defer wt.Remove()

	if wt.Method != MethodCopy {
		t.Fatalf("method = %q, want copy", wt.Method)
	}
	if _, err := os.Stat(filepath.Join(wt.Path, "notes.txt")); err != nil {
		t.Fatalf("the copy must carry the content: %v", err)
	}
}

// Removing a worktree must not remove the repository it came from. Getting this
// wrong deletes a developer's work.
func TestRemoveLeavesTheSourceIntact(t *testing.T) {
	repo := gitRepo(t)

	wt, err := Prepare(repo, "job-mno345", ModeReadOnly)
	if err != nil {
		t.Fatal(err)
	}
	if err := wt.Remove(); err != nil {
		t.Fatal(err)
	}

	if _, err := os.Stat(wt.Path); !os.IsNotExist(err) {
		t.Fatal("the worktree should be gone")
	}
	if _, err := os.Stat(filepath.Join(repo, "README.md")); err != nil {
		t.Fatalf("the source repository was damaged: %v", err)
	}
}

// The destination is derived from the job token, never taken from a caller —
// the same rule the existing clone helper follows.
func TestDestinationIsDerivedNotSupplied(t *testing.T) {
	repo := gitRepo(t)

	wt, err := Prepare(repo, "../../etc/passwd", ModeReadOnly)
	if err == nil {
		wt.Remove()
		t.Fatal("a token containing path separators must be rejected")
	}
}
