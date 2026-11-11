package httpx

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/india-analyzer/api/internal/admin"
	"github.com/india-analyzer/api/internal/market"
	"github.com/india-analyzer/api/internal/predict"
)

// PredictService is the prediction read surface (B14); *predict.Service implements it.
type PredictService interface {
	Get(ctx context.Context, symbol string) (predict.Result, error)
}

// MarketService is the market overview and holiday surface (B14); *market.Service implements it.
type MarketService interface {
	Overview(ctx context.Context) (market.Overview, error)
	Holidays(ctx context.Context, year int) (market.HolidayList, error)
}

// AdminService is the admin status surface (B14); *admin.Service implements it.
type AdminService interface {
	Status(ctx context.Context) (admin.Status, error)
}

// insightsHandler returns the B14 handler for a route, or nil when the route is not one of B14's or
// its service is not wired (the route then stays a 501 stub).
func insightsHandler(rt route, d Deps) http.Handler {
	if rt.Method != mGet {
		return nil
	}
	switch rt.Path {
	case "/stocks/{symbol}/prediction":
		if d.Predict != nil {
			return Adapt(func(w http.ResponseWriter, r *http.Request) error { return stockPrediction(d.Predict, w, r) })
		}
	case "/market/overview":
		if d.Market != nil {
			return Adapt(func(w http.ResponseWriter, r *http.Request) error {
				o, err := d.Market.Overview(r.Context())
				if err != nil {
					return err
				}
				WriteData(w, http.StatusOK, o, WithMeta(NewMeta(o.AsOf, "import", false, 0)))
				return nil
			})
		}
	case "/market/holidays":
		if d.Market != nil {
			return Adapt(func(w http.ResponseWriter, r *http.Request) error { return marketHolidays(d.Market, w, r) })
		}
	case "/admin/status":
		if d.Admin != nil {
			return Adapt(func(w http.ResponseWriter, r *http.Request) error {
				st, err := d.Admin.Status(r.Context())
				if err != nil {
					return err
				}
				WriteData(w, http.StatusOK, st, WithMeta(NewMeta(time.Now(), "db", false, 0)))
				return nil
			})
		}
	}
	return nil
}

func stockPrediction(svc PredictService, w http.ResponseWriter, r *http.Request) error {
	sym, err := pathSymbol(r)
	if err != nil {
		return err
	}
	res, err := svc.Get(r.Context(), sym)
	var nf *predict.NotFoundError
	if errors.As(err, &nf) {
		return ErrNotFound("Instrument not found", map[string]any{"symbol": safeSymbol(nf.Symbol)})
	}
	if err != nil {
		return err
	}
	if res.Redirect != "" {
		WriteData(w, http.StatusOK, map[string]any{"redirect_symbol": res.Redirect})
		return nil
	}
	asOf := res.Now
	if res.AsOf != nil {
		if t, perr := time.Parse(time.DateOnly, *res.AsOf); perr == nil {
			asOf = t
		}
	}
	WriteData(w, http.StatusOK, res, WithMeta(NewMeta(asOf, "model_run", false, 0)))
	return nil
}

func marketHolidays(svc MarketService, w http.ResponseWriter, r *http.Request) error {
	year := 0
	if raw := r.URL.Query().Get("year"); raw != "" {
		y, err := strconv.Atoi(raw)
		if err != nil || y < 2000 || y > 2100 {
			return ErrValidation(FieldError{Field: "year", Message: "must be a year between 2000 and 2100"})
		}
		year = y
	}
	res, err := svc.Holidays(r.Context(), year)
	if err != nil {
		return err
	}
	WriteData(w, http.StatusOK, res, WithMeta(NewMeta(time.Now(), "market_holiday", false, 0)))
	return nil
}
