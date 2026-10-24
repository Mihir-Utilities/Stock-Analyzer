package httpx

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/india-analyzer/api/internal/prices"
	"github.com/india-analyzer/api/internal/validate"
)

// PriceService is the price/indicator read surface (B04); *prices.Service implements it.
type PriceService interface {
	Prices(ctx context.Context, symbol string, p prices.Params) (prices.Result[prices.PricesPayload], error)
	Indicators(ctx context.Context, symbol string) (prices.Result[map[string]any], error)
}

// priceHandler returns the B04 handler for a route, or nil (the route stays a 501 stub). Only the
// two GET routes are B04's; the DELETE/trim routes belong to the import tasks.
func priceHandler(rt route, d Deps) http.Handler {
	if rt.Method != mGet || d.Prices == nil {
		return nil
	}
	svc := d.Prices
	switch rt.Path {
	case "/stocks/{symbol}/prices":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stockPrices(svc, w, r) })
	case "/stocks/{symbol}/indicators":
		return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stockIndicators(svc, w, r) })
	}
	return nil
}

// pathSymbol returns the {symbol} path segment. chi hands over the still percent-encoded segment
// only when the request carries a RawPath (e.g. `M%26M`); otherwise the value is already decoded
// and decoding again would corrupt a literal `%` (`A%2541` names the symbol `A%41`). A malformed
// escape, a NUL byte or invalid UTF-8 cannot name an instrument (404, never a 500).
func pathSymbol(r *http.Request) (string, error) {
	sym := chi.URLParam(r, "symbol")
	if r.URL.RawPath != "" {
		dec, err := url.PathUnescape(sym)
		if err != nil {
			return "", ErrNotFound("Instrument not found", map[string]any{"symbol": sym})
		}
		sym = dec
	}
	if !validate.Text(sym) {
		return "", ErrNotFound("Instrument not found", map[string]any{"symbol": strings.ToValidUTF8(strings.ReplaceAll(sym, "\x00", ""), "?")})
	}
	return sym, nil
}

func stockPrices(svc PriceService, w http.ResponseWriter, r *http.Request) error {
	sym, err := pathSymbol(r)
	if err != nil {
		return err
	}
	p, err := prices.ParseParams(r.URL.Query())
	if err != nil {
		return mapPriceError(err, sym)
	}
	res, err := svc.Prices(r.Context(), sym, p)
	if err != nil {
		return mapPriceError(err, sym)
	}
	if res.RedirectSymbol != "" {
		WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.RedirectSymbol})
		return nil
	}
	meta := NewMeta(res.AsOf, "import", res.Stale.Stale, res.Stale.AgeHours)
	meta["interval"] = res.Interval
	WriteData(w, http.StatusOK, res.Data, WithMeta(meta), WithWarnings(toWarnings(res.Warnings)...))
	return nil
}

func stockIndicators(svc PriceService, w http.ResponseWriter, r *http.Request) error {
	sym, err := pathSymbol(r)
	if err != nil {
		return err
	}
	res, err := svc.Indicators(r.Context(), sym)
	if err != nil {
		return mapPriceError(err, sym)
	}
	if res.RedirectSymbol != "" {
		WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.RedirectSymbol})
		return nil
	}
	meta := NewMeta(res.AsOf, "import", res.Stale.Stale, res.Stale.AgeHours)
	WriteData(w, http.StatusOK, res.Data, WithMeta(meta), WithWarnings(toWarnings(res.Warnings)...))
	return nil
}

func toWarnings(ws []prices.Warning) []Warning {
	if len(ws) == 0 {
		return nil
	}
	out := make([]Warning, 0, len(ws))
	for _, x := range ws {
		out = append(out, Warning{Code: x.Code, Message: x.Message})
	}
	return out
}

func mapPriceError(err error, symbol string) error {
	var ve *prices.ValidationError
	var ue *prices.UnavailableError
	switch {
	case errors.As(err, &ve):
		fields := make([]FieldError, 0, len(ve.Fields))
		for _, f := range ve.Fields {
			fields = append(fields, FieldError{Field: f.Field, Message: f.Message})
		}
		return ErrValidation(fields...)
	case errors.Is(err, prices.ErrNotFound):
		return ErrNotFound("Instrument not found", map[string]any{"symbol": symbol})
	case errors.As(err, &ue):
		return ErrDataUnavailable(ue.Reason)
	}
	return err
}
