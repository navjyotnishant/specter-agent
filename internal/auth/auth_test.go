// Tests written before the implementation.
//
// Two things must survive the port, and neither is testable by round-tripping
// this package against itself:
//
//  1. bcrypt hashes ALREADY IN THE DATABASE, written by passlib, must verify.
//     The fixture is produced by the real passlib CryptContext in the running
//     container. Existing users cannot sign in otherwise, and the failure looks
//     like "wrong password" rather than like a broken port.
//
//  2. Session lookup is by SHA-256 of the token, so a Go-issued token and a
//     Python-issued one are interchangeable. Both backends can serve the same
//     sessions table during cutover — which is the entire point of running them
//     side by side.
package auth

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

type bcryptCase struct {
	Password string `json:"password"`
	Hash     string `json:"hash"`
}

func loadBcryptFixture(t *testing.T) map[string]bcryptCase {
	t.Helper()
	body, err := os.ReadFile("testdata/passlib_bcrypt.json")
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	var cases map[string]bcryptCase
	if err := json.Unmarshal(body, &cases); err != nil {
		t.Fatalf("parsing fixture: %v", err)
	}
	if len(cases) == 0 {
		t.Fatal("fixture is empty")
	}
	return cases
}

// The one that matters: hashes written by Python must verify here.
func TestVerifiesPasslibHashes(t *testing.T) {
	for name, c := range loadBcryptFixture(t) {
		t.Run(name, func(t *testing.T) {
			if !VerifyPassword(c.Password, c.Hash) {
				t.Errorf("passlib hash did not verify — existing users cannot sign in")
			}
			if VerifyPassword(c.Password+"x", c.Hash) {
				t.Error("a wrong password verified")
			}
		})
	}
}

