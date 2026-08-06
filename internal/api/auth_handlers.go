// Handlers for /api/auth, ported from backend/app/routers/auth.py.
//
// Five rules here are load-bearing. Each one is a lockout or a takeover if
// dropped, and none of them is obvious from the endpoint's name — see the
// comment at each.
package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"

	"github.com/navjyotnishant/specter-agent/internal/auth"
)

// bcrypt silently ignores everything past 72 bytes.
const maxPasswordBytes = 72
const minPasswordChars = 8

func withUser(ctx context.Context, u *auth.User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

func userFrom(r *http.Request) *auth.User {
	user, _ := r.Context().Value(userKey).(*auth.User)
	return user
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Role     string `json:"role"`
}

// validatePassword enforces the rules bcrypt cannot enforce for itself.
//
// The byte count is deliberate: 40 two-byte characters is 80 bytes, so counting
// runes would let a password past the cap and silently truncate it. The user
// would believe they set something stronger than what actually guards the
// account.
func validatePassword(password string) error {
	if len([]rune(password)) < minPasswordChars {
		return errors.New("Password must be at least 8 characters")
	}
	if len(password) > maxPasswordBytes {
		return errors.New("Password must be 72 bytes or fewer")
	}
	return nil
}

func validateEmail(email string) (string, error) {
	normalized := strings.ToLower(strings.TrimSpace(email))
	at := strings.LastIndex(normalized, "@")
	if at <= 0 || !strings.Contains(normalized[at+1:], ".") {
		return "", errors.New("Invalid email address")
	}
	return normalized, nil
}

func (d *Deps) hasAnyUser() (bool, error) {
	var n int
	err := d.Store.DB().QueryRow(`SELECT COUNT(*) FROM users`).Scan(&n)
	return n > 0, err
}

func (d *Deps) authStatus(w http.ResponseWriter, _ *http.Request) {
	exists, err := d.hasAnyUser()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read users")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"needs_setup": !exists})
}

// bootstrap creates the first admin — and only ever the first. A second
// bootstrap would mint an admin account on a live system with no credential.
func (d *Deps) bootstrap(w http.ResponseWriter, r *http.Request) {
	var req credentials
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	email, err := validateEmail(req.Email)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	exists, err := d.hasAnyUser()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not read users")
		return
	}
	if exists {
		writeError(w, http.StatusConflict, "Admin user already exists")
		return
	}

	user, err := d.insertUser(email, req.Password, "admin")
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not create the admin user")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (d *Deps) login(w http.ResponseWriter, r *http.Request) {
	var req credentials
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	user, token, err := auth.Authenticate(d.Store, req.Email, req.Password)
	if err != nil {
		if errors.Is(err, auth.ErrInvalidCredentials) {
			writeError(w, http.StatusUnauthorized, "Invalid email or password")
			return
		}
		writeError(w, http.StatusInternalServerError, "Could not sign in")
		return
	}
	// Stamped on each successful login: it tells a live account from an
	// abandoned one, which is the difference between a user list and an audit.
	d.Store.DB().Exec(`UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ?`, user.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "token": token})
}

// logout needs no auth middleware: it revokes whatever token it is handed, and
// a caller can only hand over a token they already hold.
func (d *Deps) logout(w http.ResponseWriter, r *http.Request) {
	if token := auth.BearerToken(r.Header.Get("Authorization")); token != "" {
		auth.RevokeToken(d.Store, token)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (d *Deps) me(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"user": userFrom(r)})
}

func (d *Deps) listUsers(w http.ResponseWriter, _ *http.Request) {
	rows, err := d.Store.DB().Query(
		`SELECT id, email, role, created_at, last_seen_at FROM users ORDER BY created_at DESC`)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not list users")
		return
	}
	defer rows.Close()

	// Never SELECT *: password_hash is one column away, and a leaked hash is
	// offline-crackable forever.
	out := []map[string]any{}
	for rows.Next() {
		var id, email, role, createdAt string
		var lastSeen sql.NullString
		if err := rows.Scan(&id, &email, &role, &createdAt, &lastSeen); err != nil {
			writeError(w, http.StatusInternalServerError, "Could not read users")
			return
		}
		out = append(out, map[string]any{
			"id": id, "email": email, "role": role,
			"created_at": createdAt, "last_seen_at": lastSeen.String,
		})
	}
	writeJSON(w, http.StatusOK, out)
}

func (d *Deps) insertUser(email, password, role string) (map[string]any, error) {
	hash, err := auth.HashPassword(password)
	if err != nil {
		return nil, err
	}
	id := uuid.NewString()
	if _, err := d.Store.DB().Exec(
		`INSERT INTO users (id, email, password_hash, role) VALUES (?, ?, ?, ?)`,
		id, email, hash, role); err != nil {
		return nil, err
	}
	var createdAt string
	d.Store.DB().QueryRow(`SELECT created_at FROM users WHERE id = ?`, id).Scan(&createdAt)
	return map[string]any{"id": id, "email": email, "role": role, "created_at": createdAt}, nil
}

