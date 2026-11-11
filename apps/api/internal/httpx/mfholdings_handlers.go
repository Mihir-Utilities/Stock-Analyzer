package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/india-analyzer/api/internal/mfhold"
	"github.com/india-analyzer/api/internal/pagination"
)

// MFHoldingsService is the mutual fund ledger surface (B15, docs/03 12a); *mfhold.Service implements it.
type MFHoldingsService interface {
	ListTxns(ctx context.Context, p mfhold.ListParams) (pagination.Page[mfhold.TxnItem], error)
	CreateTxn(ctx context.Context, in mfhold.TxnInput, key string) (mfhold.TxnResult, error)
	UpdateTxn(ctx context.Context, id int64, in mfhold.TxnInput) (mfhold.TxnResult, error)
	DeleteTxn(ctx context.Context, id int64) error
	Holdings(ctx context.Context, asOf string, includeExited bool, group string) (mfhold.HoldingsResult, error)
	ListMappings(ctx context.Context) ([]mfhold.Mapping, error)
	PutMapping(ctx context.Context, in mfhold.MappingInput) (mfhold.Mapping, error)
}

// mfHoldingsHandler returns the B15 handler for a route, or nil (the route stays a 501 stub).
func mfHoldingsHandler(rt route, d Deps) http.Handler {
	if d.MFHoldings == nil {
		return nil
	}
	svc := d.MFHoldings
	switch rt.Method + " " + rt.Path {
	case "GET /portfolio/mf/txns":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			pg, err := pagination.Parse(r.URL.Query())
			if err != nil {
				return mapMFHError(err)
			}
			q := r.URL.Query()
			page, err := svc.ListTxns(r.Context(), mfhold.ListParams{SchemeCode: q.Get("scheme_code"), Folio: q.Get("folio"),
				Type: q.Get("type"), From: q.Get("from"), To: q.Get("to"), Source: q.Get("source"), Page: pg})
			if err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, page, WithMeta(NewMeta(time.Now(), "owner", false, 0)))
			return nil
		})
	case "POST /portfolio/mf/txns":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			key := r.Header.Get("Idempotency-Key")
			if key != "" && !mfhold.IdempotencyKeyValid(key) {
				return ErrValidation(FieldError{Field: "Idempotency-Key", Message: "must be a UUID"})
			}
			var in mfhold.TxnInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.CreateTxn(r.Context(), in, key)
			if err != nil {
				return mapMFHError(err)
			}
			if res.Replayed {
				w.Header().Set("Idempotent-Replayed", "true")
			}
			WriteData(w, http.StatusCreated, res.Txn, WithWarnings(mfhWarnings(res.Warnings)...))
			return nil
		})
	case "PATCH /portfolio/mf/txns/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			var in mfhold.TxnInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.UpdateTxn(r.Context(), id, in)
			if err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, res.Txn, WithWarnings(mfhWarnings(res.Warnings)...))
			return nil
		})
	case "DELETE /portfolio/mf/txns/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := pfPathID(r)
			if err != nil {
				return err
			}
			if err := svc.DeleteTxn(r.Context(), id); err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"deleted": id, "warnings": []string{}})
			return nil
		})
	case "GET /portfolio/mf/holdings":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			q := r.URL.Query()
			exited := false
			if raw := q.Get("include_exited"); raw != "" {
				var err error
				if exited, err = strconv.ParseBool(raw); err != nil {
					return ErrValidation(FieldError{Field: "include_exited", Message: "must be true or false"})
				}
			}
			res, err := svc.Holdings(r.Context(), q.Get("as_of"), exited, q.Get("group"))
			if err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, res, WithMeta(NewMeta(time.Now(), mfSource, res.Result.Stale, float64(res.Result.StaleAgeDays)*24)),
				WithWarnings(mfhWarnings(res.Result.Warnings)...))
			return nil
		})
	case "GET /portfolio/mf/fund-mappings":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			items, err := svc.ListMappings(r.Context())
			if err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"items": items}, WithMeta(NewMeta(time.Now(), "owner", false, 0)))
			return nil
		})
	case "PUT /portfolio/mf/fund-mappings":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var in mfhold.MappingInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			m, err := svc.PutMapping(r.Context(), in)
			if err != nil {
				return mapMFHError(err)
			}
			WriteData(w, http.StatusOK, m)
			return nil
		})
	}
	return nil
}

func mfhWarnings(ws []mfhold.Warn) []Warning {
	out := make([]Warning, 0, len(ws))
	for _, w := range ws {
		out = append(out, Warning{Code: w.Code, Message: w.Message})
	}
	return out
}

func mapMFHError(err error) error {
	var ve *mfhold.ValidationError
	var nf *mfhold.NotFoundError
	var cf *mfhold.ConflictError
	var ie *mfhold.InsufficientError
	var te *mfhold.TypeUnsupportedError
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.As(err, &te):
		return NewError(http.StatusUnprocessableEntity, "MF_TXN_TYPE_NOT_SUPPORTED", mfhold.TypeUnsupportedMessage, map[string]any{"txn_type": te.Type})
	case errors.As(err, &nf):
		return ErrNotFound(pfCapitalise(nf.What)+" not found", nf.Details)
	case errors.As(err, &cf):
		if cf.Code != "" {
			return NewError(http.StatusConflict, cf.Code, cf.Message, cf.Details)
		}
		return ErrConflict(cf.Message)
	case errors.As(err, &ie):
		return NewError(http.StatusUnprocessableEntity, "INSUFFICIENT_UNITS", "A redemption would exceed the units held on its date in this scheme and folio",
			map[string]any{"transaction_id": ie.TxnID, "date": ie.Date.Format(time.DateOnly), "held_units": ie.Held.StringFixed(4), "redeem_units": ie.Wanted.StringFixed(4)})
	case errors.Is(err, pagination.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	case errors.Is(err, pagination.ErrInvalidLimit):
		return ErrValidation(FieldError{Field: "limit", Message: "must be a positive integer"})
	}
	return err
}
