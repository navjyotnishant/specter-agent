package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/navjyotnishant/specter-agent/internal/store"
)

// server2 is a test server that returns RAW bodies, for cases where the
// response is not JSON — HTML, or an asset.
type server2 struct{ *httptest.Server }

func openTestStore(t *testing.T) (*store.Store, error) {
	t.Helper()
	s, err := store.Open(t.TempDir() + "/app.db")
	if err == nil {
		t.Cleanup(func() { s.Close() })
	}
	return s, err
}

func newServer2(t *testing.T, deps *Deps) *server2 {
	t.Helper()
	srv := httptest.NewServer(NewRouter(deps))
	t.Cleanup(srv.Close)
	return &server2{srv}
}

func (s *server2) raw(t *testing.T, method, path string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, s.URL+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

func (s *server2) header(t *testing.T, method, path, name string) string {
	t.Helper()
	req, _ := http.NewRequest(method, s.URL+path, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	return resp.Header.Get(name)
}
