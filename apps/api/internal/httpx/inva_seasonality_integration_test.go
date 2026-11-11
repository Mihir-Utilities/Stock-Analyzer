package httpx

import (
	"fmt"
	"net/http"
	"slices"
	"sort"
	"testing"
	"time"
)

// GET /stocks/seasonality (INVA-01..10, docs/03 section 4b, D-INV2): the Home tile over every
// tracked stock; same per-stock object as GET /watchlist.

type seasonList struct {
	Month     int     `json:"month"`
	MonthName string  `json:"month_name"`
	AsOf      *string `json:"as_of"`
	Scope     string  `json:"scope"`
	Stocks    []struct {
		Symbol            string         `json:"symbol"`
		Name              string         `json:"name"`
		OnWatchlist       bool           `json:"on_watchlist"`
		Seasonality       *wlSeasonality `json:"seasonality"`
		SeasonalityReason *string        `json:"seasonality_reason"`
	} `json:"stocks"`
}

func (e *pfEnv) seasonList(query string) (seasonList, resp) {
	e.t.Helper()
	r, b := e.req(http.MethodGet, "/stocks/seasonality"+query, "", nil)
	var out seasonList
	if r.Code == http.StatusOK {
		b.into(e.t, &out)
	}
	return out, r
}

func (e *pfEnv) track(id int) {
	e.t.Helper()
	e.exec(`UPDATE instrument SET is_tracked = true, tracked_reason = 'opened' WHERE id = $1`, id)
}

func symbolsOf(l seasonList) []string {
	out := []string{}
	for _, s := range l.Stocks {
		out = append(out, s.Symbol)
	}
	return out
}

func TestINVA01To05AllScopeWatchlistFilterMarkerUntrackedAndNoSnapshot(t *testing.T) {
	e := newPFEnv(t) // pinned clock: 2026-10-23 12:00 IST
	w := e.instrument("WATCHED", "")
	t1 := e.instrument("TRACKED", "")
	un := e.instrument("UNTRACKED", "")
	nos := e.instrument("NOSNAP", "")
	nop := e.instrument("NOPX", "")
	for _, id := range []int{w, t1, un, nos, nop} {
		e.bar(id, "2026-10-23", 100)
	}
	e.exec(`DELETE FROM price_daily WHERE instrument_id = $1`, nop)
	e.watch("WATCHED") // sets is_tracked
	e.track(t1)
	e.track(nos)
	e.track(nop)
	for _, id := range []int{w, t1, un} {
		e.snapshot(id, "2026-10-23", seasonalityJSON("2026-10-23", 2026, 10, "3.0", 0))
	}

	all, r := e.seasonList("")
	if r.Code != 200 || all.Scope != "all" || all.Month != 10 || all.MonthName != "October" || all.AsOf == nil || *all.AsOf != "2026-10-23" {
		t.Fatalf("all: %d %+v", r.Code, all)
	}
	// INVA-04: the untracked stock is not listed; rows are ordered by symbol
	if got := symbolsOf(all); !slices.Equal(got, []string{"NOPX", "NOSNAP", "TRACKED", "WATCHED"}) {
		t.Fatalf("all symbols = %v", got)
	}
	by := map[string]int{}
	for i, s := range all.Stocks {
		by[s.Symbol] = i
	}
	// INVA-03: the marker; INVA-01: the same object as GET /watchlist
	if !all.Stocks[by["WATCHED"]].OnWatchlist || all.Stocks[by["TRACKED"]].OnWatchlist {
		t.Fatalf("on_watchlist wrong: %+v", all.Stocks)
	}
	ws := all.Stocks[by["WATCHED"]].Seasonality
	wl := e.watchlist()["WATCHED"].Seasonality
	if ws == nil || wl == nil || *ws.GreenPct != *wl.GreenPct || ws.NYears != wl.NYears || ws.Month != 10 ||
		ws.MtdReturnPct == nil || *ws.MtdReturnPct != 3.0 || ws.DataSince != "2019-03-01" {
		t.Fatalf("seasonality: %+v vs watchlist %+v", ws, wl)
	}
	if tr := all.Stocks[by["TRACKED"]].Seasonality; tr == nil || tr.NYears != 10 {
		t.Fatalf("TRACKED: %+v", tr)
	}
	// INVA-05: no snapshot -> null with the reason, the other rows are fine
	if s := all.Stocks[by["NOSNAP"]]; s.Seasonality != nil || s.SeasonalityReason == nil || *s.SeasonalityReason != "no_history" {
		t.Fatalf("NOSNAP: %+v", s)
	}
	if s := all.Stocks[by["NOPX"]]; s.Seasonality != nil || s.SeasonalityReason == nil || *s.SeasonalityReason != "no_prices_imported" {
		t.Fatalf("NOPX: %+v", s)
	}

	// INVA-02: the watchlist scope
	wo, r := e.seasonList("?scope=watchlist")
	if r.Code != 200 || wo.Scope != "watchlist" || !slices.Equal(symbolsOf(wo), []string{"WATCHED"}) || !wo.Stocks[0].OnWatchlist {
		t.Fatalf("watchlist scope: %d %+v", r.Code, wo)
	}
	// the explicit default and an empty value behave as all
	for _, q := range []string{"?scope=all", "?scope="} {
		if l, _ := e.seasonList(q); len(l.Stocks) != 4 || l.Scope != "all" {
			t.Fatalf("%s: %+v", q, l)
		}
	}
}