func TestHashPasswordUsesTheSameCostAsPython(t *testing.T) {
	hash, err := HashPassword("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	// Python writes $2b$12$. A different cost still verifies, but a Go-created
	// user would be cheaper or slower to attack than a Python-created one, and
	// nothing would say so.
	if !strings.HasPrefix(hash, "$2a$12$") && !strings.HasPrefix(hash, "$2b$12$") {
		t.Errorf("cost/prefix drifted from Python's: %s", hash[:7])
	}
	if !VerifyPassword("hunter2", hash) {
		t.Error("own hash did not verify")
	}
}

func TestEmptyHashIsRejected(t *testing.T) {
	// A user row with no hash must not authenticate. bcrypt errors on a malformed
	// hash; treating an error as anything but "no" would be an auth bypass.
	for _, h := range []string{"", "not-a-hash", "$2b$12$tooshort"} {
		if VerifyPassword("anything", h) {
			t.Errorf("malformed hash %q verified", h)
		}
	}
}

func TestTokenHashMatchesPythonsSHA256(t *testing.T) {
	// Python: hashlib.sha256(token.encode()).hexdigest()
	// Verified against the real value below, not against this package.
	const token = "specter-test-token"
	const want = "884159cd26816c948312851e5e1c84ae62f63b8aef5c5ca78645725358828281"
	if got := HashToken(token); got != want {
		t.Errorf("token hash drifted from Python's\n got %s\nwant %s", got, want)
	}
}

// --- session lifecycle, against a real database ---

func testStore(t *testing.T) *store.Store {
	t.Helper()
	s, err := store.Open(t.TempDir() + "/app.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func seedUser(t *testing.T, s *store.Store, email, password, role string) string {
	t.Helper()
	hash, err := HashPassword(password)
	if err != nil {
		t.Fatal(err)
	}
	id := "u-" + email
	_, err = s.DB().Exec(
		`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
		id, strings.ToLower(email), hash, role)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAuthenticateIssuesAResolvableToken(t *testing.T) {
	s := testStore(t)
	id := seedUser(t, s, "admin@local.dev", "hunter2", "admin")

	user, token, err := Authenticate(s, "admin@local.dev", "hunter2")
	if err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if user.ID != id || user.Role != "admin" {
		t.Errorf("wrong user: %+v", user)
	}
	if len(token) < 32 {
		t.Errorf("token is too short to be a credential: %d chars", len(token))
	}

	got, err := UserForToken(s, token)
	if err != nil || got == nil {
		t.Fatalf("token did not resolve: %v", err)
	}
	if got.ID != id {
		t.Errorf("resolved the wrong user")
	}
}

func TestAuthenticateIsCaseInsensitiveOnEmail(t *testing.T) {
	// Python lowercases on both insert and lookup. A Go backend that did not
	// would reject a user who capitalised their email — indistinguishable from
	// a wrong password.
	s := testStore(t)
	seedUser(t, s, "admin@local.dev", "hunter2", "admin")
	if _, _, err := Authenticate(s, "  Admin@Local.DEV  ", "hunter2"); err != nil {
		t.Errorf("mixed-case email rejected: %v", err)
	}
}

func TestWrongPasswordAndUnknownUserFailIdentically(t *testing.T) {
	// Distinguishable errors enumerate accounts.
	s := testStore(t)
	seedUser(t, s, "admin@local.dev", "hunter2", "admin")

	_, _, wrongPass := Authenticate(s, "admin@local.dev", "nope")
	_, _, noUser := Authenticate(s, "ghost@local.dev", "nope")
	if wrongPass == nil || noUser == nil {
		t.Fatal("a bad credential succeeded")
	}
	if wrongPass.Error() != noUser.Error() {
		t.Errorf("errors differ, which enumerates accounts:\n  %v\n  %v", wrongPass, noUser)
	}
}

func TestRevokedTokenStopsResolving(t *testing.T) {
	s := testStore(t)
	seedUser(t, s, "admin@local.dev", "hunter2", "admin")
	_, token, _ := Authenticate(s, "admin@local.dev", "hunter2")

	if err := RevokeToken(s, token); err != nil {
		t.Fatal(err)
	}
	user, err := UserForToken(s, token)
	if err != nil {
		t.Fatal(err)
	}
	if user != nil {
		t.Error("a revoked token still resolves")
	}
}

func TestExpiredTokenStopsResolving(t *testing.T) {
	s := testStore(t)
	id := seedUser(t, s, "admin@local.dev", "hunter2", "admin")

	token := "expired-token-value"
	_, err := s.DB().Exec(
		`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
		"s-1", id, HashToken(token),
		time.Now().UTC().Add(-time.Hour).Format(time.RFC3339))
	if err != nil {
		t.Fatal(err)
	}

	user, err := UserForToken(s, token)
	if err != nil {
		t.Fatal(err)
	}
	if user != nil {
		t.Error("an expired session still resolves")
	}
}

func TestUnknownTokenResolvesToNothingWithoutError(t *testing.T) {
	// A missing session is "not signed in", not a server error — otherwise every
	// stale browser tab produces a 500.
	s := testStore(t)
	user, err := UserForToken(s, "never-issued")
	if err != nil {
		t.Fatalf("unknown token errored: %v", err)
	}
	if user != nil {
		t.Error("an unissued token resolved to a user")
	}
}

func TestBearerParsing(t *testing.T) {
	cases := []struct{ header, want string }{
		{"Bearer abc123", "abc123"},
		{"Bearer   abc123  ", "abc123"},
		{"bearer abc123", ""}, // Python uses startswith("Bearer "), case-sensitive
		{"abc123", ""},        // no scheme
		{"Bearer ", ""},       // scheme, no token
		{"", ""},
	}
	for _, c := range cases {
		if got := BearerToken(c.header); got != c.want {
			t.Errorf("BearerToken(%q) = %q, want %q", c.header, got, c.want)
		}
	}
}

func TestTokensAreUniquePerCall(t *testing.T) {
	s := testStore(t)
	seedUser(t, s, "admin@local.dev", "hunter2", "admin")
	seen := map[string]bool{}
	for i := 0; i < 20; i++ {
		_, token, err := Authenticate(s, "admin@local.dev", "hunter2")
		if err != nil {
			t.Fatal(err)
		}
		if seen[token] {
			t.Fatal("a token repeated — the source of randomness is broken")
		}
		seen[token] = true
	}
}
