package agenthost

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/exec"
)

// AddrEnv points a backend at a host-side spawner. Unset means spawn in-process,
// which is the native deployment and stays the default.
const AddrEnv = "SPECTER_AGENT_HOST"

// Configured reports the agent host, or "" when agents run in-process.
func Configured() string {
	return strings.TrimSpace(os.Getenv(AddrEnv))
}

// Client asks a host-side spawner to run an agent.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

// NewClient builds a client from the environment. The token is read the same way
// the server writes it — through exec.RunnerToken, which already knows to look
// at the mounted path before the home directory.
func NewClient() *Client {
	return &Client{
		BaseURL: Configured(),
		Token:   exec.RunnerToken(),
		// No overall timeout: an agent run legitimately takes many minutes, and
		// the deadline that matters is the one carried in the request and
		// enforced by the context. A client timeout here would sever a run the
		// host is still executing.
		HTTP: &http.Client{},
	}
}

// Spawn runs an agent on the host and returns the same shape a local run would.
//
// A transport failure is reported as a REFUSAL naming the host, not as an agent
// failure. "no agent CLI found" would send an operator to install something they
// already have — on a machine that is not the one missing it.
func (c *Client) Spawn(ctx context.Context, req SpawnRequest) (exec.Result, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return exec.Result{}, err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost,
		strings.TrimRight(c.BaseURL, "/")+"/spawn", bytes.NewReader(body))
	if err != nil {
		return exec.Result{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.Token)

	resp, err := c.HTTP.Do(httpReq)
	if err != nil {
		return exec.Result{}, fmt.Errorf(
			"the agent host at %s could not be reached: %w", c.BaseURL, err)
	}
	defer resp.Body.Close()

	var out SpawnResponse
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return exec.Result{}, fmt.Errorf(
			"the agent host at %s returned an unreadable response (%s)", c.BaseURL, resp.Status)
	}
	if out.Refused != "" {
		return exec.Result{}, fmt.Errorf("the agent host refused the run: %s", out.Refused)
	}

	return exec.Result{
		Stdout:   out.Stdout,
		Stderr:   out.Stderr,
		ExitCode: out.ExitCode,
		TimedOut: out.TimedOut,
		Err:      out.Err,
	}, nil
}

// Reachable reports whether the host answers, so a caller can distinguish
// "misconfigured" from "not running" before starting a run.
func (c *Client) Reachable(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(c.BaseURL, "/")+"/health", nil)
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("%s is not answering: %w", c.BaseURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s answered %s", c.BaseURL, resp.Status)
	}
	return nil
}
