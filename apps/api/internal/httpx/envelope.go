// Package httpx holds the HTTP plumbing of the API: envelopes, error mapping, middleware, rate
// limiting and the router (docs/03-api-spec.md sections 1, 15, 16).
package httpx

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/rs/zerolog"
)

// Warning is one entry of the response-level `warnings[]`.
type Warning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Meta is the optional `meta` object: as_of, source, stale, stale_age_hours and endpoint-specific
// keys (interval, excluded_for_missing, ...).
type Meta map[string]any

// NewMeta builds the standard meta block. asOf is formatted RFC 3339 UTC.
func NewMeta(asOf time.Time, source string, stale bool, staleAgeHours float64) Meta {
	return Meta{
		"as_of":           asOf.UTC().Format(time.RFC3339),
		"source":          source,
		"stale":           stale,
		"stale_age_hours": staleAgeHours,
	}
}

type successEnvelope struct {
	Data     any       `json:"data"`
	Meta     Meta      `json:"meta,omitempty"`
	Warnings []Warning `json:"warnings,omitempty"`
}

// Option customises a success response.
type Option func(*successEnvelope)

// WithMeta adds the `meta` object.
func WithMeta(m Meta) Option { return func(e *successEnvelope) { e.Meta = m } }

// WithWarnings adds `warnings[]`.
func WithWarnings(w ...Warning) Option { return func(e *successEnvelope) { e.Warnings = w } }

// WriteData writes `{"data":..., "meta":..., "warnings":[...]}` with the given status.
func WriteData(w http.ResponseWriter, status int, data any, opts ...Option) {
	env := successEnvelope{Data: data}
	for _, o := range opts {
		o(&env)
	}
	writeJSON(w, status, env)
}

type errorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

// FieldError is one entry of `details.fields[]` for 422 responses.
type FieldError struct {
	Field   string `json:"field"`
	Message string `json:"message"`
}

// AppError is an error that maps directly onto the error envelope.
type AppError struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
	// Header values to send with the response (for example Retry-After).
	Headers map[string]string
}

func (e *AppError) Error() string { return e.Code + ": " + e.Message }

// NewError builds an AppError with an arbitrary status and code (for task-specific codes such as
// PRICE_MODE_MANUAL or INSUFFICIENT_HOLDINGS).
func NewError(status int, code, message string, details map[string]any) *AppError {
	return &AppError{Status: status, Code: code, Message: message, Details: details}
}

// Standard codes of docs/03-api-spec.md section 1.
const (
	CodeBadRequest      = "BAD_REQUEST"
	CodeUnauthenticated = "UNAUTHENTICATED"
	CodeForbidden       = "FORBIDDEN"
	CodeNotFound        = "NOT_FOUND"
	CodeConflict        = "CONFLICT"
	CodeUnprocessable   = "UNPROCESSABLE"
	CodeRateLimited     = "RATE_LIMITED"
	CodeDataUnavailable = "DATA_UNAVAILABLE"
	CodeSourceDown      = "SOURCE_DOWN"
	CodeInternal        = "INTERNAL"
	// CodeNotImplemented marks the B01 stubs (501).
	CodeNotImplemented = "NOT_IMPLEMENTED"
)

func ErrBadRequest(msg string) *AppError {
	return NewError(http.StatusBadRequest, CodeBadRequest, msg, nil)
}

func ErrUnauthenticated(msg string) *AppError {
	return NewError(http.StatusUnauthorized, CodeUnauthenticated, msg, nil)
}

func ErrForbidden(msg string) *AppError {
	return NewError(http.StatusForbidden, CodeForbidden, msg, nil)
}

func ErrNotFound(msg string, details map[string]any) *AppError {
	return NewError(http.StatusNotFound, CodeNotFound, msg, details)
}

func ErrConflict(msg string) *AppError {
	return NewError(http.StatusConflict, CodeConflict, msg, nil)
}

// ErrValidation is the 422 with `details.fields[]`.
func ErrValidation(fields ...FieldError) *AppError {
	if fields == nil {
		fields = []FieldError{}
	}
	return NewError(http.StatusUnprocessableEntity, CodeUnprocessable, "Validation failed", map[string]any{"fields": fields})
}

// ErrRateLimited is the 429 with Retry-After (seconds, at least 1) and details.retry_after_seconds.
func ErrRateLimited(retryAfterSeconds int) *AppError {
	if retryAfterSeconds < 1 {
		retryAfterSeconds = 1
	}
	e := NewError(http.StatusTooManyRequests, CodeRateLimited, "Too many requests",
		map[string]any{"retry_after_seconds": retryAfterSeconds})
	e.Headers = map[string]string{"Retry-After": strconv.Itoa(retryAfterSeconds)}
	return e
}

// ErrDataUnavailable is the 404 for a valid target without data yet.
func ErrDataUnavailable(reason string) *AppError {
	return NewError(http.StatusNotFound, CodeDataUnavailable, "Data not available", map[string]any{"reason": reason})
}

func ErrSourceDown(msg string) *AppError {
	return NewError(http.StatusServiceUnavailable, CodeSourceDown, msg, nil)
}

func ErrInternal() *AppError {
	return NewError(http.StatusInternalServerError, CodeInternal, "Internal error", nil)
}

// WriteError writes the error envelope. Anything that is not an *AppError becomes a generic
// INTERNAL 500 (the cause is logged with the request id, never sent to the client).
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	var app *AppError
	if !errors.As(err, &app) {
		app = ErrInternal()
		if errors.Is(err, context.DeadlineExceeded) {
			app.Message = "Request timed out"
		}
		if r != nil {
			zerolog.Ctx(r.Context()).Error().Err(err).Msg("unhandled error")
		}
	}
	for k, v := range app.Headers {
		w.Header().Set(k, v)
	}
	writeJSON(w, app.Status, errorEnvelope{Error: errorBody{Code: app.Code, Message: app.Message, Details: app.Details}})
}

// HandlerFunc is a handler that returns an error; Adapt maps it to the envelope.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Adapt turns a HandlerFunc into an http.HandlerFunc.
func Adapt(h HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h(w, r); err != nil {
			WriteError(w, r, err)
		}
	}
}

// DecodeJSON strictly decodes a single JSON value (unknown fields rejected, trailing data rejected).
// Errors are *AppError values: 400 for malformed JSON, 413-style size errors are produced by MaxBody.
func DecodeJSON(r *http.Request, dst any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errBodyTooLarge()
		}
		return ErrBadRequest("Request body is not valid JSON for this endpoint")
	}
	if dec.More() {
		return ErrBadRequest("Request body must contain a single JSON value")
	}
	return nil
}

func errBodyTooLarge() *AppError {
	return NewError(http.StatusRequestEntityTooLarge, CodeBadRequest, "Request body too large", nil)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		status = http.StatusInternalServerError
		buf.Reset()
		buf.WriteString(`{"error":{"code":"INTERNAL","message":"Internal error"}}` + "\n")
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf.Bytes())
}
