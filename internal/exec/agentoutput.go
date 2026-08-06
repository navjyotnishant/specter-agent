package exec

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Parsing the JSON event stream agents emit on stdout.
//
// Codex — and the sandbox wrapper around other agents — writes newline-delimited
// JSON rather than prose. These turn that into the two things a caller needs:
// progress while a run is in flight, and the final message or error once it ends.
//
// Deliberately tolerant. A malformed line is skipped rather than returned as an
// error: this parses a subprocess whose output format is not ours, and failing
// on an unexpected line would fail a run that actually succeeded.

// ProgressLineLimit bounds one item. Agent output can be a whole file; the
// progress view wants a line.
const ProgressLineLimit = 2000

// AppendProgress turns one raw stdout line into zero or one progress lines.
//
// emit receives what should be shown — injected rather than writing to a job
// store, which is what keeps this a parser.
func AppendProgress(line string, emit func(string)) {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return
	}

	// Only "{" marks an event. A line starting "[" is agent prose that happens
	// to resemble JSON; showing a stray bracket beats swallowing real output.
	if !strings.HasPrefix(trimmed, "{") {
		emit(trimmed)
		return
	}

	var event map[string]any
	if err := json.Unmarshal([]byte(trimmed), &event); err != nil {
		// A partial write mid-stream, not an error.
		return
	}

	switch eventType, _ := event["type"].(string); eventType {
	case "item.completed":
		item, _ := event["item"].(map[string]any)
		text, _ := item["text"].(string)
		if text == "" {
			text, _ = item["content"].(string)
		}
		if text != "" {
			if len(text) > ProgressLineLimit {
				text = text[:ProgressLineLimit]
			}
			emit(text)
		}
	case "turn.completed":
		usage, _ := event["usage"].(map[string]any)
		tokens := "?"
		if raw, ok := usage["output_tokens"]; ok {
			// JSON numbers decode as float64; render whole numbers as integers
			// rather than "42.000000".
			if f, ok := raw.(float64); ok {
				tokens = fmt.Sprintf("%d", int64(f))
			} else {
				tokens = fmt.Sprintf("%v", raw)
			}
		}
		emit(fmt.Sprintf("[turn completed - %s output tokens]", tokens))
	}
}

// FinalMessage returns the agent's last substantive message.
//
// The LAST agent_message wins: a run emits several as it works, and the final
// one is its answer.
func FinalMessage(stdout string) string {
	found := ""
	for _, line := range strings.Split(stdout, "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &event); err != nil {
			continue
		}
		item, ok := event["item"].(map[string]any)
		if !ok || item["type"] != "agent_message" {
			continue
		}
		if text, ok := item["text"].(string); ok {
			found = text
		}
	}
	return found
}

// ErrorMessage returns the failure reason when the stream carries one.
//
// Two shapes, both seen in practice: a bare "error" event, and "turn.failed"
// with the message nested under "error".
func ErrorMessage(stdout string) string {
	found := ""
	for _, line := range strings.Split(stdout, "\n") {
		var event map[string]any
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &event); err != nil {
			continue
		}
		switch event["type"] {
		case "error":
			if message, ok := event["message"].(string); ok {
				found = message
			}
		case "turn.failed":
			if errObj, ok := event["error"].(map[string]any); ok {
				if message, ok := errObj["message"].(string); ok {
					found = message
				}
			}
		}
	}
	return found
}
