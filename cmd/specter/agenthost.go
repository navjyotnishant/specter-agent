package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/agenthost"
	"github.com/navjyotnishant/specter-agent/internal/exec"
)

// cmdAgentHost spawns agents for a backend that cannot spawn its own.
//
// Run this on your machine when Specter itself runs in a container: the
// container keeps the API and the web UI, and only agent execution — the part
// that needs your CLIs and your credentials — happens out here.
//
// Same binary as `specter serve`, so there is nothing extra to install and the
// two halves cannot drift apart in version.
func cmdAgentHost(args []string) error {
	fs := flag.NewFlagSet("agent-host", flag.ContinueOnError)
	addr := fs.String("addr", agenthost.DefaultAddr, "address to listen on")
	timeout := fs.Duration("timeout", 10*time.Minute, "default per-agent time limit")
	if err := fs.Parse(reorderFlagsFirstFor(fs, args)); err != nil {
		return err
	}

	// Minted on first use and reused thereafter. The backend reads the same file
	// — mounted into the container — so both halves share one secret without the
	// operator copying anything by hand.
	token, err := exec.EnsureRunnerToken()
	if err != nil {
		return fmt.Errorf("provisioning the runner token: %w", err)
	}
	if token == "" {
		// Refuses rather than serving unauthenticated. This endpoint spawns
		// processes; an open one is a remote code execution service.
		return fmt.Errorf("no runner token available, and this must not serve unauthenticated")
	}

	server := &agenthost.Server{Token: token, DefaultTimeout: *timeout}

	srv := &http.Server{
		Addr:              *addr,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		srv.Close()
	}()

	fmt.Printf("\n  %s\n\n", bold("specter agent-host"))
	fmt.Printf("  listening    %s\n", *addr)
	fmt.Printf("  allowlist    %s\n", dim(shorten(exec.AllowlistPath())))
	fmt.Println()
	fmt.Println(dim("  Point the containerized backend at this host:"))
	fmt.Printf("  %s\n\n", dim("  "+agenthost.AddrEnv+"=http://host.docker.internal:"+port(*addr)))

	// An empty allowlist refuses every request, so say it now rather than let it
	// be discovered on the first run.
	if _, reason := exec.ApprovedWorkspace(exec.AllowlistPath(), exec.AllowlistPath()); strings.Contains(reason, "no approved-workspace list") {
		fmt.Println(dim("  No approved workspaces yet — add them in the web UI, or every run is refused."))
		fmt.Println()
	}

	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// port extracts the port from a listen address for the hint above.
func port(addr string) string {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[i+1:]
		}
	}
	return addr
}
