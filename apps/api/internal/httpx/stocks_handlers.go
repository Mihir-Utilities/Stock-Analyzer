package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/instruments"
	"github.com/india-analyzer/api/internal/pagination"
)

// StockService is the stock list/search/profile surface (B03); *instruments.Service implements it.
type StockService interface {
	Index(ctx context.Context) (instruments.IndexPayload, string, error)
	Search(ctx context.Context, p instruments.SearchParams) (pagination.Page[instruments.StockItem], error)
	Open(ctx context.Context, symbol string) (instruments.ProfileResult, error)
}

// stockHandler returns the B03 handler for a route, or nil when the route is not one of B03's or
// the service is not wired (the route then stays a 501 stub). Kept out of routes.go so parallel
// tasks do not collide there.
func stockHandler(rt route, d Deps) http.Handler {
	if rt.Method != mGet || d.Stocks == nil {
		return nil
	}
	svc := d.Stocks
	switch rt.Path {
	case "/stocks/index":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stocksIndex(svc, w, r) })
	case "/stocks":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stocksSearch(svc, w, r) })
	case "/stocks/{symbol}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stocksProfile(svc, w, r) })
	}
	return nil
}

func stocksIndex(svc StockService, w http.ResponseWriter, r *http.Request) error {
	payload, etag, err := svc.Index(r.Context())
	if err != nil {
		return err
	}
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if etagMatches(r.Header.Get("If-None-Match"), etag) {
		w.WriteHeader(http.StatusNotModified)
		return nil
	}
	WriteData(w, http.StatusOK, payload, WithMeta(NewMeta(time.Now(), "import", false, 0)))
	return nil
}

// etagMatches implements the weak comparison of If-None-Match (a list, or "*").
func etagMatches(header, etag string) bool {
	for _, part := range strings.Split(header, ",") {
		p := strings.TrimPrefix(strings.TrimSpace(part), "W/")
		if p == "*" || p == etag {
			return true
		}
	}
	return false
}

func stocksSearch(svc StockService, w http.ResponseWriter, r *http.Request) error {
	p, err := instruments.ParseSearch(r.URL.Query())
	if err != nil {
		return mapStockError(err)
	}
	page, err := svc.Search(r.Context(), p)
	if err != nil {
		return mapStockError(err)
	}
	WriteData(w, http.StatusOK, page)
	return nil
}

func stocksProfile(svc StockService, w http.ResponseWriter, r *http.Request) error {
	sym := chi.URLParam(r, "symbol")
	// chi hands over the raw (still percent-encoded) segment when the request carries a RawPath
	// (M%26M); decode it once. A malformed escape cannot name an instrument.
	if dec, err := url.PathUnescape(sym); err == nil {
		sym = dec
	} else {
		return ErrNotFound("Instrument not found", map[string]any{"symbol": sym})
	}
	res, err := svc.Open(r.Context(), sym)
	if err != nil {
		if errors.Is(err, instruments.ErrNotFound) {
			return ErrNotFound("Instrument not found", map[string]any{"symbol": sym})
		}
		return err
	}
	if res.RedirectSymbol != "" {
		WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.RedirectSymbol})
		return nil
	}
	p := res.Profile
	asOf := time.Now()
	if p.Freshness.PricesAsOf != nil {
		if t, err := time.Parse(time.DateOnly, *p.Freshness.PricesAsOf); err == nil {
			asOf = t
		}
	}
	WriteData(w, http.StatusOK, p, WithMeta(NewMeta(asOf, "import", res.Stale.Stale, res.Stale.AgeHours)))
	return nil
}

func mapStockError(err error) error {
	var ve *instruments.ValidationError
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, instruments.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	}
	return err
}
