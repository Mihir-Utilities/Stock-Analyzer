package httpx

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/importers"
	"github.com/india-analyzer/api/internal/pagination"
)

// ImportService is the owner-data import surface (B06a); *importers.Service implements it.
type ImportService interface {
	Limits(kind string) importers.Limits
	Validate(ctx context.Context, kind string, content []byte, group string) (*importers.ValidateResult, error)
	Commit(ctx context.Context, kind string, req importers.CommitRequest) (*importers.CommitResult, error)
	PricesAdjustment(ctx context.Context) (importers.AdjustmentSetting, error)
	SetPricesAdjustment(ctx context.Context, value, confirm bool) (importers.AdjustmentSetting, error)
	AdjustmentCheck(ctx context.Context, req importers.AdjustmentCheckRequest) (*importers.AdjustmentCheckResult, error)
	AddInstrument(ctx context.Context, in importers.InstrumentFields) (*importers.AddResult, error)
	DeletePreview(ctx context.Context, symbol, from, to string) (int, error)
	DeletePrices(ctx context.Context, symbol, from, to string, confirm bool) (*importers.DeleteResult, error)
	TrimPreviewFor(ctx context.Context, symbols []string, before string) (*importers.TrimPreview, error)
	Trim(ctx context.Context, symbols []string, before string, confirm bool) (*importers.TrimResult, error)
	ListBatches(ctx context.Context, limit int, beforeID int64) ([]importers.Batch, error)
	Undo(ctx context.Context, id int64) error
}

// importsHandler returns the B06a handler for a route, or nil when the route is not one of B06a's or
// the service is not wired (the route then stays a 501 stub). Kept out of routes.go so parallel
// tasks do not collide there.
func importsHandler(rt route, d Deps) http.Handler {
	if d.Imports == nil {
		return nil
	}
	svc := d.Imports
	wrap := func(f func(ImportService, http.ResponseWriter, *http.Request) error) http.Handler {
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			return mapImportError(f(svc, w, r))
		})
	}
	switch rt.Method + " " + rt.Path {
	case "POST /imports/{kind}/validate":
		return wrap(importValidate)
	case "POST /imports/{kind}/commit":
		return wrap(importCommit)
	case "GET /imports/batches":
		return wrap(importBatches)
	case "POST /imports/batches/{id}/undo":
		return wrap(importUndo)
	case "GET /imports/templates/{kind}":
		return wrap(importTemplate)
	case "GET /settings/prices-adjustment":
		return wrap(adjustmentGet)
	case "PUT /settings/prices-adjustment":
		return wrap(adjustmentPut)
	case "POST /imports/prices/adjustment-check":
		return wrap(adjustmentCheck)
	case "POST /instruments":
		return wrap(instrumentCreate)
	case "DELETE /stocks/{symbol}/prices":
		return wrap(pricesDelete)
	case "POST /stocks/{symbol}/prices/delete-preview":
		return wrap(pricesDeletePreview)
	case "POST /prices/trim":
		return wrap(pricesTrim)
	case "POST /prices/trim/preview":
		return wrap(pricesTrimPreview)
	}
	return nil
}

// mapImportError converts importer errors to the envelope of docs/03 section 1.
func mapImportError(err error) error {
	if err == nil {
		return nil
	}
	var (
		app  *AppError
		he   *importers.HasErrorsError
		sl   *importers.SizeLimitError
		uc   *importers.UploadCapError
		ve   *importers.ValidationError
		mbe  *http.MaxBytesError
		file = func(msg string) error { return ErrValidation(FieldError{Field: "file", Message: msg}) }
	)
	switch {
	case errors.As(err, &app):
		return app
	case errors.As(err, &mbe), errors.Is(err, importers.ErrTooLarge):
		return NewError(http.StatusRequestEntityTooLarge, CodeBadRequest, "The file is too large for this import kind", nil)
	case errors.Is(err, importers.ErrUploadNotFound):
		return ErrNotFound("Upload not found or expired; validate the file again", nil)
	case errors.Is(err, importers.ErrKindNotBuilt):
		return NewError(http.StatusNotImplemented, CodeNotImplemented, "Not implemented yet", nil)
	case errors.Is(err, importers.ErrAdjustmentUnset):
		return NewError(http.StatusUnprocessableEntity, "PRICES_ADJUSTMENT_UNSET",
			"Choose whether your prices are raw or already adjusted for splits and bonuses before importing", nil)
	case errors.As(err, &he):
		return NewError(http.StatusUnprocessableEntity, CodeUnprocessable,
			fmt.Sprintf("The upload has %d error(s); fix the file and upload it again", he.Count), map[string]any{"error_count": he.Count})
	case errors.As(err, &sl):
		return NewError(http.StatusUnprocessableEntity, "DB_SIZE_LIMIT", sl.Error(),
			map[string]any{"limit_mb": sl.LimitMB, "current_mb": sl.CurrentMB, "estimated_growth_mb": sl.GrowthMB})
	case errors.As(err, &uc):
		return ErrRateLimited(uc.RetryAfterSeconds)
	case errors.Is(err, importers.ErrTooManyRows):
		return file("The file has more rows than this import kind allows")
	case errors.Is(err, importers.ErrNotText):
		return file(strings.TrimPrefix(err.Error(), "importers: file is not UTF-8 text: "))
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, importers.ErrConflict):
		return ErrConflict("Already exists or already done")
	case errors.Is(err, importers.ErrSymbolNotFound):
		return ErrNotFound("Instrument not found", nil)
	case errors.Is(err, importers.ErrBatchNotFound):
		return ErrNotFound("Import batch not found", nil)
	case errors.Is(err, importers.ErrNotUndoable):
		return ErrConflict("Price and instrument imports cannot be undone; import corrected data instead")
	case errors.Is(err, importers.ErrConfirmChange):
		return ErrValidation(FieldError{Field: "confirm", Message: "changing the raw/adjusted choice needs confirm=true; stored bars keep the value they were imported with, and mixing raw and adjusted files for one stock is an owner error"})
	}
	return err
}

