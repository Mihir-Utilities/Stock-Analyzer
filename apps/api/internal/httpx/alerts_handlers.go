package httpx

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strconv"
	"sync/atomic"

	"github.com/go-chi/chi/v5"
	"github.com/rs/zerolog"

	"github.com/india-analyzer/api/internal/alerts"
	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/telegram"
)

// Handler kinds of the alerts and Telegram routes (docs/03 section 13). They live here, away from
// the shared const block of routes.go, so parallel branches merge cleanly.
const (
	kindAlertCreate handlerKind = 100 + iota
	kindAlertList
	kindAlertEvents
	kindAlertPatch
	kindAlertDelete
	kindTgLinkCode
	kindTgUnlink
	kindTgTest
	kindTgWebhook
)

// WebhookSecretHeader carries the secret set with setWebhook (docs/01 section 6).
const WebhookSecretHeader = "X-Telegram-Bot-Api-Secret-Token" //nolint:gosec // header name, not a credential

// WebhookBodyLimit bounds a webhook update (Telegram updates are a few kB).
const WebhookBodyLimit int64 = 64 << 10

// AlertService is the use-case surface of the alert and Telegram handlers; *alerts.Service implements it.
type AlertService interface {
	Create(ctx context.Context, in alerts.CreateInput) (alerts.Alert, error)
	List(ctx context.Context, status string, p pagination.Params) (alerts.Page[alerts.Alert], error)
	Events(ctx context.Context, p pagination.Params) (alerts.Page[alerts.Event], error)
	Patch(ctx context.Context, id int64, in alerts.PatchInput) (alerts.Alert, error)
	Delete(ctx context.Context, id int64) error
	NewLinkCode(ctx context.Context) (alerts.LinkCode, error)
	Unlink(ctx context.Context) error
	SendTest(ctx context.Context) error
	LinkChat(ctx context.Context, chatID int64, code string) (bool, error)
}

// AlertsDeps wires the alert routes. With Svc nil they answer 501 NOT_IMPLEMENTED. WebhookSecret
// is TELEGRAM_WEBHOOK_SECRET; while it is empty the webhook refuses every request (fail closed).
type AlertsDeps struct {
	Svc           AlertService
	WebhookSecret string
	BotUsername   string
}

// alertsHandler returns the handler for an alerts/Telegram kind, or nil for any other kind.
func alertsHandler(d Deps, k handlerKind) http.Handler {
	if k < kindAlertCreate || k > kindTgWebhook {
		return nil
	}
	svc := d.Alerts.Svc
	if svc == nil {
		return Adapt(func(http.ResponseWriter, *http.Request) error { return notImplemented() })
	}
	switch k {
	case kindAlertCreate:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			var in alerts.CreateInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			a, err := svc.Create(r.Context(), in)
			if err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusCreated, a)
			return nil
		})
	case kindAlertList:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			p, err := pageParams(r)
			if err != nil {
				return err
			}
			page, err := svc.List(r.Context(), r.URL.Query().Get("status"), p)
			if err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, page)
			return nil
		})
	case kindAlertEvents:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			p, err := pageParams(r)
			if err != nil {
				return err
			}
			page, err := svc.Events(r.Context(), p)
			if err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, page)
			return nil
		})
	case kindAlertPatch:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := alertID(r)
			if err != nil {
				return err
			}
			var in alerts.PatchInput
			if err := DecodeJSON(r, &in); err != nil {
				return err
			}
			a, err := svc.Patch(r.Context(), id, in)
			if err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, a)
			return nil
		})
	case kindAlertDelete:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			id, err := alertID(r)
			if err != nil {
				return err
			}
			if err := svc.Delete(r.Context(), id); err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	case kindTgLinkCode:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			lc, err := svc.NewLinkCode(r.Context())
			if err != nil {
				return mapAlertError(err)
			}
			var opts []Option
			if lc.BotUsername == nil {
				opts = append(opts, WithWarnings(Warning{Code: "BOT_NOT_CONFIGURED",
					Message: "TELEGRAM_BOT_USERNAME is not set; open your bot in Telegram and send /start with the code"}))
			}
			WriteData(w, http.StatusOK, lc, opts...)
			return nil
		})
	case kindTgUnlink:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			if err := svc.Unlink(r.Context()); err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	case kindTgTest:
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			if err := svc.SendTest(r.Context()); err != nil {
				return mapAlertError(err)
			}
			WriteData(w, http.StatusOK, map[string]bool{"ok": true})
			return nil
		})
	default: // kindTgWebhook
		var rejected atomic.Int64
		return Adapt(func(w http.ResponseWriter, r *http.Request) error {
			return telegramWebhook(d.Alerts, &rejected, w, r)
		})
	}
}

