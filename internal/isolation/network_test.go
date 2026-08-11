package isolation

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestHostMatching(t *testing.T) {
	for _, c := range []struct {
		pattern, host string
		want          bool
	}{
		{"github.com", "github.com", true},
		{"github.com", "api.github.com", false},
		// A wildcard covers the apex too: a rule written to allow a service
		// almost always means the service, and requiring both forms shows up as
		// a mysterious refusal.
		{"*.github.com", "api.github.com", true},
		{"*.github.com", "github.com", true},
		{"*.github.com", "notgithub.com", false},
		{"*.github.com", "evil-github.com", false},
		// Case and port are not part of the identity.
		{"GitHub.com", "github.com:443", true},
	} {
		if got := matchesHost(c.pattern, normaliseHost(c.host)); got != c.want {
			t.Errorf("matchesHost(%q, %q) = %v, want %v", c.pattern, c.host, got, c.want)
		}
	}
}

// Empty means allow-everything, NOT deny-everything. Those are opposite
// defaults and getting it wrong either removes the boundary silently or breaks
// every run.
func TestAnEmptyPolicyAllowsRatherThanDenies(t *testing.T) {
	p := DefaultNetworkPolicy()
	if p.Restricted() {
		t.Error("an unconfigured policy reports itself as restricting")
	}
	if allowed, _ := p.Permits("anywhere.example.com"); !allowed {
		t.Error("an unconfigured policy denied a host — that would break every run")
	}
}

// A denial beats an allow, which is what makes a broad wildcard safe to write
// next to a specific exclusion.
func TestDenialsWinOverAllows(t *testing.T) {
	p := NetworkPolicy{Allowed: []string{"*.example.com"}, Denied: []string{"secret.example.com"}}

	if allowed, _ := p.Permits("api.example.com"); !allowed {
		t.Error("an allowed subdomain was refused")
	}
	if allowed, reason := p.Permits("secret.example.com"); allowed {
		t.Error("a denied host was allowed by a broader wildcard")
	} else if reason == "" {
		t.Error("a refusal gave no reason")
	}
}

// The proxy must actually block, not merely report that it would.
func TestTheProxyRefusesADisallowedHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte("reached the upstream"))
	}))
	defer upstream.Close()

	proxy, err := StartProxy(NetworkPolicy{Allowed: []string{"allowed.example.com"}})
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	// Routed through the proxy the way an agent's HTTP client would be.
	req, _ := http.NewRequest(http.MethodGet, upstream.URL, nil)
	req.Host = "blocked.example.com"

	proxyURL, err := url.Parse("http://" + proxy.Addr())
	if err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: &http.Transport{Proxy: http.ProxyURL(proxyURL)}}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("request failed outright rather than being refused: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
	if len(proxy.Refused()) == 0 {
		t.Error("the proxy did not record the refusal, so a policy could not be tuned")
	}
}

// An inherited proxy setting would route the agent somewhere this policy does
// not control, so it must be replaced rather than added to.
func TestProxyEnvReplacesInheritedSettings(t *testing.T) {
	base := []string{"PATH=/usr/bin", "HTTPS_PROXY=http://somewhere-else:9", "https_proxy=http://also-elsewhere:9"}
	out := ProxyEnv(base, "127.0.0.1:1234")

	for _, entry := range out {
		if strings.Contains(entry, "somewhere-else") || strings.Contains(entry, "also-elsewhere") {
			t.Errorf("an inherited proxy setting survived: %s", entry)
		}
	}
	// Both cases, because tools disagree about which they read.
	for _, want := range []string{"HTTPS_PROXY=http://127.0.0.1:1234", "https_proxy=http://127.0.0.1:1234"} {
		found := false
		for _, entry := range out {
			if entry == want {
				found = true
			}
		}
		if !found {
			t.Errorf("missing %s", want)
		}
	}
}
