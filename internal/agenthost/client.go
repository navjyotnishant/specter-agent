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
	"github.com/navjyotnishant/specter-agent/internal/hostops"
	"github.com/navjyotnishant/specter-agent/internal/isolation"
	"github.com/navjyotnishant/specter-agent/internal/models"
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

// Agents asks the host what it has installed and signed in.
//
// A backend in a container is asking about a machine it cannot see, so this is
// the only honest source: probing its own filesystem reports every agent missing
// while the host beside it has all four working.
func (c *Client) Agents(ctx context.Context) (hostops.RuntimeStatus, error) {
	var out hostops.RuntimeStatus
	err := c.getJSON(ctx, "/agents", &out)
	return out, err
}

// Models asks the host which models each of its CLIs supports.
func (c *Client) Models(ctx context.Context, refresh bool) ([]models.AgentModels, error) {
	path := "/models"
	if refresh {
		path += "?refresh=true"
	}
	var out []models.AgentModels
	err := c.getJSON(ctx, path, &out)
	return out, err
}

func (c *Client) getJSON(ctx context.Context, path string, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		strings.TrimRight(c.BaseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)

	// Bounded, unlike Spawn: these are status probes behind a settings page, and
	// a hung host must not hold the page open indefinitely.
	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("the agent host at %s could not be reached: %w", c.BaseURL, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("the agent host at %s answered %s", c.BaseURL, resp.Status)
	}
	return json.NewDecoder(resp.Body).Decode(into)
}

// Sandbox asks the host about its Docker Sandbox runtime. `sbx` is installed on
// the host, not in the container, so this is the only source that can answer.
func (c *Client) Sandbox(ctx context.Context) (hostops.SandboxStatus, error) {
	var out hostops.SandboxStatus
	err := c.getJSON(ctx, "/sandbox", &out)
	return out, err
}

// SandboxPolicy asks the host which network policy sbx is configured with.
func (c *Client) SandboxPolicy(ctx context.Context) (hostops.PolicyStatus, error) {
	var out hostops.PolicyStatus
	err := c.getJSON(ctx, "/sandbox/policy", &out)
	return out, err
}

// Warden asks the host which boundaries hold around the agent.
func (c *Client) Warden(ctx context.Context) (isolation.WardenStatus, error) {
	var out isolation.WardenStatus
	err := c.getJSON(ctx, "/warden", &out)
	return out, err
}
