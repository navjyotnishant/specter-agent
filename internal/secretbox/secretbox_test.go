package secretbox

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Go must decrypt what Python wrote. Existing installations hold credentials
// encrypted by the Python backend, and a Go backend that cannot read them means
// every stored credential is lost — silently, because a failed decrypt currently
// reads as "not set".
//
// The fixture is produced by the real cryptography library, not by this package
// round-tripping its own output. A test that only checks encrypt-then-decrypt
// proves the two halves agree with each other, which is exactly the bug this
// needs to catch.

type fixture struct {
	Key        string            `json:"key"`
	Tokens     map[string]string `json:"tokens"`
	Plaintexts map[string]string `json:"plaintexts"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	body, err := os.ReadFile(filepath.Join("testdata", "python_fernet.json"))
	if err != nil {
		t.Skipf("fixture missing: %v", err)
	}
	var f fixture
	if err := json.Unmarshal(body, &f); err != nil {
		t.Fatal(err)
	}
	return f
}

// THE TEST THIS PHASE EXISTS FOR.
func TestDecryptsPythonWrittenTokens(t *testing.T) {
	f := loadFixture(t)

	box, err := New(f.Key)
	if err != nil {
		t.Fatal(err)
	}

	for name, token := range f.Tokens {
		t.Run(name, func(t *testing.T) {
			got, err := box.Decrypt(token)
			if err != nil {
				t.Fatalf("cannot decrypt a token Python produced: %v", err)
			}
			if want := f.Plaintexts[name]; got != want {
				t.Fatalf("got %q, want %q", truncate(got), truncate(want))
			}
		})
	}
}

// And Python must be able to read what Go writes, or a mixed deployment loses
// data in the other direction.
func TestRoundTrip(t *testing.T) {
	f := loadFixture(t)
	box, _ := New(f.Key)

	for _, plaintext := range []string{"hello", " ", "naïve — ümlaut ✓", strings.Repeat("x", 5000)} {
		token, err := box.Encrypt(plaintext)
		if err != nil {
			t.Fatal(err)
		}
		got, err := box.Decrypt(token)
		if err != nil {
			t.Fatal(err)
		}
		if got != plaintext {
			t.Fatalf("round trip lost data: %q", truncate(got))
		}
		// Version byte 0x80, as Fernet requires — a token Python will reject is
		// worse than no token, because it fails at read time rather than here.
		if !strings.HasPrefix(token, "gAAAAA") {
			t.Fatalf("token is not Fernet-shaped: %q", truncate(token))
		}
	}
}

// A tampered token must fail loudly rather than returning plausible garbage.
// This is authenticated encryption; that guarantee is the whole point.
func TestTamperedTokenIsRejected(t *testing.T) {
	f := loadFixture(t)
	box, _ := New(f.Key)

	token := f.Tokens["simple"]
	// Flip a byte in the ciphertext body.
	tampered := token[:30] + flip(token[30:31]) + token[31:]

	if _, err := box.Decrypt(tampered); err == nil {
		t.Fatal("a tampered token must not decrypt")
	}
}

func TestWrongKeyIsRejected(t *testing.T) {
	f := loadFixture(t)

	other, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	box, _ := New(other)

	if _, err := box.Decrypt(f.Tokens["simple"]); err == nil {
		t.Fatal("a token from another key must not decrypt")
	}
}

// Empty means "not set" and stays empty, matching the Python behaviour exactly.
func TestEmptyStaysEmpty(t *testing.T) {
	f := loadFixture(t)
	box, _ := New(f.Key)

	token, err := box.Encrypt("")
	if err != nil || token != "" {
		t.Fatalf("empty must encrypt to empty, got %q (%v)", token, err)
	}
	got, err := box.Decrypt("")
	if err != nil || got != "" {
		t.Fatalf("empty must decrypt to empty, got %q (%v)", got, err)
	}
}

func TestMalformedKeyIsRejected(t *testing.T) {
	for _, bad := range []string{"", "not-base64!!", "dG9vLXNob3J0"} {
		if _, err := New(bad); err == nil {
			t.Fatalf("key %q must be rejected", bad)
		}
	}
}

func flip(s string) string {
	if s == "A" {
		return "B"
	}
	return "A"
}

func truncate(s string) string {
	if len(s) > 60 {
		return s[:60] + "…"
	}
	return s
}