func importKind(r *http.Request) (string, error) {
	kind := chi.URLParam(r, "kind")
	if !importers.KnownKind(kind) {
		return "", ErrNotFound("Unknown import kind", map[string]any{"kind": kind})
	}
	return kind, nil
}

// allowed content types of an uploaded CSV; the file name must end in .csv or .txt (SEC-05).
var csvTypes = map[string]bool{"": true, "text/csv": true, "application/csv": true, "text/plain": true,
	"application/vnd.ms-excel": true, "application/octet-stream": true}

func importValidate(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	kind, err := importKind(r)
	if err != nil {
		return err
	}
	if !importers.Implemented(kind) {
		return importers.ErrKindNotBuilt
	}
	mr, err := r.MultipartReader()
	if err != nil {
		return ErrBadRequest("Send the file as multipart/form-data in a field named file")
	}
	lim := svc.Limits(kind)
	var content []byte
	var group string
	found := false
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				return err
			}
			return ErrBadRequest("The upload could not be read as multipart/form-data")
		}
		switch part.FormName() {
		case "upload_group":
			b, _ := io.ReadAll(io.LimitReader(part, 64))
			group = strings.TrimSpace(string(b))
		case "file":
			if found {
				return ErrBadRequest("Send exactly one file")
			}
			mt, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
			ext := strings.ToLower(path.Ext(part.FileName()))
			if !csvTypes[strings.ToLower(mt)] || (ext != ".csv" && ext != ".txt") {
				return ErrValidation(FieldError{Field: "file", Message: "only CSV files (.csv, UTF-8 text) are accepted"})
			}
			content, err = io.ReadAll(io.LimitReader(part, lim.MaxBytes+1))
			if err != nil {
				return err // *http.MaxBytesError becomes 413
			}
			if int64(len(content)) > lim.MaxBytes {
				return importers.ErrTooLarge
			}
			found = true
		}
	}
	if !found {
		return ErrValidation(FieldError{Field: "file", Message: "a file is required"})
	}
	res, err := svc.Validate(r.Context(), kind, content, group)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}

type commitBody struct {
	UploadID    string   `json:"upload_id"`
	UploadIDs   []string `json:"upload_ids"`
	UploadGroup string   `json:"upload_group"`
	Note        string   `json:"note"`
}

func importCommit(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	kind, err := importKind(r)
	if err != nil {
		return err
	}
	var b commitBody
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	ids := b.UploadIDs
	if b.UploadID != "" {
		if len(ids) > 0 {
			return ErrValidation(FieldError{Field: "upload_id", Message: "give either upload_id or upload_ids, not both"})
		}
		ids = []string{b.UploadID}
	}
	res, err := svc.Commit(r.Context(), kind, importers.CommitRequest{UploadIDs: ids, UploadGroup: b.UploadGroup, Note: b.Note})
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}