// telegramWebhook authenticates with the secret header (constant-time, fail closed), then handles
// `/start <code>` in a private chat and nothing else: every other update is acknowledged and
// ignored. Nothing is stored for a request with a wrong secret (ALR-11).
func telegramWebhook(d AlertsDeps, rejected *atomic.Int64, w http.ResponseWriter, r *http.Request) error {
	if !telegram.SecretMatches(r.Header.Get(WebhookSecretHeader), d.WebhookSecret) {
		// Debug per request, a Warn only every 100th so scanners cannot flood the log.
		n := rejected.Add(1)
		ev := zerolog.Ctx(r.Context()).Debug()
		if n%100 == 0 {
			ev = zerolog.Ctx(r.Context()).Warn()
		}
		ev.Int64("rejected_total", n).Msg("telegram webhook: secret header rejected")
		return ErrUnauthenticated("Invalid webhook secret")
	}
	body, err := io.ReadAll(r.Body)
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return errBodyTooLarge()
		}
		return ErrBadRequest("Could not read request body")
	}
	if st, ok := telegram.ParseStart(body, d.BotUsername); ok {
		if _, err := d.Svc.LinkChat(r.Context(), st.ChatID, st.Code); err != nil {
			return err // 500: Telegram retries the update
		}
	}
	WriteData(w, http.StatusOK, map[string]bool{"ok": true})
	return nil
}

func pageParams(r *http.Request) (pagination.Params, error) {
	p, err := pagination.Parse(r.URL.Query())
	switch {
	case errors.Is(err, pagination.ErrInvalidLimit):
		return p, ErrValidation(FieldError{Field: "limit", Message: "must be an integer >= 1"})
	case err != nil:
		return p, ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	}
	return p, nil
}

func alertID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		return 0, ErrNotFound("Alert not found", nil)
	}
	return id, nil
}

func mapAlertError(err error) error {
	var (
		ve *alerts.ValidationError
		nt *alerts.NotFoundTargetError
		tm *alerts.ThresholdMetError
		rl *alerts.RateLimitedError
	)
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, len(ve.Fields))
		for i, f := range ve.Fields {
			fields[i] = FieldError{Field: f.Field, Message: f.Message}
		}
		return ErrValidation(fields...)
	case errors.As(err, &nt):
		if nt.Type == "mf" {
			return ErrNotFound("Scheme not found", map[string]any{"code": nt.Code})
		}
		return ErrNotFound("Instrument not found", map[string]any{"symbol": nt.Symbol})
	case errors.As(err, &tm):
		return NewError(http.StatusUnprocessableEntity, "THRESHOLD_ALREADY_MET", "Threshold "+tm.Error(),
			map[string]any{"kind": tm.Kind, "threshold": tm.Threshold, "value": tm.Value, "as_of": tm.AsOf})
	case errors.As(err, &rl):
		return ErrRateLimited(rl.RetryAfterSeconds)
	case errors.Is(err, alerts.ErrNotFound):
		return ErrNotFound("Alert not found", nil)
	case errors.Is(err, alerts.ErrLimitReached):
		return ErrConflict("Active alert limit reached (200); pause or delete an alert first")
	case errors.Is(err, alerts.ErrNotEditable):
		return ErrConflict("Fired or expired alerts cannot be changed; create a new alert")
	case errors.Is(err, alerts.ErrNotLinked):
		return ErrConflict("Telegram is not linked")
	case errors.Is(err, alerts.ErrNoTelegram):
		return ErrSourceDown("Telegram bot is not configured")
	case errors.Is(err, alerts.ErrSendFailed):
		return ErrSourceDown("Telegram message could not be sent")
	case errors.Is(err, alerts.ErrInvalidCursor):
		return ErrValidation(FieldError{Field: "cursor", Message: "is not valid"})
	}
	return err
}
