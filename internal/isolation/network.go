// Network policy — the boundary sandbox-exec cannot express.
//
// Author: Navjyot Nishant
// Created: 2026-08-11
// Last updated: 2026-08-11
// Description: a CONNECT-level filtering proxy, so an agent reaches only what it should.
//
// WHY A PROXY RATHER THAN A SANDBOX RULE
// Seatbelt can express network rules, but they are undocumented and deprecated:
// Apple offers no contract, and a boundary built on guesswork is worse than an
// absent one, because it gets trusted. bubblewrap can unshare the network
// namespace entirely, which is all-or-nothing — an agent that cannot reach its
// own model API is an agent that does not work.
//
// A proxy sits outside both problems. It is ordinary, documented, and the same
// mechanism on every platform.
//
// WHY CONNECT-LEVEL AND NOT MITM
// Filtering happens at the CONNECT line — the hostname the client asks for
// before any TLS handshake. That needs no certificate authority, no injected
// trust store, and breaks nothing that pins certificates. The cost is that
// request paths and bodies are invisible: this answers "may the agent talk to
// this host", not "what did it say". That is the right question for a boundary,
// and the wrong place to try answering the other one.
//
// WHAT IT DOES NOT DO
// An agent that ignores HTTPS_PROXY reaches the network directly. On Linux the
// namespace can close that; on macOS it cannot, so this is a policy for
// well-behaved clients rather than a cage. Reported honestly by the Warden
// rather than claimed as containment — see NetworkStatus.
package isolation

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// NetworkPolicy decides which hosts an agent may reach.
type NetworkPolicy struct {
	// Allowed hosts. A leading "*." matches any subdomain, so "*.github.com"
	// covers api.github.com and codeload.github.com without listing each.
	//
	// EMPTY MEANS ALLOW EVERYTHING, not deny everything. Those are opposite
	// defaults, and choosing wrong silently is how a boundary vanishes or how
	// every run breaks — so the distinction is stated here and reported by
	// NetworkStatus rather than inferred by a caller.
	Allowed []string

	// Denied is checked FIRST and wins over Allowed. A denied host stays denied
	// however broad an allow rule is, which is what makes "*.example.com" safe
	// to write next to a specific exclusion.
	Denied []string
}

// DefaultNetworkPolicy is what an agent gets when nothing is configured:
// unrestricted, and honest about it.
func DefaultNetworkPolicy() NetworkPolicy { return NetworkPolicy{} }

// Restricted reports whether this policy actually bounds anything.
func (p NetworkPolicy) Restricted() bool { return len(p.Allowed) > 0 }

// Permits reports whether a host may be reached, and why not when it may not.
func (p NetworkPolicy) Permits(host string) (bool, string) {
	host = normaliseHost(host)

	// Denials first, so a specific block beats a broad allow.
	for _, pattern := range p.Denied {
		if matchesHost(pattern, host) {
			return false, host + " is on the denied list"
		}
	}
	if !p.Restricted() {
		return true, ""
	}
	for _, pattern := range p.Allowed {
		if matchesHost(pattern, host) {
			return true, ""
		}
	}
	return false, host + " is not on the allowed list"
}

// normaliseHost strips the port and lowercases, so "GitHub.com:443" and
// "github.com" are the same host.
func normaliseHost(host string) string {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return strings.ToLower(strings.TrimSpace(host))
}

// matchesHost supports an exact name or a "*." subdomain wildcard.
//
// "*.github.com" deliberately matches github.com itself as well: a rule written
// to allow a service almost always means the service, and requiring both forms
// is a footgun that shows up as a mysterious refusal.
func matchesHost(pattern, host string) bool {
	pattern = strings.ToLower(strings.TrimSpace(pattern))
	if pattern == host {
		return true
	}
	if suffix, found := strings.CutPrefix(pattern, "*."); found {
		return host == suffix || strings.HasSuffix(host, "."+suffix)
	}
	return false
}

// Proxy filters an agent's outbound connections.
type Proxy struct {
	Policy NetworkPolicy

	// OnRefused is called for each blocked host, so a run can record what its
	// agent tried to reach. Silence would make a policy impossible to tune.
	OnRefused func(host, reason string)

	listener net.Listener
	server   *http.Server
	mu       sync.Mutex
	refused  []string
}