func (d *Deps) createUser(w http.ResponseWriter, r *http.Request) {
	var req credentials
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Role == "" {
		req.Role = "operator"
	}
	if req.Role != "admin" && req.Role != "operator" {
		writeError(w, http.StatusBadRequest, "Role must be admin or operator")
		return
	}
	email, err := validateEmail(req.Email)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var exists int
	d.Store.DB().QueryRow(`SELECT COUNT(*) FROM users WHERE email = ?`, email).Scan(&exists)
	if exists > 0 {
		writeError(w, http.StatusConflict, "User already exists")
		return
	}

	user, err := d.insertUser(email, req.Password, req.Role)
	if err != nil {
		// The UNIQUE constraint is the real guard; the check above is only for a
		// clean message. A race between them still lands here.
		writeError(w, http.StatusConflict, "User already exists")
		return
	}
	writeJSON(w, http.StatusOK, user)
}

// deleteUser refuses self-deletion — the fastest way to lock every admin out.
func (d *Deps) deleteUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if current := userFrom(r); current != nil && current.ID == userID {
		writeError(w, http.StatusBadRequest, "You cannot delete your own account")
		return
	}
	d.Store.DB().Exec(`DELETE FROM auth_sessions WHERE user_id = ?`, userID)
	res, err := d.Store.DB().Exec(`DELETE FROM users WHERE id = ?`, userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not delete the user")
		return
	}
	n, _ := res.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"deleted": n > 0, "user_id": userID})
}

// changeUserRole refuses to demote the last admin. Doing so locks everyone out
// of user management with no recovery path, so it is refused rather than
// warned about.
func (d *Deps) changeUserRole(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	var req struct {
		Role string `json:"role"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if req.Role != "admin" && req.Role != "operator" {
		writeError(w, http.StatusBadRequest, "Role must be admin or operator")
		return
	}

	var currentRole string
	switch err := d.Store.DB().QueryRow(`SELECT role FROM users WHERE id = ?`, userID).Scan(&currentRole); {
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "User not found")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "Could not read the user")
		return
	}

	if currentRole == "admin" && req.Role != "admin" {
		var admins int
		d.Store.DB().QueryRow(`SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&admins)
		if admins <= 1 {
			writeError(w, http.StatusBadRequest,
				"This is the only admin account — promote another user before changing this one")
			return
		}
	}

	if _, err := d.Store.DB().Exec(
		`UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		req.Role, userID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the role")
		return
	}

	var email, createdAt string
	var lastSeen sql.NullString
	d.Store.DB().QueryRow(
		`SELECT email, created_at, last_seen_at FROM users WHERE id = ?`, userID).
		Scan(&email, &createdAt, &lastSeen)
	writeJSON(w, http.StatusOK, map[string]any{
		"id": userID, "email": email, "role": req.Role,
		"created_at": createdAt, "last_seen_at": lastSeen.String,
	})
}

// resetUserPassword is the admin recovery path for a locked-out user, who
// otherwise has none. It deletes that user's sessions: a reset that leaves old
// sessions live has not actually locked anyone out.
func (d *Deps) resetUserPassword(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	var req struct {
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validatePassword(req.Password); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var exists string
	switch err := d.Store.DB().QueryRow(`SELECT id FROM users WHERE id = ?`, userID).Scan(&exists); {
	case errors.Is(err, sql.ErrNoRows):
		writeError(w, http.StatusNotFound, "User not found")
		return
	case err != nil:
		writeError(w, http.StatusInternalServerError, "Could not read the user")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not hash the password")
		return
	}
	if _, err := d.Store.DB().Exec(
		`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		hash, userID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the password")
		return
	}
	d.Store.DB().Exec(`DELETE FROM auth_sessions WHERE user_id = ?`, userID)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "user_id": userID})
}

// changeOwnPassword requires the CURRENT password. Without that, a stolen
// session token is a permanent account takeover rather than a temporary one.
func (d *Deps) changeOwnPassword(w http.ResponseWriter, r *http.Request) {
	current := userFrom(r)
	var req struct {
		CurrentPassword string `json:"current_password"`
		NewPassword     string `json:"new_password"`
	}
	if err := decode(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := validatePassword(req.NewPassword); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var hash string
	if err := d.Store.DB().QueryRow(
		`SELECT password_hash FROM users WHERE id = ?`, current.ID).Scan(&hash); err != nil {
		writeError(w, http.StatusForbidden, "Current password is incorrect")
		return
	}
	if !auth.VerifyPassword(req.CurrentPassword, hash) {
		writeError(w, http.StatusForbidden, "Current password is incorrect")
		return
	}

	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "Could not hash the password")
		return
	}
	if _, err := d.Store.DB().Exec(
		`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		newHash, current.ID); err != nil {
		writeError(w, http.StatusInternalServerError, "Could not update the password")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
