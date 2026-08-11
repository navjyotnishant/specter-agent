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

// An EMPTY policy allows everything — the zero value must not accidentally deny,
// or a caller who forgot to set one breaks every run. That is different from the
// DEFAULT policy, which is deliberately restricted.
func TestAnEmptyPolicyAllowsRatherThanDenies(t *testing.T) {
	p := UnrestrictedNetworkPolicy()
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

// The default is restricted, and it is built from what a real agent was
// observed reaching: its model API and MCP endpoints, plus the registries a
// coding agent installs from. Telemetry was observed too and deliberately left
// out — an agent working on your code should not ship logs off the machine as a
// side effect.
func TestTheDefaultPolicyAllowsTheAgentAndRefusesTelemetry(t *testing.T) {
	p := DefaultNetworkPolicy()

	if !p.Restricted() {
		t.Fatal("the default policy bounds nothing")
	}

	for _, host := range []string{
		"api.anthropic.com",     // the model API — without this no agent runs
		"github.com",            // clone and the PR path
		"registry.npmjs.org",    // an agent that cannot npm install looks broken
		"api.githubcopilot.com", // observed in a real run
	} {
		if allowed, reason := p.Permits(host); !allowed {
			t.Errorf("the default refuses %s, which an agent needs: %s", host, reason)
		}
	}

	// Observed, and excluded on purpose.
	if allowed, _ := p.Permits("http-intake.logs.us5.datadoghq.com"); allowed {
		t.Error("the default allows a telemetry sink")
	}
	// Nothing in the default should open the whole internet.
	if allowed, _ := p.Permits("evil.example.com"); allowed {
		t.Error("the default allows an arbitrary host")
	}
}

// A node's hosts EXTEND the default rather than replacing it. A workflow that
// needs one internal registry must not have to re-list the model API its agent
// cannot run without — and a list that must be complete is one that silently
// breaks when the default grows.
func TestNodeHostsExtendTheDefaultRatherThanReplacingIt(t *testing.T) {
	p := DefaultNetworkPolicy()
	p.Allowed = append(p.Allowed, "internal.registry.example")

	if allowed, _ := p.Permits("internal.registry.example"); !allowed {
		t.Error("the added host was not permitted")
	}
	// Still there, which is the point of additive.
	if allowed, _ := p.Permits("api.anthropic.com"); !allowed {
		t.Error("extending the policy dropped the model API, so no agent could run")
	}
}

// A denial beats the DEFAULT too, not just an explicit allow — otherwise a
// workflow could not refuse a host the default happens to permit.
func TestADenialOverridesTheDefaultAllowlist(t *testing.T) {
	p := DefaultNetworkPolicy()
	p.Denied = append(p.Denied, "github.com")

	if allowed, reason := p.Permits("github.com"); allowed {
		t.Error("a denied host was permitted because the default allows it")
	} else if reason == "" {
		t.Error("the refusal gave no reason")
	}
}
