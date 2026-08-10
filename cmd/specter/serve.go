package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/api"
	"github.com/navjyotnishant/specter-agent/internal/store"
)

// cmdServe runs the HTTP API the React frontend talks to.
//
// Same binary as the CLI, different entry point — which is the whole reason for
// the rewrite. There is no separate server artifact to version-match.
func cmdServe(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	addr := fs.String("addr", "127.0.0.1:8000", "address to listen on")
	dbPath := fs.String("db", defaultDBPath(), "path to the SQLite database")
	frontend := fs.String("frontend", os.Getenv("SPECTER_FRONTEND_DIR"),
		"directory holding the built web UI (empty serves the API only)")
	if err := fs.Parse(reorderFlagsFirstFor(fs, args)); err != nil {
		return err
	}

	s, err := store.Open(*dbPath)
	if err != nil {
		return fmt.Errorf("opening the database: %w", err)
	}
	defer s.Close()

	deps := &api.Deps{Store: s, DBPath: *dbPath, FrontendDir: *frontend}

	// Before serving, not after. A run recovered on the first request would
	// still have been stranded for however long that took.
	if recovered := deps.RecoverApprovedWaitingRuns(); recovered > 0 {
		fmt.Printf("recovered       →  %d run(s) approved while this backend was down\n", recovered)
	}

	srv := &http.Server{
		Addr:    *addr,
		Handler: api.NewRouter(deps),
		// A slow client must not hold a connection open indefinitely.
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Shut down on a signal rather than dying mid-request: an in-flight write
	// killed halfway is how a run row ends up half-written.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-stop
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
	}()

	fmt.Printf("specter serve  →  http://%s/api\n", *addr)
	fmt.Printf("database       →  %s\n", *dbPath)
	if *frontend != "" {
		fmt.Printf("web UI         →  %s\n", *frontend)
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
