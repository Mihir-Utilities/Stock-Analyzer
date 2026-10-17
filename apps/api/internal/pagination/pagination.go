// Package pagination implements keyset (cursor) pagination helpers (docs/03-api-spec.md section 1:
// `?limit=&cursor=`, default 50, max 200, response `{"items":[...],"next_cursor":null|string}`).
package pagination

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strconv"
)

const (
	DefaultLimit = 50
	MaxLimit     = 200
	// maxCursorLen bounds the cursor size accepted from clients.
	maxCursorLen = 1024
)

// ErrInvalidCursor is returned for a cursor that is not one we issued.
var ErrInvalidCursor = errors.New("invalid cursor")

// ErrInvalidLimit is returned for a non-integer or non-positive limit.
var ErrInvalidLimit = errors.New("limit must be a positive integer")

// Params are the parsed `limit` and `cursor` query parameters.
type Params struct {
	Limit  int
	Cursor string // opaque; empty on the first page
}

// Parse reads `limit` and `cursor`. A limit above MaxLimit is clamped to MaxLimit
// (docs/OPEN_QUESTIONS.md: B01 pagination choices); a malformed limit is an error.
func Parse(q url.Values) (Params, error) {
	p := Params{Limit: DefaultLimit, Cursor: q.Get("cursor")}
	if len(p.Cursor) > maxCursorLen {
		return Params{}, ErrInvalidCursor
	}
	if raw := q.Get("limit"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			return Params{}, ErrInvalidLimit
		}
		if n > MaxLimit {
			n = MaxLimit
		}
		p.Limit = n
	}
	return p, nil
}

// Encode turns the keyset values of the last returned row (for example sort key and id) into an
// opaque cursor. Handlers decode into typed values and pass them as SQL parameters.
func Encode(keys ...any) (string, error) {
	b, err := json.Marshal(keys)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// Decode parses a cursor produced by Encode into dst (a pointer to a slice or array of the same shape
// as the keys passed to Encode, for example *[2]json.RawMessage or a typed struct array).
func Decode(cursor string, dst any) error {
	if cursor == "" || len(cursor) > maxCursorLen {
		return ErrInvalidCursor
	}
	b, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return ErrInvalidCursor
	}
	if err := json.Unmarshal(b, dst); err != nil {
		return ErrInvalidCursor
	}
	return nil
}

// Page is the `data` payload of a paginated list response. Items is never null.
type Page[T any] struct {
	Items      []T     `json:"items"`
	NextCursor *string `json:"next_cursor"`
}

// NewPage builds a page from rows fetched with `limit+1` (one extra row tells whether more exist).
// cursorOf derives the cursor from the last row that is kept.
func NewPage[T any](rows []T, limit int, cursorOf func(last T) (string, error)) (Page[T], error) {
	if limit < 1 {
		limit = DefaultLimit
	}
	page := Page[T]{Items: []T{}}
	if len(rows) > limit {
		rows = rows[:limit]
		c, err := cursorOf(rows[len(rows)-1])
		if err != nil {
			return Page[T]{}, err
		}
		page.NextCursor = &c
	}
	page.Items = append(page.Items, rows...)
	return page, nil
}
