package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/journal"
	"github.com/india-analyzer/api/internal/pagination"
)

// JournalService is the decision-journal surface (B20); *journal.Service implements it.
type JournalService interface {
	List(ctx context.Context, symbol, status string, p pagination.Params) (journal.Page, error)
	Create(ctx context.Context, symbol string, in journal.CreateInput, key string) (journal.Result, error)
	Update(ctx context.Context, id int64, in journal.PatchInput) (journal.Item, error)
	Delete(ctx context.Context, id int64) error
}

// journalSource labels the meta block: the owner's own notes.
const journalSource = "owner journal"

// journalHandler returns the B20 handler for a route, or nil (the route stays a 501 stub).
func journalHandler(rt route, d Deps) http.Handler {
	if d.Journal == nil {
		return nil
	}
	svc := d.Journal
	switch rt.Method + " " + rt.Path {
	case "GET /stocks/{symbol}/journal":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			sym, err := symbolParam(r)
			if err != nil {
				return err
			}
			pg, err := pagination.Parse(r.URL.Query())
			if err != nil {
				return mapJournalError(err)
			}
			page, err := svc.List(r.Context(), sym, r.URL.Query().Get("status"), pg)
			if err != nil {
				return mapJournalError(err)
			}
			WriteData(w, http.StatusOK, page, WithMeta(NewMeta(time.Now(), journalSource, false, 0)))
			return nil
		})
	case "POST /stocks/{symbol}/journal":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			sym, err := symbolParam(r)
			if err != nil {
				return err
			}
			key := r.Header.Get("Idempotency-Key")
			if key != "" && !journal.IdempotencyKeyValid(key) {
				return ErrValidation(FieldError{Field: "Idempotency-Key", Message: "must be a UUID"})
			}
			var in journal.CreateInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			res, err := svc.Create(r.Context(), sym, in, key)
			if err != nil {
				return mapJournalError(err)
			}
			if res.Replayed {
				w.Header().Set("Idempotent-Replayed", "true")
			}
			WriteData(w, http.StatusCreated, res.Item, WithMeta(NewMeta(time.Now(), journalSource, false, 0)))
			return nil
		})
	case "PATCH /journal/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := journalID(r)
			if err != nil {
				return err
			}
			var in journal.PatchInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			it, err := svc.Update(r.Context(), id, in)
			if err != nil {
				return mapJournalError(err)
			}
			WriteData(w, http.StatusOK, it, WithMeta(NewMeta(time.Now(), journalSource, false, 0)))
			return nil
		})
	case "DELETE /journal/{id}":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := journalID(r)
			if err != nil {
				return err
			}
			if err := svc.Delete(r.Context(), id); err != nil {
				return mapJournalError(err)
			}
			WriteData(w, http.StatusOK, map[string]any{"id": id, "deleted": true})
			return nil
		})
	}
	return nil
}

// journalID parses the numeric {id}; a non-numeric id cannot name a row (404).
func journalID(r *http.Request) (int64, error) {
	raw := chi.URLParam(r, "id")
	n, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || n < 1 {
		return 0, ErrNotFound("Journal note not found", map[string]any{"id": raw})
	}
	return n, nil
}

func mapJournalError(err error) error {
	var ve *journal.ValidationError
	var nf *journal.NotFoundError
	var cf *journal.ConflictError
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
	case errors.Is(err, pagination.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	case errors.Is(err, pagination.ErrInvalidLimit):
		return ErrValidation(FieldError{Field: "limit", Message: "must be a positive integer"})
	}
	return err
}