func importBatches(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	p, err := pagination.Parse(r.URL.Query())
	if err != nil {
		field := "limit"
		if errors.Is(err, pagination.ErrInvalidCursor) {
			field = "cursor"
		}
		return ErrValidation(FieldError{Field: field, Message: err.Error()})
	}
	var before int64
	if p.Cursor != "" {
		var keys [1]int64
		if err := pagination.Decode(p.Cursor, &keys); err != nil || keys[0] < 1 {
			return ErrValidation(FieldError{Field: "cursor", Message: "is not a valid cursor"})
		}
		before = keys[0]
	}
	rows, err := svc.ListBatches(r.Context(), p.Limit, before)
	if err != nil {
		return err
	}
	page, err := pagination.NewPage(rows, p.Limit, func(last importers.Batch) (string, error) { return pagination.Encode(last.ID) })
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, page)
	return nil
}

func importUndo(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		return ErrValidation(FieldError{Field: "id", Message: "must be a positive integer"})
	}
	return svc.Undo(r.Context(), id)
}

func importTemplate(_ ImportService, w http.ResponseWriter, r *http.Request) error {
	kind, err := importKind(r)
	if err != nil {
		return err
	}
	content, name, err := importers.Template(kind)
	if err != nil {
		return err
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(content) //nolint:gosec // constant CSV template text, served as an attachment
	return nil
}

func adjustmentGet(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	s, err := svc.PricesAdjustment(r.Context())
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, s)
	return nil
}

func adjustmentPut(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	var b struct {
		Value   *bool `json:"value"`
		Confirm bool  `json:"confirm"`
	}
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	if b.Value == nil {
		return ErrValidation(FieldError{Field: "value", Message: "is required (true = already adjusted, false = raw)"})
	}
	s, err := svc.SetPricesAdjustment(r.Context(), *b.Value, b.Confirm)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, s)
	return nil
}

func adjustmentCheck(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	var b struct {
		UploadID      string `json:"upload_id"`
		Symbol        string `json:"symbol"`
		ExDate        string `json:"ex_date"`
		ExpectedRatio *struct {
			Num *int64 `json:"num"`
			Den *int64 `json:"den"`
		} `json:"expected_ratio"`
	}
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	req := importers.AdjustmentCheckRequest{UploadID: b.UploadID, Symbol: b.Symbol, ExDate: b.ExDate}
	if b.ExpectedRatio != nil {
		if b.ExpectedRatio.Num == nil || b.ExpectedRatio.Den == nil {
			return ErrValidation(FieldError{Field: "expected_ratio", Message: "num and den are both required"})
		}
		req.ExpectedNum, req.ExpectedDen = b.ExpectedRatio.Num, b.ExpectedRatio.Den
	}
	res, err := svc.AdjustmentCheck(r.Context(), req)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}

func instrumentCreate(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	var b struct {
		Symbol string `json:"symbol"`
		Name   string `json:"name"`
		ISIN   string `json:"isin"`
	}
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	res, err := svc.AddInstrument(r.Context(), importers.InstrumentFields{Symbol: b.Symbol, Name: b.Name, ISIN: b.ISIN})
	if errors.Is(err, importers.ErrConflict) {
		return ErrConflict("This symbol already exists; use instruments.csv to update it")
	}
	if err != nil {
		return err
	}
	WriteData(w, http.StatusCreated, res)
	return nil
}

func symbolParam(r *http.Request) (string, error) {
	sym, err := url.PathUnescape(chi.URLParam(r, "symbol"))
	if err != nil {
		return "", ErrNotFound("Instrument not found", nil)
	}
	return sym, nil
}

func pricesDeletePreview(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	sym, err := symbolParam(r)
	if err != nil {
		return err
	}
	q := r.URL.Query()
	n, err := svc.DeletePreview(r.Context(), sym, q.Get("from"), q.Get("to"))
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, map[string]any{"rows": n})
	return nil
}

type confirmBody struct {
	Confirm bool `json:"confirm"`
}

func pricesDelete(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	sym, err := symbolParam(r)
	if err != nil {
		return err
	}
	var b confirmBody
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	q := r.URL.Query()
	res, err := svc.DeletePrices(r.Context(), sym, q.Get("from"), q.Get("to"), b.Confirm)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}

type trimBody struct {
	Symbols []string `json:"symbols"`
	Before  string   `json:"before"`
	Confirm bool     `json:"confirm"`
}

func pricesTrimPreview(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	var b struct {
		Symbols []string `json:"symbols"`
		Before  string   `json:"before"`
	}
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	res, err := svc.TrimPreviewFor(r.Context(), b.Symbols, b.Before)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}

func pricesTrim(svc ImportService, w http.ResponseWriter, r *http.Request) error {
	var b trimBody
	if err := DecodeJSON(r, &b); err != nil {
		return err
	}
	res, err := svc.Trim(r.Context(), b.Symbols, b.Before, b.Confirm)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res)
	return nil
}
