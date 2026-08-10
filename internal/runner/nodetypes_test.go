// R3: memory, conditional and webhook nodes.
//
// The conditional is the one worth reading carefully. It asks an agent a yes/no
// question and branches on the answer — so how the answer is PARSED decides
// which half of the workflow runs. Only the first word is examined, because an
// agent told to answer "YES or NO" routinely answers "YES, because ...". Taking
// the whole reply and comparing it to "YES" would send every such run down the
// false branch, and nothing would look broken.
//
// Anything that is not recognisably affirmative is FALSE. A conditional that
// defaults to true on a confused answer runs the guarded branch by accident,
// and the guarded branch is the one someone put a gate in front of.
package runner

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/graph"
)

func conditionalNode(condition string) graph.Node {
	return graph.Node{ID: "c1", Type: "conditional",
		Data: graph.NodeData{Label: "Gate", Condition: condition}}
}

func TestConditionalBranchesOnTheFirstWord(t *testing.T) {
	cases := []struct {
		name, reply, want string
	}{
		{"bare yes", "YES", "true"},
		{"bare no", "NO", "false"},
		{"lowercase", "yes", "true"},
		{"true as a synonym", "TRUE", "true"},
		{"yes with a reason", "YES, because the tests pass", "true"},
		{"yes with punctuation", "YES.", "true"},
		{"no with a reason", "NO — three tests are failing", "false"},
		{"a hedge is not a yes", "Probably, but I am not certain", "false"},
		{"empty is not a yes", "", "false"},
		{"prose that merely contains yes", "I would say the answer is yes", "false"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r, _, runID := testRunner(t)
			r.AgentPath = fakeAgent(t, "printf '%s' "+shellQuote(c.reply))

			result := r.RunNode(context.Background(), runID, conditionalNode("do the tests pass?"), t.TempDir(), "")
			if result.Status != "completed" {
				t.Fatalf("status = %q (%s)", result.Status, result.Summary)
			}
			if result.Branch != c.want {
				t.Errorf("reply %q took the %q branch, want %q", c.reply, result.Branch, c.want)
			}
		})
	}
}

func TestConditionalWithNoConditionFails(t *testing.T) {
	// Rather than silently taking a branch nobody chose.
	r, _, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo YES`)

	result := r.RunNode(context.Background(), runID, conditionalNode(""), t.TempDir(), "")
	if result.Status != "failed" {
		t.Errorf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(strings.ToLower(result.Summary), "condition") {
		t.Errorf("summary does not explain the problem: %q", result.Summary)
	}
}

func TestConditionalSummaryRecordsTheAnswer(t *testing.T) {
	// An operator reading run history needs to know which way the gate went and
	// why, not just that a node completed.
	r, _, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo NO`)

	result := r.RunNode(context.Background(), runID, conditionalNode("is it safe?"), t.TempDir(), "")
	if !strings.Contains(result.Summary, "is it safe?") {
		t.Errorf("summary omits the question: %q", result.Summary)
	}
	if !strings.Contains(strings.ToUpper(result.Summary), "FALSE") {
		t.Errorf("summary omits the answer: %q", result.Summary)
	}
}

func TestMemoryNodeWritesWhatItSummarised(t *testing.T) {
	r, s, runID := testRunner(t)
	r.AgentPath = fakeAgent(t, `echo "- finding one\n- finding two"`)

	node := graph.Node{ID: "m1", Type: "memory",
		Data: graph.NodeData{Label: "Run summary", MemoryScope: "workflow"}}
	result := r.RunNode(context.Background(), runID, node, t.TempDir(), "")

	if result.Status != "completed" {
		t.Fatalf("status = %q (%s)", result.Status, result.Summary)
	}
	var value string
	if err := s.DB().QueryRow(
		`SELECT value_text FROM memory_entries WHERE workflow_run_id = ? AND key = 'Run summary'`,
		runID).Scan(&value); err != nil {
		t.Fatalf("the memory node wrote no memory: %v", err)
	}
	if !strings.Contains(value, "finding one") {
		t.Errorf("memory value = %q", value)
	}
}

