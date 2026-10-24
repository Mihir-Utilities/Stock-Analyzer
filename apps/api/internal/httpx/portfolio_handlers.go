package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/portfolio"
)

// PortfolioService is the watchlist and portfolio surface (B11); *portfolio.Service implements it.
type PortfolioService interface {
	List(ctx context.Context) (portfolio.Watchlist, bool, error)
	Add(ctx context.Context, in portfolio.WatchAdd) (portfolio.WatchEntry, error)
	PatchNote(ctx context.Context, id int64, note string) (portfolio.WatchEntry, error)
	Remove(ctx context.Context, id int64) error
	ListTxns(ctx context.Context, p portfolio.TxnListParams) (pagination.Page[portfolio.TxnItem], error)
	CreateTxn(ctx context.Context, in portfolio.TxnInput, key string) (portfolio.TxnResult, error)
	UpdateTxn(ctx context.Context, id int64, in portfolio.TxnInput) (portfolio.TxnResult, error)
	DeleteTxn(ctx context.Context, id int64) error
	Summary(ctx context.Context, asOf string, includeExited bool) (portfolio.SummaryResult, error)
	Adjustments(ctx context.Context) (portfolio.AdjustmentList, error)
	CreateAdjustment(ctx context.Context, in portfolio.AdjustmentInput) (portfolio.AdjustmentItem, error)
}

// portfolioSource labels the meta block: owner-entered transactions valued with owner-imported prices.
const portfolioSource = "owner transactions + imported prices"

// portfolioHandler returns the B11 handler for a route, or nil (the route stays a 501 stub).
func portfolioHandler(rt route, d Deps) http.Handler {
	if d.Portfolio == nil {
		return nil
	}
	svc := d.Portfolio
	switch rt.Method + " " + rt.Path {
	case "GET /watchlist":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			res, stale, err := svc.List(r.Context())
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, res, WithMeta(NewMeta(time.Now(), "import", stale, 0)))
			return nil
		})
	case "POST /watchlist":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var in portfolio.WatchAdd
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			e, err := svc.Add(r.Context(), in)
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusCreated, e)
			return nil
		})
	case "PATCH /watchlist/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			var in struct {
				Note *string `json:"note"`
			}
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			if in.Note == nil {
				return ErrValidation(FieldError{Field: "note", Message: "is required"})
			}
			e, err := svc.PatchNote(r.Context(), id, *in.Note)
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, e)
			return nil
		})
	case "DELETE /watchlist/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			if err := svc.Remove(r.Context(), id); err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
			return nil
		})
	case "GET /portfolio/txns":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			pg, err := pagination.Parse(r.URL.Query())
			if err != nil {
				return mapPortfolioError(err)
			}
			page, err := svc.ListTxns(r.Context(), portfolio.TxnListParams{Symbol: r.URL.Query().Get("symbol"), Page: pg})
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, page, WithMeta(NewMeta(time.Now(), "owner", false, 0)))
			return nil
		})
	case "POST /portfolio/txns":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			key := r.Header.Get("Idempotency-Key")
			if key != "" && !portfolio.IdempotencyKeyValid(key) {
				return ErrValidation(FieldError{Field: "Idempotency-Key", Message: "must be a UUID"})
			}
			var in portfolio.TxnInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.CreateTxn(r.Context(), in, key)
			if err != nil {
				return mapPortfolioError(err)
			}
			if res.Replayed {
				w.Header().Set("Idempotent-Replayed", "true")
			}
			WriteData(w, http.StatusCreated, res.Txn, WithWarnings(pfWarnings(res.Warnings)...))
			return nil
		})
	case "PATCH /portfolio/txns/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			var in portfolio.TxnInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.UpdateTxn(r.Context(), id, in)
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, res.Txn, WithWarnings(pfWarnings(res.Warnings)...))
			return nil
		})
	case "DELETE /portfolio/txns/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			if err := svc.DeleteTxn(r.Context(), id); err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
			return nil
		})
	case "GET /portfolio/summary":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			q := r.URL.Query()
			var err error
			exited := false
			if raw := q.Get("include_exited"); raw != "" {
				if exited, err = strconv.ParseBool(raw); err != nil {
					return ErrValidation(FieldError{Field: "include_exited", Message: "must be true or false"})
				}
			}
			res, err := svc.Summary(r.Context(), q.Get("as_of"), exited)
			if err != nil {
				return mapPortfolioError(err)
			}
			s := res.Summary
			WriteData(w, http.StatusOK, s, WithMeta(NewMeta(time.Now(), portfolioSource, s.Stale, s.StaleAgeHours)),
				WithWarnings(pfWarnings(s.Warnings)...))
			return nil
		})
	case "GET /portfolio/adjustments":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			res, err := svc.Adjustments(r.Context())
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusOK, res, WithMeta(NewMeta(time.Now(), "import", false, 0)))
			return nil
		})
	case "POST /portfolio/adjustments":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var in portfolio.AdjustmentInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.CreateAdjustment(r.Context(), in)
			if err != nil {
				return mapPortfolioError(err)
			}
			WriteData(w, http.StatusCreated, res)
			return nil
		})
	}
	return nil
}

func pfWarnings(ws []portfolio.Warn) []Warning {
	out := make([]Warning, 0, len(ws))
	for _, w := range ws {
		out = append(out, Warning{Code: w.Code, Message: w.Message})
	}
	return out
}

// pathID parses the numeric {id}; a non-numeric id cannot name a row (404).
func pfPathID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "id")
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 {
		return 0, ErrNotFound("Not found", map[string]any{"id": raw})
	}
	return n, nil
}

func mapPortfolioError(err error) error {
	var ve *portfolio.ValidationError
	var nf *portfolio.NotFoundError
	var cf *portfolio.ConflictError
	var ie *portfolio.InsufficientError
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.As(err, &nf):
		return ErrNotFound(pfCapitalise(nf.What)+" not found", nf.Details)
	case errors.As(err, &cf):
		return ErrConflict(cf.Message)
	case errors.As(err, &ie):
		return NewError(http.StatusUnprocessableEntity, "INSUFFICIENT_HOLDINGS",
			"A sell would exceed the quantity held on its date", map[string]any{
				"transaction_id": ie.TxnID, "date": ie.Date.Format(time.DateOnly),
				"held_qty": ie.Held.StringFixed(4), "sell_qty": ie.Wanted.StringFixed(4)})
	case errors.Is(err, pagination.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	case errors.Is(err, pagination.ErrInvalidLimit):
		return ErrValidation(FieldError{Field: "limit", Message: "must be a positive integer"})
	}
	return err
}

func pfCapitalise(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
