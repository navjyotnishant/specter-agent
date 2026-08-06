package store

import (
	"database/sql"
	"os"
	"sort"
	"strings"
	"testing"
)

// Compares a Go-created database against a real production one, table by table.
// Skipped unless PROD_DB points at a copy — this is a spot-check against the
// running system, not a unit test.
func TestMatchesProductionSchema(t *testing.T) {
	path := os.Getenv("PROD_DB")
	if path == "" {
		t.Skip("set PROD_DB to a copy of a production database")
	}
	prod, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer prod.Close()

	fresh, err := Open(t.TempDir() + "/fresh.db")
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()

	cols := func(db *sql.DB, table string) []string {
		rows, err := db.Query("PRAGMA table_info(" + table + ")")
		if err != nil {
			return nil
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var cid, notNull, pk int
			var name, ctype string
			var dflt any
			rows.Scan(&cid, &name, &ctype, &notNull, &dflt, &pk)
			out = append(out, name)
		}
		sort.Strings(out)
		return out
	}

	rows, err := prod.Query(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	rows.Close()

	for _, table := range names {
		p, g := cols(prod, table), cols(fresh.DB(), table)
		var missing []string
		for _, c := range p {
			if !contains(g, c) {
				missing = append(missing, c)
			}
		}
		if len(missing) > 0 {
			t.Errorf("%s: Go-created database is missing %v", table, strings.Join(missing, ", "))
		}
	}
	t.Logf("compared %d production tables", len(names))
}

func contains(haystack []string, needle string) bool {
	for _, h := range haystack {
		if h == needle {
			return true
		}
	}
	return false
}