func TestINVA06EmptyUniverse(t *testing.T) {
	e := newPFEnv(t)
	u := e.instrument("UNTRACKED", "")
	e.snapshot(u, "2026-10-23", seasonalityJSON("2026-10-23", 2026, 10, "3.0", 0))
	for _, q := range []string{"", "?scope=watchlist"} {
		l, r := e.seasonList(q)
		if r.Code != 200 || l.Stocks == nil || len(l.Stocks) != 0 || l.AsOf != nil || l.Month != 10 {
			t.Fatalf("empty %q: %d %+v", q, r.Code, l)
		}
	}
}

func TestINVA07ScopeValidationAndINVA09Auth(t *testing.T) {
	e := newPFEnv(t)
	for _, q := range []string{"?scope=foo", "?scope=ALL", "?scope=watchlist,all"} {
		r, b := e.req(http.MethodGet, "/stocks/seasonality"+q, "", nil)
		if r.Code != http.StatusUnprocessableEntity || b.Error.Code != "UNPROCESSABLE" {
			t.Errorf("%s = %d %s", q, r.Code, r.Body.String())
		}
	}
	if r := e.do(http.MethodGet, pfBase+"/stocks/seasonality", "", "", nil); r.Code != http.StatusUnauthorized {
		t.Errorf("without a session = %d", r.Code)
	}
}

func TestINVA08MonthBoundaryAtIstMidnight(t *testing.T) {
	e := newPFEnv(t)
	id := e.instrument("TCS", "")
	e.bar(id, "2026-11-27", 100)
	e.track(id)
	e.snapshot(id, "2026-11-27", seasonalityJSON("2026-11-27", 2026, 11, "2.0", 0))
	setClock(t, time.Date(2026, 11, 30, 18, 29, 0, 0, time.UTC)) // 23:59 IST on 30 Nov
	l, _ := e.seasonList("")
	if l.Month != 11 || l.MonthName != "November" || l.Stocks[0].Seasonality == nil || l.Stocks[0].Seasonality.Month != 11 || l.Stocks[0].Seasonality.MtdReturnPct == nil {
		t.Fatalf("30 Nov 23:59 IST: %+v", l)
	}
	setClock(t, time.Date(2026, 11, 30, 18, 30, 0, 0, time.UTC)) // 00:00 IST on 1 Dec
	l, _ = e.seasonList("")
	s := l.Stocks[0].Seasonality
	if l.Month != 12 || l.MonthName != "December" || s == nil || s.Month != 12 || s.NYears != 12 ||
		s.MtdReturnPct != nil || s.MtdReason == nil || *s.MtdReason != "no_bar_this_month" {
		t.Fatalf("1 Dec 00:00 IST: %+v", l)
	}
}

func TestINVA10CostWithManyTrackedStocks(t *testing.T) {
	for _, n := range []int{48, 100, 200} {
		n := n
		t.Run(fmt.Sprintf("%d", n), func(t *testing.T) {
			e := newPFEnv(t)
			for i := 0; i < n; i++ {
				id := e.instrument(fmt.Sprintf("S%03d", i), "")
				e.bar(id, "2026-10-22", 100)
				e.bar(id, "2026-10-23", 101)
				e.track(id)
				if i%3 == 0 {
					e.watch(fmt.Sprintf("S%03d", i))
				}
				e.snapshot(id, "2026-10-23", seasonalityJSON("2026-10-23", 2026, 10, "1.0", 14000))
			}
			var took []time.Duration
			for i := 0; i < 9; i++ {
				start := time.Now()
				l, r := e.seasonList("")
				if r.Code != 200 || len(l.Stocks) != n {
					t.Fatalf("stocks = %d (%d)", len(l.Stocks), r.Code)
				}
				took = append(took, time.Since(start))
			}
			sort.Slice(took, func(a, b int) bool { return took[a] < took[b] })
			t.Logf("INVA-10: %d tracked stocks, full-size snapshots, median %v, worst of 9 %v", n, took[4], took[8])
			if took[8] > 500*time.Millisecond {
				t.Fatalf("over budget (%v > 500ms)", took[8])
			}
		})
	}
}
