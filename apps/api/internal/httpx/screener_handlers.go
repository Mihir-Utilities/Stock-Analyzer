package httpx

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/screener"
)

// ScreenerService is the peers, compare and screener surface (B13); *screener.Service implements it.
type ScreenerService interface {
	Query(ctx context.Context, spec *screener.Spec, limit json.RawMessage, cursor *string) (screener.QueryResult, error)
	ListSaved(ctx context.Context) ([]screener.SavedScreen, error)
	SaveScreen(ctx context.Context, name string, spec *screener.Spec) (screener.SavedScreen, bool, error)
	DeleteSaved(ctx context.Context, name string) error
	Peers(ctx context.Context, symbol string, p screener.PeerParams) (screener.PeersResult, error)
	Compare(ctx context.Context, p screener.CompareParams) (screener.CompareResult, error)
}

const (
	screenerSource = "screener_row"
	// screenerBodyLimit bounds a screener query or saved-screen body (a spec is at most 8 KiB).
	screenerBodyLimit int64 = 64 << 10
)

type savedBody struct {
	Name string         `json:"name"`
	Spec *screener.Spec `json:"spec"`
}

// screenerHandler returns the B13 handler for a route, or nil when the route is not one of B13's or
// the service is not wired (the route then stays a 501 stub).
func screenerHandler(rt route, d Deps) http.Handler {
	if d.Screener == nil {
		return nil
	}
	svc := d.Screener
	switch rt.Method + " " + rt.Path {
	case mGet + " /stocks/{symbol}/peers":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			sym, err := pathSymbol(r)
			if err != nil {
				return err
			}
			p, err := screener.ParsePeers(r.URL.Query())
			if err != nil {
				return mapScreenerError(err)
			}
			res, err := svc.Peers(r.Context(), sym, p)
			if err != nil {
				return mapScreenerError(err)
			}
			if res.Redirect != "" {
				WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.Redirect})
				return nil
			}
			WriteData(w, http.StatusOK, res, WithMeta(NewMeta(res.AsOf, screenerSource, anyStale(append([]screener.Stamp{res.Self.Stamp}, peerStamps(res)...)), 0)))
			return nil
		})
	case mGet + " /compare":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			p, err := screener.ParseCompare(r.URL.Query())
			if err != nil {
				return mapScreenerError(err)
			}
			res, err := svc.Compare(r.Context(), p)
			if err != nil {
				return mapScreenerError(err)
			}
			stamps := make([]screener.Stamp, 0, len(res.Symbols))
			for _, s := range res.Symbols {
				stamps = append(stamps, s.Stamp)
			}
			WriteData(w, http.StatusOK, res, WithMeta(NewMeta(res.AsOf, "import+screener_row", anyStale(stamps), 0)))
			return nil
		})
	case mPost + " /screener/query":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var body screener.QueryBody
			if err := DecodeJSON(r, &body); err != nil {
				return err
			}
			res, err := svc.Query(r.Context(), &body.Spec, body.Limit, body.Cursor)
			if err != nil {
				return mapScreenerError(err)
			}
			stamps := make([]screener.Stamp, 0, len(res.Items))
			for _, it := range res.Items {
				stamps = append(stamps, it.Stamp)
			}
			meta := NewMeta(res.AsOf, screenerSource, anyStale(stamps), 0)
			meta["excluded_for_missing"] = res.ExcludedForMissing
			WriteData(w, http.StatusOK, res, WithMeta(meta))
			return nil
		})
	case mGet + " /screener/saved":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			items, err := svc.ListSaved(r.Context())
			if err != nil {
				return mapScreenerError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{
				"items": items, "next_cursor": nil, "max_saved": screener.MaxSaved, "presets": screener.Presets(),
			}, WithMeta(NewMeta(time.Now(), "app_setting", false, 0)))
			return nil
		})
	case mPost + " /screener/saved":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var body savedBody
			if err := DecodeJSON(r, &body); err != nil {
				return err
			}
			if body.Spec == nil {
				return ErrValidation(FieldError{Field: "spec", Message: "is required"})
			}
			saved, created, err := svc.SaveScreen(r.Context(), body.Name, body.Spec)
			if err != nil {
				return mapScreenerError(err)
			}
			status := http.StatusOK
			if created {
				status = http.StatusCreated
			}
			WriteData(w, status, saved)
			return nil
		})
	case mDelete + " /screener/saved/{name}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			name := chi.URLParam(r, "name")
			// chi leaves the segment percent-encoded only when the request carries a RawPath;
			// otherwise it is already decoded and decoding again would turn `A%2541` into `AA`.
			if r.URL.RawPath != "" {
				dec, err := url.PathUnescape(name)
				if err != nil {
					return mapScreenerError(screener.ErrSavedNotFound)
				}
				name = dec
			}
			if err := svc.DeleteSaved(r.Context(), name); err != nil {
				return mapScreenerError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"ok": true})
			return nil
		})
	}
	return nil
}

func peerStamps(res screener.PeersResult) []screener.Stamp {
	out := make([]screener.Stamp, 0, len(res.Peers))
	for _, p := range res.Peers {
		out = append(out, p.Stamp)
	}
	return out
}

// anyStale is true when any listed stock is stale by the D-R owner-data rule; the per-stock flags
// in the data stay authoritative.
func anyStale(stamps []screener.Stamp) bool {
	for _, s := range stamps {
		if s.Stale {
			return true
		}
	}
	return false
}

func mapScreenerError(err error) error {
	var (
		ve *screener.ValidationError
		nf *screener.NotFoundError
		nd *screener.NoDataError
	)
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, screener.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid for this screen"})
	case errors.As(err, &nf):
		return ErrNotFound("Instrument not found", map[string]any{"symbol": safeSymbol(nf.Symbol)})
	case errors.As(err, &nd):
		return ErrDataUnavailable(nd.Reason)
	case errors.Is(err, screener.ErrSavedLimit):
		return NewError(http.StatusConflict, CodeConflict, "At most 30 screens can be saved; delete one first",
			map[string]any{"reason": "saved_screens_limit", "max": screener.MaxSaved})
	case errors.Is(err, screener.ErrSavedNotFound):
		return ErrNotFound("Saved screen not found", nil)
	}
	return err
}

// safeSymbol keeps echoed input printable and short.
func safeSymbol(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "?")
	if len(s) > 40 {
		s = s[:40]
	}
	return s
}
