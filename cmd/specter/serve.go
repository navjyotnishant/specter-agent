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
	"github.com/navjyotnishant/specter-agent/internal/seed"
	"github.com/navjyotnishant/specter-agent/internal/store"
	"github.com/navjyotnishant/specter-agent/internal/worktree"
)

// cmdServe runs the HTTP API the React frontend talks to.
//
// Same binary as the CLI, different entry point — which is the whole reason for
// the rewrite. There is no separate server artifact to version-match.
// worktreeRetention is how long a failed run's checkout stays inspectable.
// Long enough to look at it the next working day; short enough that a month of
// failures is not still on disk.
const worktreeRetention = 7 * 24 * time.Hour

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

	// A database with no skills and no templates renders an empty palette and an
	// empty gallery — indistinguishable from a broken install. Seeding is
	// insert-if-missing, so this is a no-op on every start after the first.
	if res, err := seed.Run(s.DB()); err != nil {
		return fmt.Errorf("seeding built-ins: %w", err)
	} else if res.Skills > 0 || res.Workflows > 0 {
		fmt.Printf("seeded         →  %d skill(s), %d template(s)\n", res.Skills, res.Workflows)
	}

	// Retained worktrees are deliberate — a failed run stays inspectable — but
	// nothing was ever clearing them, so they accumulated forever. Swept at
	// startup rather than on a timer: a server that is never restarted is not
	// the case that fills a disk.
	if removed, err := worktree.Reap(worktreeRetention); err == nil && removed > 0 {
		fmt.Printf("reaped         →  %d run worktree(s) older than %s\n", removed, worktreeRetention)
	}

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
