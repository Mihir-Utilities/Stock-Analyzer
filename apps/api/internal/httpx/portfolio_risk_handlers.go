package httpx

import (
	"context"
	"net/http"
	"time"

	"github.com/india-analyzer/api/internal/portfolio"
)

// riskService is the portfolio risk surface (B19); *portfolio.Service implements it. It is asserted at
// the route so the main PortfolioService interface does not change.
type riskService interface {
	Risk(ctx context.Context, view, asOf string) (portfolio.RiskResult, error)
}

// portfolioRiskHandler serves GET /portfolio/risk (docs/03 12b), or nil for any other route.
func portfolioRiskHandler(rt route, d Deps) http.Handler {
	if rt.Method+" "+rt.Path != "GET /portfolio/risk" {
		return nil
	}
	svc, ok := d.Portfolio.(riskService)
	if !ok {
		return nil
	}
	return Adapt(func(w http.ResponseWriter, r *http.Request) error {
		q := r.URL.Query()
		res, err := svc.Risk(r.Context(), q.Get("view"), q.Get("as_of"))
		if err != nil {
			return mapPortfolioError(err)
		}
		source := portfolioSource
		switch res.Data.View {
		case portfolio.ViewAll:
			source = "mixed"
		case portfolio.ViewMF:
			source = mfSource
		}
		WriteData(w, http.StatusOK, res.Data, WithMeta(NewMeta(time.Now(), source, res.Stale, res.StaleAgeHours)),
			WithWarnings(pfWarnings(res.Warnings)...))
		return nil
	})
}