func TestWebhookPostsAndRecordsTheStatus(t *testing.T) {
	var gotBody, gotMethod, gotContentType string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		gotMethod = req.Method
		gotContentType = req.Header.Get("Content-Type")
		buf := make([]byte, 4096)
		n, _ := req.Body.Read(buf)
		gotBody = string(buf[:n])
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("thanks"))
	}))
	defer target.Close()

	r, _, runID := testRunner(t)
	node := graph.Node{ID: "w1", Type: "webhook",
		Data: graph.NodeData{Label: "Notify", URL: target.URL}}

	result := r.RunNode(context.Background(), runID, node, t.TempDir(), "the run context")
	if result.Status != "completed" {
		t.Fatalf("status = %q (%s)", result.Status, result.Summary)
	}
	if gotMethod != "POST" {
		t.Errorf("method = %q, want POST", gotMethod)
	}
	if gotContentType != "application/json" {
		t.Errorf("Content-Type = %q", gotContentType)
	}
	if !strings.Contains(gotBody, "the run context") {
		t.Errorf("the payload did not carry the run context: %s", gotBody)
	}
	if !strings.Contains(result.Summary, "200") {
		t.Errorf("summary omits the response status: %q", result.Summary)
	}
}

func TestWebhookHonoursAPayloadTemplate(t *testing.T) {
	var gotBody string
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		buf := make([]byte, 4096)
		n, _ := req.Body.Read(buf)
		gotBody = string(buf[:n])
	}))
	defer target.Close()

	r, _, runID := testRunner(t)
	node := graph.Node{ID: "w1", Type: "webhook",
		Data: graph.NodeData{Label: "Notify", URL: target.URL,
			PayloadTemplate: `{"text":"{{context}}"}`}}

	r.RunNode(context.Background(), runID, node, t.TempDir(), "SUBSTITUTED")
	if !strings.Contains(gotBody, "SUBSTITUTED") {
		t.Errorf("{{context}} was not substituted: %s", gotBody)
	}
	if strings.Contains(gotBody, "{{context}}") {
		t.Errorf("the placeholder survived: %s", gotBody)
	}
}

func TestWebhookFailsOnAnErrorStatus(t *testing.T) {
	// A 500 that reported success would let a run continue as though the
	// notification landed.
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer target.Close()

	r, _, runID := testRunner(t)
	node := graph.Node{ID: "w1", Type: "webhook", Data: graph.NodeData{Label: "Notify", URL: target.URL}}

	result := r.RunNode(context.Background(), runID, node, t.TempDir(), "")
	if result.Status != "failed" {
		t.Errorf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Summary, "500") {
		t.Errorf("summary omits the status code: %q", result.Summary)
	}
}

func TestWebhookRejectsANonHTTPURL(t *testing.T) {
	// file:// would read a local file; a bare host is a typo.
	r, _, runID := testRunner(t)
	for _, url := range []string{"", "file:///etc/passwd", "example.com/hook", "ftp://x/y"} {
		node := graph.Node{ID: "w1", Type: "webhook", Data: graph.NodeData{Label: "Notify", URL: url}}
		result := r.RunNode(context.Background(), runID, node, t.TempDir(), "")
		if result.Status != "failed" {
			t.Errorf("url %q was accepted (%s)", url, result.Status)
		}
	}
}

func TestWebhookFailureIsNotAPanic(t *testing.T) {
	// An unreachable host must fail the step, not take the process down.
	r, _, runID := testRunner(t)
	node := graph.Node{ID: "w1", Type: "webhook",
		Data: graph.NodeData{Label: "Notify", URL: "http://127.0.0.1:1/nope"}}

	result := r.RunNode(context.Background(), runID, node, t.TempDir(), "")
	if result.Status != "failed" {
		t.Errorf("status = %q, want failed", result.Status)
	}
	if result.Summary == "" {
		t.Error("no reason recorded")
	}
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
