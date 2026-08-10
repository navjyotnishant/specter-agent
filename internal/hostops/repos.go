package hostops

import (
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Repository struct {
	Path   string   `json:"path"`
	Name   string   `json:"name"`
	Stack  []string `json:"stack"`
	IsGit  bool     `json:"is_git"`
	Branch string   `json:"branch,omitempty"`
}

type DiscoveryResult struct {
	OK           bool         `json:"ok"`
	Message      string       `json:"message,omitempty"`
	Repositories []Repository `json:"repositories"`
	Scanned      int          `json:"scanned"`
}

// stackMarkers name the ecosystem a directory belongs to.
var stackMarkers = map[string]string{
	"package.json":     "Node/TypeScript",
	"pyproject.toml":   "Python",
	"requirements.txt": "Python",
	"go.mod":           "Go",
	"Cargo.toml":       "Rust",
	"pom.xml":          "Java",
	"build.gradle":     "Java",
	"Gemfile":          "Ruby",
	"composer.json":    "PHP",
	"Dockerfile":       "Docker",
}

// skipDirs are never descended into. Without this a single node_modules turns a
// three-level scan into hundreds of thousands of directories.
var skipDirs = map[string]bool{
	"node_modules": true, ".git": true, "vendor": true, "target": true,
	"dist": true, "build": true, ".venv": true, "venv": true,
	"__pycache__": true, ".next": true, ".cache": true,
}

// DiscoverRepositories walks a root looking for git repositories.
//
// Bounded on depth AND result count, because this runs against a directory the
// user picked and an unbounded walk of the wrong one hangs the request.
func DiscoverRepositories(rootPath string, maxDepth, maxResults int) DiscoveryResult {
	if strings.TrimSpace(rootPath) == "" {
		return DiscoveryResult{Message: "Root path is required.", Repositories: []Repository{}}
	}
	if maxDepth < 1 {
		maxDepth = 3
	}
	if maxDepth > 5 {
		maxDepth = 5
	}
	if maxResults < 1 {
		maxResults = 50
	}
	if maxResults > 200 {
		maxResults = 200
	}

	root := expandHome(rootPath)
	if resolved, err := filepath.EvalSymlinks(root); err == nil {
		root = resolved
	}
	info, err := os.Stat(root)
	if err != nil || !info.IsDir() {
		return DiscoveryResult{Message: "Root path does not exist or is not a directory.", Repositories: []Repository{}}
	}
	// Scanning an entire home directory returns every dotfile repo and takes
	// long enough to look broken.
	if home, err := os.UserHomeDir(); err == nil {
		if resolvedHome, err := filepath.EvalSymlinks(home); err == nil {
			home = resolvedHome
		}
		if root == home {
			return DiscoveryResult{
				Message:      "Choose a specific projects directory instead of the entire home directory.",
				Repositories: []Repository{},
			}
		}
	}

	repositories := []Repository{}
	scanned := 0

	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > maxDepth || len(repositories) >= maxResults {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		scanned++

		if hasGitDir(entries) {
			repositories = append(repositories, Repository{
				Path: dir, Name: filepath.Base(dir),
				Stack: detectStack(entries), IsGit: true,
				Branch: currentBranch(dir),
			})
			// A repository is a leaf. Descending into one finds its submodules
			// and vendored copies, which are not what was asked for.
			return
		}

		for _, entry := range entries {
			if !entry.IsDir() || skipDirs[entry.Name()] || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			walk(filepath.Join(dir, entry.Name()), depth+1)
		}
	}
	walk(root, 1)

	sort.Slice(repositories, func(i, j int) bool { return repositories[i].Name < repositories[j].Name })
	return DiscoveryResult{OK: true, Repositories: repositories, Scanned: scanned}
}

func hasGitDir(entries []fs.DirEntry) bool {
	for _, entry := range entries {
		if entry.Name() == ".git" {
			return true
		}
	}
	return false
}

func detectStack(entries []fs.DirEntry) []string {
	seen := map[string]bool{}
	var stack []string
	for _, entry := range entries {
		if label, ok := stackMarkers[entry.Name()]; ok && !seen[label] {
			seen[label] = true
			stack = append(stack, label)
		}
	}
	sort.Strings(stack)
	return stack
}

// currentBranch reads .git/HEAD directly rather than shelling out to git —
// discovery can touch hundreds of directories, and a subprocess each would
// dominate the request.
func currentBranch(repoDir string) string {
	body, err := os.ReadFile(filepath.Join(repoDir, ".git", "HEAD"))
	if err != nil {
		return ""
	}
	head := strings.TrimSpace(string(body))
	if ref, found := strings.CutPrefix(head, "ref: refs/heads/"); found {
		return ref
	}
	return ""
}

func expandHome(path string) string {
	if strings.HasPrefix(path, "~") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(path, "~"))
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return absolute
}
