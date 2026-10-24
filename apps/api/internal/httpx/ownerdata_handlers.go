package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/url"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/ownerdata"
)

// OwnerDataService is the read surface of owner-entered fundamentals, shareholding, events and
// research links (B05); *ownerdata.Service implements it.
type OwnerDataService interface {
	Fundamentals(ctx context.Context, symbol, basis, period string) (ownerdata.Result, error)
	Shareholding(ctx context.Context, symbol string) (ownerdata.Result, error)
	Events(ctx context.Context, symbol, from, to string) (ownerdata.Result, error)
	Links(ctx context.Context, symbol string) (ownerdata.Result, error)
}

// ownerDataHandler returns the B05 handler for a route, or nil when the route is not one of B05's
// or the service is not wired (the route then stays a 501 stub).
func ownerDataHandler(rt route, d Deps) http.Handler {
	if rt.Method != mGet || d.OwnerData == nil {
		return nil
	}
	svc := d.OwnerData
	run := func(call func(r *http.Request, symbol string) (ownerdata.Result, error)) http.Handler {
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			sym := chi.URLParam(r, "symbol")
			if dec, err := url.PathUnescape(sym); err == nil {
				sym = dec
			} else {
				return ErrNotFound("Instrument not found", map[string]any{"symbol": sym})
			}
			res, err := call(r, sym)
			if err != nil {
				return mapOwnerDataError(err, sym)
			}
			writeOwnerData(w, res)
			return nil
		})
	}
	switch rt.Path {
	case "/stocks/{symbol}/fundamentals":
		return run(func(r *http.Request, s string) (ownerdata.Result, error) {
			q := r.URL.Query()
			return svc.Fundamentals(r.Context(), s, q.Get("basis"), q.Get("period"))
		})
	case "/stocks/{symbol}/shareholding":
		return run(func(r *http.Request, s string) (ownerdata.Result, error) { return svc.Shareholding(r.Context(), s) })
	case "/stocks/{symbol}/events":
		return run(func(r *http.Request, s string) (ownerdata.Result, error) {
			q := r.URL.Query()
			return svc.Events(r.Context(), s, q.Get("from"), q.Get("to"))
		})
	case "/stocks/{symbol}/links":
		return run(func(r *http.Request, s string) (ownerdata.Result, error) { return svc.Links(r.Context(), s) })
	}
	return nil
}

func writeOwnerData(w http.ResponseWriter, res ownerdata.Result) {
	if res.Redirect != "" {
		WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.Redirect})
		return
	}
	opts := []Option{WithMeta(NewMeta(res.AsOf, res.Source, res.Stale, res.StaleAgeHours))}
	if len(res.Warnings) > 0 {
		ws := make([]Warning, 0, len(res.Warnings))
		for _, x := range res.Warnings {
			ws = append(ws, Warning{Code: x.Code, Message: x.Message})
		}
		opts = append(opts, WithWarnings(ws...))
	}
	WriteData(w, http.StatusOK, res.Data, opts...)
}

func mapOwnerDataError(err error, symbol string) error {
	var ve *ownerdata.ValidationError
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, ownerdata.ErrNotFound):
		return ErrNotFound("Instrument not found", map[string]any{"symbol": symbol})
	}
	return err
}
