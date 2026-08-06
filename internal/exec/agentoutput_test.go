package exec

import (
	"strings"
	"testing"
)

// Ported from specter_exec/agent_output.py --self-check.
//
// Deliberately tolerant: this parses a live subprocess stream whose format is
// not ours. A parser that throws on an unexpected line fails a run that was
// doing fine.

func collect(line string) []string {
	var out []string
	AppendProgress(line, func(s string) { out = append(out, s) })
	return out
}

func TestAppendProgress(t *testing.T) {
	tests := []struct {
		name string
		line string
		want []string
	}{
		// Agents that do not speak the event protocol would otherwise show
		// nothing at all while they run.
		{"plain text passes through", "scanning 14 files", []string{"scanning 14 files"}},
		{"blank lines emit nothing", "   ", nil},
		{
			"item.completed emits its text",
			`{"type":"item.completed","item":{"text":"did the thing"}}`,
			[]string{"did the thing"},
		},
		{
			"item.completed falls back to content",
			`{"type":"item.completed","item":{"content":"via content"}}`,
			[]string{"via content"},
		},
		{
			"turn.completed reports token usage",
			`{"type":"turn.completed","usage":{"output_tokens":42}}`,
			[]string{"[turn completed - 42 output tokens]"},
		},
		{"an unknown event type is silent", `{"type":"something.else"}`, nil},
		// A truncated write must not blow up mid-stream.
		{"a truncated JSON line is skipped", `{"type": "item.comp`, nil},
		// Only "{" marks an event. A line starting "[" is agent prose that
		// happens to look like JSON, and is shown rather than swallowed —
		// dropping output is worse than showing a stray bracket.
		{"a JSON array is shown as text", `["not","a","dict"]`, []string{`["not","a","dict"]`}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := collect(tc.line)
			if len(got) != len(tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Fatalf("got %q, want %q", got[i], tc.want[i])
				}
			}
		})
	}
}

// Long output is a progress LINE, not a file dump.
func TestProgressLineIsTruncated(t *testing.T) {
	long := strings.Repeat("x", 5000)
	got := collect(`{"type":"item.completed","item":{"text":"` + long + `"}}`)
	if len(got) != 1 {
		t.Fatalf("want one line, got %d", len(got))
	}
	if len(got[0]) != ProgressLineLimit {
		t.Fatalf("want %d chars, got %d", ProgressLineLimit, len(got[0]))
	}
}

// The LAST agent_message is the answer; earlier ones are working notes.
func TestFinalMessage(t *testing.T) {
	stream := strings.Join([]string{
		`{"item":{"type":"agent_message","text":"thinking"}}`,
		`not json at all`,
		`{"item":{"type":"agent_message","text":"the answer"}}`,
	}, "\n")

	if got := FinalMessage(stream); got != "the answer" {
		t.Fatalf("want the last message, got %q", got)
	}
	if got := FinalMessage("no events here"); got != "" {
		t.Fatalf("want empty, got %q", got)
	}
}

func TestErrorMessage(t *testing.T) {
	tests := []struct {
		name   string
		stream string
		want   string
	}{
		{"a bare error event", `{"type":"error","message":"rate limited"}`, "rate limited"},
		{"turn.failed nests it", `{"type":"turn.failed","error":{"message":"quota exceeded"}}`, "quota exceeded"},
		{"a clean run has none", `{"type":"turn.completed"}`, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ErrorMessage(tc.stream); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
