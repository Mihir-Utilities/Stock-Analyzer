package pagination

import (
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"testing"
)

// API-10
func TestParse(t *testing.T) {
	cases := []struct {
		name    string
		query   string
		want    Params
		wantErr error
	}{
		{"defaults", "", Params{Limit: 50}, nil},
		{"explicit", "limit=10&cursor=abc", Params{Limit: 10, Cursor: "abc"}, nil},
		{"max", "limit=200", Params{Limit: 200}, nil},
		{"clamped", "limit=5000", Params{Limit: 200}, nil},
		{"zero", "limit=0", Params{}, ErrInvalidLimit},
		{"negative", "limit=-3", Params{}, ErrInvalidLimit},
		{"not a number", "limit=ten", Params{}, ErrInvalidLimit},
		{"huge cursor", "cursor=" + strings.Repeat("a", 2000), Params{}, ErrInvalidCursor},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			q, _ := url.ParseQuery(tc.query)
			got, err := Parse(q)
			if !errors.Is(err, tc.wantErr) || got != tc.want {
				t.Fatalf("got %+v, %v; want %+v, %v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestCursorRoundTrip(t *testing.T) {
	c, err := Encode("2026-09-01", 42)
	if err != nil {
		t.Fatal(err)
	}
	if strings.ContainsAny(c, "+/= ") {
		t.Fatalf("cursor not URL safe: %q", c)
	}
	var keys [2]json.RawMessage
	if err := Decode(c, &keys); err != nil {
		t.Fatal(err)
	}
	if string(keys[0]) != `"2026-09-01"` || string(keys[1]) != "42" {
		t.Fatalf("keys = %s %s", keys[0], keys[1])
	}
}

func TestDecodeRejectsGarbage(t *testing.T) {
	var keys []any
	for _, bad := range []string{"", "!!!", "bm90IGpzb24", strings.Repeat("A", 2000)} {
		if err := Decode(bad, &keys); !errors.Is(err, ErrInvalidCursor) {
			t.Fatalf("Decode(%q) = %v", bad, err)
		}
	}
}

func TestNewPage(t *testing.T) {
	cursorOf := func(n int) (string, error) { return Encode(n) }
	rows := []int{1, 2, 3}
	p, err := NewPage(rows, 2, cursorOf)
	if err != nil || len(p.Items) != 2 || p.NextCursor == nil {
		t.Fatalf("page = %+v, %v", p, err)
	}
	var keys []int
	if err := Decode(*p.NextCursor, &keys); err != nil || keys[0] != 2 {
		t.Fatalf("next cursor keys = %v, %v", keys, err)
	}
	last, _ := NewPage(rows, 3, cursorOf)
	if last.NextCursor != nil || len(last.Items) != 3 {
		t.Fatalf("last page = %+v", last)
	}
	empty, _ := NewPage([]int(nil), 50, cursorOf)
	b, _ := json.Marshal(empty)
	if string(b) != `{"items":[],"next_cursor":null}` {
		t.Fatalf("empty page JSON = %s", b)
	}
}
