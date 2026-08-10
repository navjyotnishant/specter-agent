package hostops

import (
	"os"
	"path/filepath"
	"testing"
)

func makeRepo(t *testing.T, dir, name string, markers ...string) string {
	t.Helper()
	repo := filepath.Join(dir, name)
	os.MkdirAll(filepath.Join(repo, ".git"), 0o755)
	os.WriteFile(filepath.Join(repo, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o644)
	for _, marker := range markers {
		os.WriteFile(filepath.Join(repo, marker), []byte("{}"), 0o644)
	}
	return repo
}

func TestDiscoveryFindsRepositoriesAndTheirStack(t *testing.T) {
	root := t.TempDir()
	makeRepo(t, root, "web", "package.json")
	makeRepo(t, root, "api", "go.mod")
	os.MkdirAll(filepath.Join(root, "not-a-repo"), 0o755)

	result := DiscoverRepositories(root, 3, 50)
	if !result.OK {
		t.Fatalf("discovery failed: %s", result.Message)
	}
	if len(result.Repositories) != 2 {
		t.Fatalf("found %d repositories, want 2: %+v", len(result.Repositories), result.Repositories)
	}
	byName := map[string]Repository{}
	for _, repo := range result.Repositories {
		byName[repo.Name] = repo
	}
	if got := byName["web"].Stack; len(got) != 1 || got[0] != "Node/TypeScript" {
		t.Errorf("web stack = %v", got)
	}
	if byName["api"].Branch != "main" {
		t.Errorf("branch = %q, want main", byName["api"].Branch)
	}
}

func TestDiscoveryDoesNotDescendIntoARepository(t *testing.T) {
	// A repository is a leaf. Descending finds its submodules and vendored
	// copies, which is not what the user asked for.
	root := t.TempDir()
	outer := makeRepo(t, root, "outer")
	makeRepo(t, outer, "vendored")

	result := DiscoverRepositories(root, 5, 50)
	if len(result.Repositories) != 1 {
		t.Errorf("found %d repositories, want 1 — it descended into a repo", len(result.Repositories))
	}
}

func TestDiscoverySkipsNodeModules(t *testing.T) {
	// One node_modules turns a three-level scan into hundreds of thousands of
	// directories.
	root := t.TempDir()
	makeRepo(t, filepath.Join(root, "node_modules", "pkg"), "nested")
	os.MkdirAll(filepath.Join(root, "node_modules", "pkg"), 0o755)

	result := DiscoverRepositories(root, 5, 50)
	for _, repo := range result.Repositories {
		if filepath.Base(filepath.Dir(repo.Path)) == "pkg" {
			t.Error("descended into node_modules")
		}
	}
}

func TestDiscoveryRefusesHome(t *testing.T) {
	// Scanning an entire home directory returns every dotfile repo and takes
	// long enough to look broken.
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home directory")
	}
	result := DiscoverRepositories(home, 3, 50)
	if result.OK {
		t.Error("scanning the whole home directory was allowed")
	}
}

func TestDiscoveryRejectsAMissingRoot(t *testing.T) {
	result := DiscoverRepositories(filepath.Join(t.TempDir(), "nope"), 3, 50)
	if result.OK {
		t.Error("a missing root was accepted")
	}
	if result.Repositories == nil {
		t.Error("repositories is nil rather than an empty list — the client maps over it")
	}
}

func TestDiscoveryBoundsAreClamped(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a", "b", "c"} {
		makeRepo(t, root, name)
	}
	if got := DiscoverRepositories(root, 3, 2); len(got.Repositories) > 2 {
		t.Errorf("maxResults ignored: %d", len(got.Repositories))
	}
	// Out-of-range values are clamped, not rejected: the UI passes these
	// straight through.
	if got := DiscoverRepositories(root, 0, 0); !got.OK {
		t.Error("zero bounds were rejected rather than clamped")
	}
}
