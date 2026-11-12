package httpx

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

type riskBody struct {
	View          string `json:"view"`
	AsOf          string `json:"as_of"`
	Concentration struct {
		TotalValue       *string  `json:"total_value"`
		TotalValueReason *string  `json:"total_value_reason"`
		HoldingsCount    int      `json:"holdings_count"`
		Top1             *float64 `json:"top1_pct"`
		HHI              *float64 `json:"hhi"`
		ByHolding        []struct {
			Key       string   `json:"key"`
			Group     string   `json:"group"`
			WeightPct *float64 `json:"weight_pct"`
		} `json:"by_holding"`
		ByGroup []struct {
			Key  string `json:"key"`
			Kind string `json:"kind"`
		} `json:"by_group"`
	} `json:"concentration"`
	Stress struct {
		Items []struct {
			Key      string  `json:"key"`
			Impact10 *string `json:"impact_10"`
		} `json:"items"`
	} `json:"stress"`
	History struct {
		SeriesReason *string `json:"series_reason"`
		PointsCount  int     `json:"points_count"`
		Points       []struct {
			Date  string  `json:"date"`
			Value string  `json:"value"`
			Index float64 `json:"index"`
		} `json:"points"`
		CurrentDD   *float64 `json:"current_drawdown_pct"`
		MaxDrawdown *struct {
			DepthPct float64 `json:"depth_pct"`
		} `json:"max_drawdown"`
		Gaps []struct {
			Reason string `json:"reason"`
		} `json:"gaps"`
	} `json:"history"`
}

func (e *mfhEnv) risk(query string) (resp, mfhBody) {
	e.t.Helper()
	return e.api(http.MethodGet, "/portfolio/risk"+query, "", nil)
}

func (e *mfhEnv) stockTxn(id int, side, qty, price, date string) {
	e.t.Helper()
	e.exec(`INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date) VALUES ($1, $2, $3::numeric, $4::numeric, 0, $5::date)`,
		id, side, qty, price, date)
}

