package publish

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// A read-write run must arrive as a pull request, never as edits already applied
// to the branch you are on. The agent's work should be reviewable before it is
// yours.

func gitRepoWithRemote(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	dir, _ = filepath.EvalSymlinks(dir)

	// No git identity, for the whole test process — Commit() shells out to git
	// and inherits this environment, so it must supply its own identity rather
	// than borrowing the developer's.
	//
	// Without this the suite passed on a machine with a global identity
	// configured and failed on the first CI runner, which has none: git refuses
	// with "empty ident name" and every write run dies at the commit.
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	t.Setenv("HOME", dir)

	// The fixture's OWN commits carry an identity via -c, but nothing is exported
	// into the environment: production code must supply its own, and inheriting
	// one here would hide the case where it does not. That is exactly what
	// happened — the tests passed on a developer machine with a global identity
	// configured and failed on the first CI runner, which has none.
	run := func(args ...string) {
		t.Helper()
		args = append([]string{
			"-c", "user.name=fixture", "-c", "user.email=fixture@localhost",
		}, args...)
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		// A developer's global identity must not leak in and mask the failure.
		cmd.Env = append(os.Environ(), "HOME="+dir, "GIT_CONFIG_GLOBAL=/dev/null")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	run("init", "--initial-branch=main")
	os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644)
	run("add", "-A")
	run("commit", "-m", "initial")
	run("remote", "add", "origin", "git@github.com:example/repo.git")
	return dir
}

// An SSH remote cannot be used under confinement — ~/.ssh is denied. The push
// must go over HTTPS with gh as the credential helper, WITHOUT rewriting the
// user's own remote.
func TestSSHRemoteBecomesHTTPS(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"scp-style ssh", "git@github.com:example/repo.git", "https://github.com/example/repo"},
		{"ssh url", "ssh://git@github.com/example/repo.git", "https://github.com/example/repo"},
		{"already https", "https://github.com/example/repo.git", "https://github.com/example/repo"},
		{"no .git suffix", "git@github.com:example/repo", "https://github.com/example/repo"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := httpsRemote(tc.in)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

// A host we cannot construct an HTTPS URL for is an error, not a guess. Pushing
// somewhere unintended is worse than refusing.
func TestUnrecognisedRemoteIsRejected(t *testing.T) {
	for _, bad := range []string{"", "not a url", "file:///tmp/repo"} {
		if _, err := httpsRemote(bad); err == nil {
			t.Fatalf("remote %q must be rejected", bad)
		}
	}
}

// Nothing to publish is not a failure — an agent that changed nothing is a
// legitimate outcome, and reporting it as an error would be wrong.
func TestNoChangesIsNotAnError(t *testing.T) {
	repo := gitRepoWithRemote(t)

	result, err := Commit(repo, "specter/job-1", "no-op run")
	if err != nil {
		t.Fatalf("a clean tree must not error: %v", err)
	}
	if result.Committed {
		t.Fatal("nothing was changed, so nothing should be committed")
	}
}

// The run's scratch directory must never reach a commit. Confinement redirects
// TMPDIR into the workspace, so without an exclusion a one-line edit arrives as
// a commit containing hundreds of Node cache files.
func TestScratchDirectoryIsNotCommitted(t *testing.T) {
	repo := gitRepoWithRemote(t)
	branch := exec.Command("git", "checkout", "-b", "specter/job-scratch")
	branch.Dir = repo
	branch.CombinedOutput()

	scratch := filepath.Join(repo, ScratchDir, "node-cache")
	os.MkdirAll(scratch, 0o755)
	os.WriteFile(filepath.Join(scratch, "junk.bin"), []byte("cache\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "real-work.txt"), []byte("the actual edit\n"), 0o644)

	result, err := Commit(repo, "specter/job-scratch", "do the work")
	if err != nil {
		t.Fatal(err)
	}
	if result.FilesChanged != 1 {
		t.Fatalf("files changed = %d, want 1 — scratch must not count", result.FilesChanged)
	}

	show := exec.Command("git", "show", "--stat", "--name-only", "HEAD")
	show.Dir = repo
	out, _ := show.Output()
	if strings.Contains(string(out), ScratchDir) {
		t.Fatalf("the scratch directory reached the commit:\n%s", out)
	}
}

func TestCommitCapturesAgentWork(t *testing.T) {
	repo := gitRepoWithRemote(t)

	// Branch first, as a read-write worktree would have.
	branch := exec.Command("git", "checkout", "-b", "specter/job-2")
	branch.Dir = repo
	if out, err := branch.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}

	os.WriteFile(filepath.Join(repo, "README.md"), []byte("agent edited this\n"), 0o644)
	os.WriteFile(filepath.Join(repo, "new-file.txt"), []byte("and added this\n"), 0o644)

	result, err := Commit(repo, "specter/job-2", "review the diff")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Committed {
		t.Fatal("changes must be committed")
	}
	if result.FilesChanged != 2 {
		t.Fatalf("files changed = %d, want 2", result.FilesChanged)
	}

	// Untracked files count: an agent that only adds files has still done work.
	show := exec.Command("git", "show", "--stat", "--oneline", "HEAD")
	show.Dir = repo
	out, err := show.Output()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), "new-file.txt") {
		t.Fatalf("new files must be included: %s", out)
	}
}

// The commit message says what produced it. A reviewer looking at a branch
// months later should not have to guess.
func TestCommitMessageNamesItsOrigin(t *testing.T) {
	repo := gitRepoWithRemote(t)
	branch := exec.Command("git", "checkout", "-b", "specter/job-3")
	branch.Dir = repo
	branch.CombinedOutput()

	os.WriteFile(filepath.Join(repo, "x.txt"), []byte("x\n"), 0o644)
	if _, err := Commit(repo, "specter/job-3", "add a file"); err != nil {
		t.Fatal(err)
	}

	log := exec.Command("git", "log", "-1", "--pretty=%B")
	log.Dir = repo
	out, _ := log.Output()
	message := string(out)

	if !strings.Contains(message, "add a file") {
		t.Fatalf("the objective must appear: %q", message)
	}
	if !strings.Contains(strings.ToLower(message), "specter") {
		t.Fatalf("the origin must be identifiable: %q", message)
	}
}
