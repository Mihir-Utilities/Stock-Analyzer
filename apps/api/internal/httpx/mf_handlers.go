package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/mf"
)

// MFService is the mutual fund surface (B10); *mf.Service implements it.
type MFService interface {
	Search(ctx context.Context, p mf.SearchParams) (mf.SearchResult, error)
	Categories(ctx context.Context) ([]string, error)
	Detail(ctx context.Context, code int32) (mf.DetailResult, error)
	NAV(ctx context.Context, code int32, rng string, logScale bool) (mf.NavSeries, mf.Freshness, error)
	SIP(ctx context.Context, code int32, p mf.SIPParams) (mf.SIPResponse, []mf.Warning, mf.Freshness, error)
	Compare(ctx context.Context, codes []int32, rng string) (mf.CompareResponse, []mf.Warning, mf.Freshness, error)
}

const mfSource = "mfapi.in"

// mfHandler returns the B10 handler for a route, or nil when the route is not one of B10's or the
// service is not wired (the route then stays a 501 stub).
func mfHandler(rt route, d Deps) http.Handler {
	if rt.Method != mGet || d.MF == nil {
		return nil
	}
	svc := d.MF
	switch rt.Path {
	case "/mf/schemes":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			p, err := mf.ParseSearch(r.URL.Query())
			if err != nil {
				return mapMFError(err)
			}
			res, err := svc.Search(r.Context(), p)
			if err != nil {
				return mapMFError(err)
			}
			WriteData(w, http.StatusOK, res, mfMeta(res.Freshness))
			return nil
		})
	case "/mf/categories":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			cats, err := svc.Categories(r.Context())
			if err != nil {
				return err
			}
			WriteData(w, http.StatusOK, map[string]any{"items": cats, "attribution": mf.Attribution},
				WithMeta(NewMeta(time.Now(), mfSource, false, 0)))
			return nil
		})
	case "/mf/schemes/{code}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			code, err := mfCode(r)
			if err != nil {
				return err
			}
			res, err := svc.Detail(r.Context(), code)
			if err != nil {
				return mapMFError(err)
			}
			WriteData(w, http.StatusOK, res.Detail, mfMeta(res.Freshness), WithWarnings(mfWarnings(res.Warnings)...))
			return nil
		})
	case "/mf/schemes/{code}/nav":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			code, err := mfCode(r)
			if err != nil {
				return err
			}
			rng, logScale, err := mf.ParseNav(r.URL.Query())
			if err != nil {
				return mapMFError(err)
			}
			res, fr, err := svc.NAV(r.Context(), code, rng, logScale)
			if err != nil {
				return mapMFError(err)
			}
			WriteData(w, http.StatusOK, res, mfMeta(fr))
			return nil
		})
	case "/mf/schemes/{code}/sip":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			code, err := mfCode(r)
			if err != nil {
				return err
			}
			p, err := mf.ParseSIP(r.URL.Query())
			if err != nil {
				return mapMFError(err)
			}
			res, warns, fr, err := svc.SIP(r.Context(), code, p)
			if err != nil {
				return mapMFError(err)
			}
			WriteData(w, http.StatusOK, res, mfMeta(fr), WithWarnings(mfWarnings(warns)...))
			return nil
		})
	case "/mf/compare":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			codes, rng, err := mf.ParseCompare(r.URL.Query())
			if err != nil {
				return mapMFError(err)
			}
			res, warns, fr, err := svc.Compare(r.Context(), codes, rng)
			if err != nil {
				return mapMFError(err)
			}
			WriteData(w, http.StatusOK, res, mfMeta(fr), WithWarnings(mfWarnings(warns)...))
			return nil
		})
	}
	return nil
}

func mfMeta(f mf.Freshness) Option {
	return WithMeta(NewMeta(f.AsOf, mfSource, f.Stale, f.AgeHours))
}

func mfWarnings(ws []mf.Warning) []Warning {
	out := make([]Warning, 0, len(ws))
	for _, w := range ws {
		out = append(out, Warning{Code: w.Code, Message: w.Message})
	}
	return out
}

// mfCode parses the {code} path segment; a non-numeric code cannot name a scheme (404).
func mfCode(r *http.Request) (int32, error) {
	raw := chi.URLParam(r, "code")
	n, err := strconv.ParseInt(raw, 10, 32)
	if err != nil || n < 1 {
		return 0, ErrNotFound("Scheme not found", map[string]any{"code": raw, "suggestions": []any{}})
	}
	return int32(n), nil
}

func mapMFError(err error) error {
	var (
		ve *mf.ValidationError
		nf *mf.NotFoundError
		nd *mf.NoDataError
		nc *mf.NoCommonDatesError
	)
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, mf.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	case errors.As(err, &nf):
		return ErrNotFound("Scheme not found", map[string]any{"code": nf.Code, "suggestions": nf.Suggestions})
	case errors.As(err, &nd):
		return ErrDataUnavailable("no_nav_yet")
	case errors.As(err, &nc):
		return NewError(http.StatusUnprocessableEntity, CodeUnprocessable,
			"The schemes share no NAV date in this range", map[string]any{"reason": "no_common_dates"})
	}
	return err
}