func (e *mfhEnv) riskBar(id int, date string, close float64) {
	e.t.Helper()
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
	        VALUES ($1, $2, $3, $3, $3, $3, $3, 1000, 'import')`, id, date, close)
}

func (e *mfhEnv) stock(sym string, sector any) int {
	e.t.Helper()
	var id int
	if err := e.pool.QueryRow(context.Background(), `INSERT INTO instrument (symbol, name, sector) VALUES ($1, $2, $3) RETURNING id`, sym, sym+" Ltd", sector).Scan(&id); err != nil {
		e.t.Fatal(err)
	}
	return id
}

// PRK-A01: auth, validation and defaults.
func TestPortfolioRiskContract(t *testing.T) {
	e := newMFHEnv(t)
	if r := e.do(http.MethodGet, "/api/v1/portfolio/risk", "", "", nil); r.Code != http.StatusUnauthorized {
		t.Errorf("no session: %d", r.Code)
	}
	for _, q := range []string{"?view=foo", "?as_of=2999-01-01", "?as_of=tomorrow", "?view=all&as_of=2026-13-45"} {
		r, b := e.risk(q)
		if r.Code != http.StatusUnprocessableEntity || b.Error.Code != "UNPROCESSABLE" {
			t.Errorf("%s: %d %s", q, r.Code, b.Error.Code)
		}
	}
	r, b := e.risk("")
	if r.Code != http.StatusOK {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var d riskBody
	b.into(t, &d)
	if d.View != "all" || d.AsOf != "2026-11-11" {
		t.Errorf("default view %q as_of %q", d.View, d.AsOf)
	}
	// an empty ledger is a 200 with reasons, never an error
	if d.Concentration.TotalValueReason == nil || *d.Concentration.TotalValueReason != "no_open_holdings" ||
		d.History.SeriesReason == nil || *d.History.SeriesReason != "no_transactions" || d.History.CurrentDD != nil {
		t.Errorf("empty ledger: %+v", d)
	}
}

// PRK-C05..C07, PRK-H11, PRK-A02: a small mixed ledger through the real router.
func TestPortfolioRiskMixedLedger(t *testing.T) {
	e := newMFHEnv(t)
	a, b := e.stock("AAA", "Banks"), e.stock("BBB", nil)
	for _, p := range [][2]string{{"2026-11-02", "100"}, {"2026-11-03", "110"}, {"2026-11-04", "99"}, {"2026-11-05", "99"}, {"2026-11-06", "108.9"}} {
		e.riskBar(a, p[0], mustF(p[1]))
	}
	for _, p := range [][2]string{{"2026-11-02", "50"}, {"2026-11-03", "50"}, {"2026-11-04", "50"}, {"2026-11-05", "50"}, {"2026-11-06", "50"}} {
		e.riskBar(b, p[0], mustF(p[1]))
	}
	e.stockTxn(a, "buy", "10", "100", "2026-11-02")
	e.stockTxn(a, "buy", "10", "110", "2026-11-03")
	e.stockTxn(a, "buy", "20", "99", "2026-11-04")
	e.stockTxn(b, "buy", "10", "50", "2026-11-02")
	e.stockTxn(b, "sell", "10", "50", "2026-11-05") // exited: not in concentration
	e.scheme(500, "Fund One", "direct", "growth", "2026-11-02=10", "2026-11-06=10.5")
	e.mustTxn(500, "f1", "purchase", "2026-11-02", "100.0000", "10.0000", "1000.0000", "0")

	r, body := e.risk("?view=equity")
	if r.Code != http.StatusOK {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	var d riskBody
	body.into(t, &d)
	if d.View != "equity" || d.Concentration.HoldingsCount != 1 || len(d.Concentration.ByHolding) != 1 || d.Concentration.ByHolding[0].Key != "AAA" {
		t.Fatalf("equity concentration %+v", d.Concentration)
	}
	if *d.Concentration.TotalValue != "4356.0000" || *d.Concentration.HHI != 1 || len(d.Stress.Items) != 1 || *d.Stress.Items[0].Impact10 != "-435.6000" {
		t.Errorf("equity figures %+v", d.Concentration)
	}
	if src, _ := body.Meta["source"].(string); src != "owner transactions + imported prices" {
		t.Errorf("equity source %v", body.Meta["source"])
	}
	// the exit day of BBB is a series date with the combined holdings; the fall on 11-04 shows in the index
	if d.History.PointsCount != 5 || d.History.MaxDrawdown == nil || d.History.MaxDrawdown.DepthPct >= 0 {
		t.Errorf("history %+v", d.History)
	}

	r, body = e.risk("?view=mf")
	if r.Code != http.StatusOK {
		t.Fatalf("%d %s", r.Code, r.Body.String())
	}
	body.into(t, &d)
	if d.Concentration.ByGroup[0].Key != "Equity: Flexi Cap" || d.Concentration.ByGroup[0].Kind != "category" || d.History.PointsCount != 2 {
		t.Errorf("mf view %+v", d)
	}
	if src, _ := body.Meta["source"].(string); src != "mfapi.in" {
		t.Errorf("mf source %v", body.Meta["source"])
	}

	r, body = e.risk("?view=all")
	body.into(t, &d)
	if r.Code != http.StatusOK || d.Concentration.HoldingsCount != 2 || *d.Concentration.TotalValue != "5406.0000" {
		t.Errorf("all %d %+v", r.Code, d.Concentration)
	}
	kinds := map[string]string{}
	for _, g := range d.Concentration.ByGroup {
		kinds[g.Key] = g.Kind
	}
	if kinds["Banks"] != "sector" || kinds["Mutual funds"] != "mutual_funds" {
		t.Errorf("all groups %v", kinds)
	}
	// PRK-A02: strict JSON, money strings with 4 decimals
	raw := r.Body.String()
	for _, bad := range []string{"NaN", "Infinity"} {
		if strings.Contains(raw, bad) {
			t.Errorf("response contains %s", bad)
		}
	}
	for _, p := range d.History.Points {
		if i := strings.IndexByte(p.Value, '.'); i < 0 || len(p.Value)-i-1 != 4 {
			t.Errorf("value %q is not a 4-decimal string", p.Value)
		}
	}

	// PRK-H11: a past as_of ignores later transactions and bars
	r, body = e.risk("?view=equity&as_of=2026-11-03")
	body.into(t, &d)
	if r.Code != http.StatusOK || d.History.PointsCount != 2 || d.AsOf != "2026-11-03" || *d.Concentration.TotalValue != "2700.0000" {
		t.Errorf("past as_of %d %+v", r.Code, d)
	}

	// C2 through the API: an unpriced holding blanks the weights and names the stock
	cc := e.stock("CCC", "IT")
	e.stockTxn(cc, "buy", "5", "10", "2026-11-04")
	_, body = e.risk("?view=equity")
	body.into(t, &d)
	if d.Concentration.TotalValue != nil || d.Concentration.TotalValueReason == nil || *d.Concentration.TotalValueReason != "missing_price: CCC" ||
		d.Concentration.Top1 != nil || d.Concentration.HHI != nil {
		t.Errorf("unpriced %+v", d.Concentration)
	}
	for _, h := range d.Concentration.ByHolding {
		if h.WeightPct != nil {
			t.Errorf("%s weight %v must be null", h.Key, *h.WeightPct)
		}
	}
	if len(d.History.Gaps) == 0 || d.History.Gaps[0].Reason != "missing_price: CCC" {
		t.Errorf("gaps %+v", d.History.Gaps)
	}
}

// PRK-H14: an oversold stored sequence is excluded with a warning instead of failing the endpoint.
func TestPortfolioRiskOversold(t *testing.T) {
	e := newMFHEnv(t)
	a := e.stock("AAA", "Banks")
	e.riskBar(a, "2026-11-02", 100)
	e.riskBar(a, "2026-11-03", 101)
	e.stockTxn(a, "buy", "1", "100", "2026-11-02")
	e.stockTxn(a, "sell", "5", "100", "2026-11-03") // cannot happen through the API; corrupt storage
	r, b := e.risk("?view=equity")
	if r.Code != http.StatusOK || !b.warned("HOLDINGS_INCONSISTENT") {
		t.Errorf("%d %s", r.Code, r.Body.String())
	}
}

// PRK-A03: about 200 transactions over 40 stocks and 10 years (about 2,500 dates) of daily prices.
func TestPortfolioRiskCost(t *testing.T) {
	if testing.Short() {
		t.Skip("cost measurement")
	}
	e := newMFHEnv(t)
	const stocks = 40
	e.exec(`INSERT INTO instrument (symbol, name, sector) SELECT 'S' || g, 'Stock ' || g, CASE WHEN g % 7 = 0 THEN NULL ELSE 'Sector ' || (g % 9) END FROM generate_series(1, $1) g`, stocks)
	// 2,520 weekdays-like dates ending 2026-11-11, a gently wandering price
	e.exec(`INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source)
		SELECT i.id, d.d, p.px, p.px, p.px, p.px, p.px, 1000, 'import'
		FROM instrument i
		CROSS JOIN (SELECT ('2026-11-11'::date - n)::date AS d, n FROM generate_series(0, 3640) n WHERE extract(isodow FROM '2026-11-11'::date - n) < 6) d
		CROSS JOIN LATERAL (SELECT (100 + i.id + 30 * sin(d.n / 40.0 + i.id))::float8 AS px) p`)
	// 5 transactions per stock: buys spread over the decade, one partial sell
	e.exec(`INSERT INTO portfolio_txn (instrument_id, side, qty, price, fees, trade_date)
		SELECT i.id, CASE WHEN k = 1 THEN 'sell' ELSE 'buy' END, CASE WHEN k = 1 THEN 5 ELSE 10 END, 100, 0,
		       ('2026-11-11'::date - (k * 700 + i.id))::date
		FROM instrument i CROSS JOIN generate_series(1, 5) k WHERE ('2026-11-11'::date - (k * 700 + i.id)) > '2016-12-01'`)
	e.exec(`UPDATE portfolio_txn SET trade_date = trade_date + CASE extract(isodow FROM trade_date) WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 0 END`)
	n := e.count(`SELECT count(*) FROM portfolio_txn`)
	bars := e.count(`SELECT count(*) FROM price_daily`)
	var worst time.Duration
	var all []time.Duration
	var points int
	for i := 0; i < 5; i++ {
		start := time.Now()
		r, b := e.risk("?view=all")
		el := time.Since(start)
		if r.Code != http.StatusOK {
			t.Fatalf("%d %s", r.Code, r.Body.String())
		}
		var d riskBody
		b.into(t, &d)
		points = d.History.PointsCount
		all = append(all, el)
		if el > worst {
			worst = el
		}
	}
	sort.Slice(all, func(i, j int) bool { return all[i] < all[j] })
	median := all[len(all)/2]
	t.Logf("PRK-A03: %d transactions, %d stocks, %d bars, %d series points: median %v, worst %v of 5 reads", n, stocks, bars, points, median, worst)
	// The documented budget is 500 ms on a quiet local machine (recorded in OPEN_QUESTIONS PRK-8). The
	// assertion is a regression guard with room for a shared 2-vCPU CI runner, on the median of five reads.
	if median > 1500*time.Millisecond {
		t.Errorf("median response %v is far over the 500 ms budget", median)
	}
	if points < 1000 {
		t.Errorf("points %d", points)
	}
	_ = json.Valid
}

func mustF(s string) float64 {
	f, err := strconv.ParseFloat(s, 64)
	if err != nil {
		panic(err)
	}
	return f
}