// StartProxy binds a filtering proxy on loopback and returns it running.
//
// Port 0: the OS picks. A fixed port would collide between concurrent runs, and
// each run gets its own proxy so one run's policy cannot leak into another's.
func StartProxy(policy NetworkPolicy) (*Proxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("binding the network proxy: %w", err)
	}

	p := &Proxy{Policy: policy, listener: listener}
	p.server = &http.Server{
		Handler:           http.HandlerFunc(p.handle),
		ReadHeaderTimeout: 30 * time.Second,
	}
	go p.server.Serve(listener)
	return p, nil
}

// Addr is the proxy's address, for HTTPS_PROXY.
func (p *Proxy) Addr() string {
	if p.listener == nil {
		return ""
	}
	return p.listener.Addr().String()
}

// Close stops the proxy. Called when a run ends, so a proxy does not outlive
// the agent it was bounding.
func (p *Proxy) Close() error {
	if p.server == nil {
		return nil
	}
	return p.server.Close()
}

// Refused returns the hosts this proxy blocked, for the run record.
func (p *Proxy) Refused() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]string(nil), p.refused...)
}

func (p *Proxy) record(host, reason string) {
	p.mu.Lock()
	p.refused = append(p.refused, host)
	p.mu.Unlock()
	if p.OnRefused != nil {
		p.OnRefused(host, reason)
	}
}

func (p *Proxy) handle(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.handleConnect(w, r)
		return
	}
	p.handlePlain(w, r)
}

// handleConnect is the HTTPS path: check the host, then tunnel bytes without
// looking at them.
func (p *Proxy) handleConnect(w http.ResponseWriter, r *http.Request) {
	host := r.Host
	if allowed, reason := p.Policy.Permits(host); !allowed {
		p.record(normaliseHost(host), reason)
		// 403 rather than a dropped connection: a refusal a client can report
		// is worth more than a timeout it cannot explain.
		http.Error(w, "blocked by the Specter network policy: "+reason, http.StatusForbidden)
		return
	}

	upstream, err := net.DialTimeout("tcp", host, 30*time.Second)
	if err != nil {
		http.Error(w, "upstream unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer upstream.Close()

	hijacker, ok := w.(http.Hijacker)
	if !ok {
		http.Error(w, "this proxy requires a hijackable connection", http.StatusInternalServerError)
		return
	}
	client, _, err := hijacker.Hijack()
	if err != nil {
		return
	}
	defer client.Close()

	if _, err := client.Write([]byte("HTTP/1.1 200 Connection Established\r\n\r\n")); err != nil {
		return
	}

	// Both directions, and the tunnel is done when EITHER closes — a half-open
	// copy left running holds the connection and the goroutine with it.
	done := make(chan struct{}, 2)
	go func() { io.Copy(upstream, client); done <- struct{}{} }()
	go func() { io.Copy(client, upstream); done <- struct{}{} }()
	<-done
}

// handlePlain is the HTTP path. Same check, then forward.
func (p *Proxy) handlePlain(w http.ResponseWriter, r *http.Request) {
	if allowed, reason := p.Policy.Permits(r.Host); !allowed {
		p.record(normaliseHost(r.Host), reason)
		http.Error(w, "blocked by the Specter network policy: "+reason, http.StatusForbidden)
		return
	}

	outbound := r.Clone(r.Context())
	outbound.RequestURI = ""
	if outbound.URL.Scheme == "" {
		outbound.URL.Scheme = "http"
	}
	if outbound.URL.Host == "" {
		outbound.URL.Host = r.Host
	}

	resp, err := http.DefaultTransport.RoundTrip(outbound)
	if err != nil {
		http.Error(w, "upstream unreachable: "+err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ProxyEnv points a process at the proxy.
//
// Both cases of each variable: tools disagree about which they read, and one
// that reads the case this omits would bypass the policy entirely.
func ProxyEnv(base []string, addr string) []string {
	if addr == "" {
		return base
	}
	url := "http://" + addr

	drop := map[string]bool{
		"HTTP_PROXY": true, "HTTPS_PROXY": true, "ALL_PROXY": true, "NO_PROXY": true,
		"http_proxy": true, "https_proxy": true, "all_proxy": true, "no_proxy": true,
	}
	out := make([]string, 0, len(base)+8)
	for _, entry := range base {
		if name, _, found := strings.Cut(entry, "="); found && drop[name] {
			// An inherited proxy setting would send the agent somewhere this
			// policy does not control.
			continue
		}
		out = append(out, entry)
	}

	return append(out,
		"HTTP_PROXY="+url, "HTTPS_PROXY="+url, "ALL_PROXY="+url,
		"http_proxy="+url, "https_proxy="+url, "all_proxy="+url,
	)
}
