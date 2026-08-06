// Package auth ports backend/app/runtime/auth.py.
//
// Sessions are opaque random tokens stored as their SHA-256 digest — no JWT,
// nothing signed, nothing self-describing. That matters for the port: a token
// issued by the Python backend and one issued here are interchangeable, because
// the only thing either writes is a digest and an expiry. Both backends can
// serve the same auth_sessions table during cutover.
//
// The bcrypt hashes already in the database were written by passlib. Go's
// x/crypto/bcrypt reads the same $2b$ format, so existing users keep their
// passwords — which is asserted against a real passlib fixture in the tests
// rather than assumed.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

// Matches passlib's default. A user created by Go and one created by Python
// must be equally expensive to attack.
const bcryptCost = 12

const sessionDays = 7

// ErrInvalidCredentials is returned for BOTH a wrong password and an unknown
// user. Distinguishing them lets an attacker enumerate accounts.
var ErrInvalidCredentials = errors.New("invalid email or password")

// User is the public shape — never carries password_hash.
type User struct {
	ID        string `json:"id"`
	Email     string `json:"email"`
	Role      string `json:"role"`
	CreatedAt string `json:"created_at"`
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return "", fmt.Errorf("hashing password: %w", err)
	}
	return string(hash), nil
}

// VerifyPassword reports whether the password matches. A malformed or empty
// hash is a non-match, never a pass — bcrypt errors on one, and treating any
// error as anything other than "no" would be an authentication bypass.
func VerifyPassword(password, hash string) bool {
	return bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) == nil
}

// HashToken mirrors Python's hashlib.sha256(token.encode()).hexdigest().
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// newToken mirrors secrets.token_urlsafe(32) — 32 random bytes, base64url,
// unpadded.
func newToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generating token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func normalizeEmail(email string) string {
	return strings.ToLower(strings.TrimSpace(email))
}

// Authenticate checks the password and issues a session.
func Authenticate(s *store.Store, email, password string) (User, string, error) {
	var user User
	var hash string
	err := s.DB().QueryRow(
		`SELECT id, email, role, created_at, password_hash FROM users WHERE email = ?`,
		normalizeEmail(email),
	).Scan(&user.ID, &user.Email, &user.Role, &user.CreatedAt, &hash)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Still run a comparison so a missing user and a wrong password take
		// comparable time. Without it, response latency answers "does this
		// account exist" for free.
		bcrypt.CompareHashAndPassword([]byte("$2b$12$"+strings.Repeat("x", 53)), []byte(password))
		return User{}, "", ErrInvalidCredentials
	case err != nil:
		return User{}, "", fmt.Errorf("looking up user: %w", err)
	}

	if !VerifyPassword(password, hash) {
		return User{}, "", ErrInvalidCredentials
	}

	token, err := issueSession(s, user.ID, sessionDays)
	if err != nil {
		return User{}, "", err
	}
	return user, token, nil
}

// IssueServiceToken mints a long-lived session for a background integration —
// the Telegram poller calls the API on the configuring user's behalf. Revoking
// it is the same as revoking any other session.
func IssueServiceToken(s *store.Store, userID string, days int) (string, error) {
	return issueSession(s, userID, days)
}

func issueSession(s *store.Store, userID string, days int) (string, error) {
	token, err := newToken()
	if err != nil {
		return "", err
	}
	expires := time.Now().UTC().AddDate(0, 0, days).Format(time.RFC3339)
	if _, err := s.DB().Exec(
		`INSERT INTO auth_sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
		newID(), userID, HashToken(token), expires,
	); err != nil {
		return "", fmt.Errorf("creating session: %w", err)
	}
	return token, nil
}

// UserForToken resolves a session. An unknown, revoked, or expired token
// returns (nil, nil) — "not signed in" is not a server error, or every stale
// browser tab produces a 500.
func UserForToken(s *store.Store, token string) (*User, error) {
	var user User
	err := s.DB().QueryRow(
		`SELECT users.id, users.email, users.role, users.created_at
		   FROM auth_sessions
		   JOIN users ON users.id = auth_sessions.user_id
		  WHERE auth_sessions.token_hash = ?
		    AND auth_sessions.revoked_at IS NULL
		    AND auth_sessions.expires_at > ?`,
		HashToken(token), time.Now().UTC().Format(time.RFC3339),
	).Scan(&user.ID, &user.Email, &user.Role, &user.CreatedAt)

	switch {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, fmt.Errorf("resolving session: %w", err)
	}
	return &user, nil
}

func RevokeToken(s *store.Store, token string) error {
	_, err := s.DB().Exec(
		`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP
		  WHERE token_hash = ? AND revoked_at IS NULL`,
		HashToken(token))
	if err != nil {
		return fmt.Errorf("revoking session: %w", err)
	}
	return nil
}

// BearerToken extracts the credential from an Authorization header, or "" if
// there is none. Case-sensitive on the scheme, matching Python's
// startswith("Bearer ").
func BearerToken(header string) string {
	const scheme = "Bearer "
	if !strings.HasPrefix(header, scheme) {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, scheme))
}

func newID() string {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		// crypto/rand failing is not a condition to paper over with a fallback
		// ID — a predictable session id is worse than a failed login.
		panic("crypto/rand unavailable: " + err.Error())
	}
	raw[6] = (raw[6] & 0x0f) | 0x40 // version 4
	raw[8] = (raw[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%x-%x-%x-%x-%x", raw[0:4], raw[4:6], raw[6:8], raw[8:10], raw[10:16])
}
