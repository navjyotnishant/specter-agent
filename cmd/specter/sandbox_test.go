package main

import "testing"

func TestShortVersionPicksTheVersionNotTheWordVersion(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"sbx version: v0.34.0 2eae0c4fc38", "v0.34.0"},
		{"v1.2.3", "v1.2.3"},
		{"", ""},
		// No v-number anywhere: fall back rather than invent one.
		{"unknown build", "build"},
	} {
		if got := shortVersion(c.in); got != c.want {
			t.Errorf("shortVersion(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
