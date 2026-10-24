package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/actions"
	"github.com/india-analyzer/api/internal/importers"
)

// ActionService is the B07 use-case surface; *actions.Service implements it.
type ActionService interface {
	Patch(ctx context.Context, symbol string, id int64, in actions.Patch) (*actions.Result, error)
}

// actionsHandler serves PATCH /stocks/{symbol}/actions/{id}; nil keeps the 501 stub.
func actionsHandler(rt route, d Deps) http.Handler {
	if d.Actions == nil || rt.Method+" "+rt.Path != "PATCH /stocks/{symbol}/actions/{id}" {
		return nil
	}
	svc := d.Actions
	return Adapt(func(w http.ResponseWriter, r *http.Request) error {
		sym, err := symbolParam(r)
		if err != nil {
			return err
		}
		raw := chi.URLParam(r, "id")
		id, perr := strconv.ParseInt(raw, 10, 64)
		if perr != nil || id < 1 {
			return ErrNotFound("Corporate action not found", nil)
		}
		var b struct {
			Status     string `json:"status"`
			ActionType string `json:"action_type"`
			RatioNum   cell   `json:"ratio_num"`
			RatioDen   cell   `json:"ratio_den"`
		}
		if err := DecodeJSON(r, &b); err != nil {
			return err
		}
		res, err := svc.Patch(r.Context(), sym, id, actions.Patch{Status: b.Status, ActionType: b.ActionType,
			RatioNum: string(b.RatioNum), RatioDen: string(b.RatioDen)})
		if err != nil {
			return mapActionError(err)
		}
		WriteData(w, http.StatusOK, res)
		return nil
	})
}

func mapActionError(err error) error {
	var nf *actions.NotFoundError
	var cf *actions.ConflictError
	var ve *importers.ValidationError
	switch {
	case errors.As(err, &nf):
		return ErrNotFound("Corporate action not found", nil)
	case errors.As(err, &cf):
		return ErrConflict(cf.Message)
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			name := f.Field
			if name == "type" {
				name = "action_type" // the body names it action_type; the CSV validator calls it type
			}
			fields = append(fields, FieldError{Field: name, Message: f.Message})
		}
		return ErrValidation(fields...)
	}
	return err
}
