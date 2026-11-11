package mfhold

import (
	"errors"
	"math"
	"math/rand"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func d(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

func tx(id int64, typ, date, units, nav, amount, stamp string) Txn {
	return Txn{ID: id, Scheme: 1, Folio: "F1", Type: typ, Date: day(date), Units: d(units), NAV: d(nav), Amount: d(amount), Stamp: d(stamp)}
}

// MFH-F43: FIFO golden, with and without stamp duty.
func TestFIFOGolden(t *testing.T) {
	for _, stamped := range []bool{false, true} {
		first := tx(1, TypePurchase, "2024-01-01", "100", "10", "1000", "0")
		if stamped {
			first = tx(1, TypePurchase, "2024-01-01", "100", "9.9995", "999.95", "0.05")
		}
		pos, err := Replay([]Txn{
			first,
			tx(2, TypePurchase, "2024-02-01", "100", "12", "1200", "0"),
			tx(3, TypeRedemption, "2024-03-01", "150", "15", "2250", "0"),
		}, day("2024-06-01"))
		if err != nil {
			t.Fatal(err)
		}
		if got := pos.Realized(); !got.Equal(d("650")) {
			t.Errorf("stamped=%v realized = %s, want 650", stamped, got)
		}
		if got := pos.Cost(); !got.Equal(d("600")) {
			t.Errorf("stamped=%v remaining cost = %s, want 600", stamped, got)
		}
		if got := pos.Units(); !got.Equal(d("50")) {
			t.Errorf("units = %s", got)
		}
		if c := pos.Sales[0].Cost; !c.Equal(d("1600")) {
			t.Errorf("consumed cost = %s, want 1600", c)
		}
	}
}

// MFH-V07: same-day purchase and full redemption; ids reversed gives the same outcome.
func TestSameDayOrder(t *testing.T) {
	for _, swap := range []bool{false, true} {
		p, r := int64(1), int64(2)
		if swap {
			p, r = 2, 1
		}
		pos, err := Replay([]Txn{
			tx(r, TypeRedemption, "2024-01-10", "10", "11", "110", "0"),
			tx(p, TypePurchase, "2024-01-10", "10", "10", "100", "0"),
		}, day("2024-01-10"))
		if err != nil {
			t.Fatalf("swap=%v: %v", swap, err)
		}
		if !pos.Units().IsZero() || !pos.Realized().Equal(d("10")) {
			t.Errorf("swap=%v units %s realized %s", swap, pos.Units(), pos.Realized())
		}
	}
}

// MFH-V05 / V08: oversell, rounding dust clamp and the 0.01 rejection.
func TestRedemptionLimits(t *testing.T) {
	buy := tx(1, TypePurchase, "2024-01-01", "10.0000", "10", "100", "0")
	pos, err := Replay([]Txn{buy, tx(2, TypeRedemption, "2024-02-01", "10.0005", "11", "110", "0")}, day("2024-03-01"))
	if err != nil {
		t.Fatalf("0.0005 dust: %v", err)
	}
	if !pos.Units().IsZero() || len(pos.Rounded) != 1 || pos.Sales[0].Units.Cmp(d("10")) != 0 {
		t.Errorf("dust not clamped: units %s rounded %v", pos.Units(), pos.Rounded)
	}
	_, err = Replay([]Txn{buy, tx(2, TypeRedemption, "2024-02-01", "10.0100", "11", "110", "0")}, day("2024-03-01"))
	var ie *InsufficientError
	if !errors.As(err, &ie) || ie.TxnID != 2 || !ie.Held.Equal(d("10")) {
		t.Fatalf("0.01 over: %v", err)
	}
	// Redemption before any purchase.
	if _, err := Replay([]Txn{tx(1, TypeRedemption, "2024-01-01", "1", "10", "10", "0")}, day("2024-03-01")); err == nil {
		t.Error("redemption with nothing held must fail")
	}
	// Another folio does not count (folio is part of the ledger key).
	other := tx(3, TypePurchase, "2024-01-01", "50", "10", "500", "0")
	other.Folio = "F2"
	red := tx(4, TypeRedemption, "2024-02-01", "20", "11", "220", "0")
	if err := Validate([]Txn{buy, other, red}, day("2024-03-01")); err == nil {
		t.Error("units of another folio must not cover a redemption")
	}
}

// MFH-F47 / F48: IDCW payout is income and a flow; reinvest is a lot and income but no flow.
func TestIDCW(t *testing.T) {
	pos, _ := Replay([]Txn{
		tx(1, TypePurchase, "2023-01-01", "10", "100", "1000", "0"),
		tx(2, TypeIDCWPayout, "2024-01-01", "1", "1", "50", "0"),
		tx(3, TypeIDCWReinvest, "2024-02-01", "0.5", "100", "50", "0"),
	}, day("2025-01-01"))
	if !pos.IDCWIncome().Equal(d("100")) || !pos.IDCWPayout.Equal(d("50")) {
		t.Errorf("idcw income %s payout %s", pos.IDCWIncome(), pos.IDCWPayout)
	}
	if !pos.Units().Equal(d("10.5")) || !pos.Cost().Equal(d("1050")) {
		t.Errorf("units %s cost %s", pos.Units(), pos.Cost())
	}
	fl := Flows([]Txn{
		tx(1, TypePurchase, "2023-01-01", "10", "100", "1000", "0"),
		tx(2, TypeIDCWPayout, "2024-01-01", "1", "1", "50", "0"),
		tx(3, TypeIDCWReinvest, "2024-02-01", "0.5", "100", "50", "0"),
	}, day("2025-01-01"))
	if len(fl) != 2 {
		t.Fatalf("flows = %v, want purchase and payout only", fl)
	}
}

func flows(pairs ...string) []Flow {
	var out []Flow
	for ; len(pairs) >= 2; pairs = pairs[2:] {
		out = append(out, Flow{day(pairs[0]), d(pairs[1])})
	}
	return out
}

func ret(fl []Flow, asOf, terminal string, purchase, proceeds, idcw string) Returns {
	tv := d(terminal)
	return ComputeReturns(ReturnsIn{AsOf: day(asOf), Flows: fl, Terminal: &tv, HasOpen: true,
		PurchaseCash: d(purchase), Proceeds: d(proceeds), IDCWCash: d(idcw), Basis: "b"})
}

func near(t *testing.T, name string, got *float64, want float64) {
	t.Helper()
	if got == nil {
		t.Errorf("%s: XIRR is null", name)
		return
	}
	if math.Abs(*got/100-want) > 1e-4 {
		t.Errorf("%s: r = %.5f, want %.5f", name, *got/100, want)
	}
}

// MFH-F49 / F50 / F63: golden vectors of docs/05 8.5.5, the pooled one and the stamp-duty variant.
func TestXIRRVectors(t *testing.T) {
	mf := flows("2024-01-01", "-1000", "2024-07-01", "-1000")
	near(t, "mf", ret(mf, "2025-01-01", "2300", "2000", "0", "0").XIRRPct, 0.20214)
	eq := flows("2024-01-01", "-5000")
	near(t, "equity", ret(eq, "2025-01-01", "5500", "5000", "0", "0").XIRRPct, 0.09971)
	all := flows("2024-01-01", "-1000", "2024-01-01", "-5000", "2024-07-01", "-1000")
	pooled := ret(all, "2025-01-01", "7800", "7000", "0", "0")
	near(t, "pooled", pooled.XIRRPct, 0.12294)
	if math.Abs(*pooled.XIRRPct/100-0.15093) < 1e-3 {
		t.Error("pooled XIRR equals the average of the two; it must never be averaged")
	}
	near(t, "sip", ret(flows("2024-01-05", "-1000", "2024-02-05", "-1000", "2024-03-05", "-1000"), "2025-03-05", "3300", "3000", "0", "0").XIRRPct, 0.09213)
	near(t, "idcw", ret(flows("2023-01-01", "-1000", "2024-01-01", "50"), "2025-01-01", "1100", "1000", "0", "50").XIRRPct, 0.07400)
	near(t, "redemption", ret(flows("2023-01-02", "-1000", "2024-01-02", "-1000", "2024-07-01", "1200"), "2025-01-02", "1000", "2000", "1200", "0").XIRRPct, 0.08033)
	// Stamp duty variant: purchases of 999.95 + 0.05 give the same -1000 flows through Flows().
	st := []Txn{
		tx(1, TypeSIP, "2024-01-01", "10", "99.995", "999.95", "0.05"),
		tx(2, TypeSIP, "2024-07-01", "10", "99.995", "999.95", "0.05"),
	}
	near(t, "stamp", ret(Flows(st, day("2025-01-01")), "2025-01-01", "2300", "2000", "0", "0").XIRRPct, 0.20214)
	// A redemption's stamp duty never enters a flow.
	red := tx(3, TypeRedemption, "2024-09-01", "1", "10", "10", "5")
	if f := Flows([]Txn{red}, day("2025-01-01")); len(f) != 1 || !f[0].Amount.Equal(d("10")) {
		t.Errorf("redemption flow = %v", f)
	}
}

// MFH-F51: under one year shows the absolute return; exactly 365 days annualises.
func TestOneYearRule(t *testing.T) {
	asOf := "2025-01-01"
	short := ret(flows("2024-06-15", "-1000"), asOf, "1100", "1000", "0", "0") // 200 days
	if short.XIRRPct != nil || short.XIRRReason == nil || *short.XIRRReason != ReasonUnderOneYear {
		t.Fatalf("200 days: %+v", short)
	}
	if short.AbsPct == nil || *short.AbsPct != 10 || *short.SpanDays != 200 {
		t.Errorf("abs/span: %v %v", short.AbsPct, short.SpanDays)
	}
	exact := ret(flows("2024-01-02", "-1000"), asOf, "1100", "1000", "0", "0") // 365 days
	if *exact.SpanDays != 365 || exact.XIRRPct == nil || exact.AbsPct == nil {
		t.Errorf("365 days: %+v", exact)
	}
	// MFH-F52: SIP whose first instalment is old is annualised although the last is recent.
	sip := ret(flows("2022-01-05", "-1000", "2023-01-05", "-1000", "2024-12-18", "-1000"), asOf, "3600", "3000", "0", "0")
	if sip.XIRRPct == nil {
		t.Errorf("sip: %+v", sip)
	}
}

// MFH-F53: degenerate cases are null with a reason, never 0.
func TestDegenerateReturns(t *testing.T) {
	asOf := day("2025-01-01")
	missing := ComputeReturns(ReturnsIn{AsOf: asOf, Flows: flows("2023-01-01", "-100"), HasOpen: true, MissingReason: ReasonNoNAV, PurchaseCash: d("100")})
	if missing.XIRRPct != nil || *missing.XIRRReason != ReasonNoNAV {
		t.Errorf("missing nav: %+v", missing)
	}
	one := ComputeReturns(ReturnsIn{AsOf: asOf, Flows: flows("2023-01-01", "-100"), PurchaseCash: d("100")})
	if one.XIRRPct != nil || *one.XIRRReason != ReasonNoFlows {
		t.Errorf("one flow: %+v", one)
	}
	zero := ComputeReturns(ReturnsIn{AsOf: asOf, Flows: flows("2023-01-01", "50"), PurchaseCash: decimal.Zero})
	if zero.XIRRPct != nil || *zero.XIRRReason != ReasonNoPurchases {
		t.Errorf("no purchases: %+v", zero)
	}
	none := ComputeReturns(ReturnsIn{AsOf: asOf})
	if none.XIRRPct != nil || *none.XIRRReason != ReasonNoTxns {
		t.Errorf("no flows: %+v", none)
	}
	tv := d("100")
	signs := ComputeReturns(ReturnsIn{AsOf: asOf, Flows: flows("2022-01-01", "-100", "2022-06-01", "-100"), Terminal: &tv, HasOpen: true, PurchaseCash: d("200")})
	// 200 invested over 2022 and a terminal value of 100 on 2025-01-01: a loss, so the XIRR is negative.
	// B15 review S10: the value is asserted, not just "something came back".
	if signs.XIRRReason != nil || signs.XIRRPct == nil {
		t.Fatalf("signs: %+v", signs)
	}
	near(t, "signs", signs.XIRRPct, -0.21994)
	if signs.AbsPct == nil || *signs.AbsPct != -50 {
		t.Errorf("signs abs: %v", signs.AbsPct)
	}
}

// B15 review S2 / S10 (MFHX-01): dust is clamped only against held units, at the exact 0.001 boundary.
func TestDustBoundaries(t *testing.T) {
	buy := tx(1, TypePurchase, "2024-01-01", "10.0000", "10", "100", "0")
	cases := []struct {
		name   string
		units  string
		wantOK bool
	}{
		{"exactly 0.001 over is clamped", "10.0010", true},
		{"0.0011 over is rejected", "10.0011", false},
		{"exactly held", "10.0000", true},
	}
	for _, c := range cases {
		_, err := Replay([]Txn{buy, tx(2, TypeRedemption, "2024-02-01", c.units, "11", "110", "0")}, day("2024-03-01"))
		var ie *InsufficientError
		if c.wantOK && err != nil || !c.wantOK && !errors.As(err, &ie) {
			t.Errorf("%s: %v", c.name, err)
		}
	}
	// Nothing held: even a 0.0005-unit redemption is an oversell (no clamp against zero units).
	var ie *InsufficientError
	if _, err := Replay([]Txn{tx(1, TypeRedemption, "2024-01-01", "0.0005", "10", "0.005", "0")}, day("2024-03-01")); !errors.As(err, &ie) || !ie.Held.IsZero() {
		t.Errorf("dust redemption with nothing held: %v", err)
	}
	// Fully redeemed, then a dust redemption: still an oversell.
	_, err := Replay([]Txn{buy, tx(2, TypeRedemption, "2024-02-01", "10", "11", "110", "0"), tx(3, TypeRedemption, "2024-02-02", "0.0005", "11", "0.0055", "0")}, day("2024-03-01"))
	if !errors.As(err, &ie) || ie.TxnID != 3 {
		t.Errorf("dust after a full exit: %v", err)
	}
	// Dust left over by a redemption stays held (B15R-3): units are never deleted silently.
	pos, err := Replay([]Txn{buy, tx(2, TypeRedemption, "2024-02-01", "9.9996", "11", "109.9956", "0")}, day("2024-03-01"))
	if err != nil || !pos.Units().Equal(d("0.0004")) || len(pos.Rounded) != 0 {
		t.Errorf("leftover dust: %v units %s", err, pos.Units())
	}
}

func nav(date, v string) *NAV { n := NAV{day(date), d(v)}; return &n }

func scheme(code int32, name, plan, opt string) Scheme {
	cat := "Equity: Flexi Cap"
	return Scheme{Code: code, Name: name, Category: &cat, Plan: plan, Option: opt, Status: "active"}
}

func baseInput(asOf string, txns []Txn, navs map[int32]SchemeNAV) Input {
	return Input{AsOf: day(asOf), Txns: txns, NAVs: navs,
		Schemes: map[int32]Scheme{1: scheme(1, "Alpha Fund", "direct", "growth"), 2: scheme(2, "Beta Fund", "regular", "idcw")}}
}

// MFH-F40: value from the last NAV on or before as_of; exact decimal arithmetic.
func TestValueAndDecimalExactness(t *testing.T) {
	in := baseInput("2024-06-09", []Txn{tx(1, TypePurchase, "2024-01-01", "0.1", "10", "1", "0"), {ID: 2, Scheme: 1, Folio: "F1", Type: TypePurchase, Date: day("2024-01-02"), Units: d("0.2"), NAV: d("10"), Amount: d("2")}},
		map[int32]SchemeNAV{1: {Latest: nav("2024-06-07", "20"), Prev: nav("2024-06-06", "19")}}) // a Sunday as_of
	r := Build(in)
	h := r.Items[0]
	if *h.MarketValue != "6.0000" || h.Units != "0.3000" || *h.NAVDate != "2024-06-07" {
		t.Errorf("value %v units %s nav date %v", *h.MarketValue, h.Units, *h.NAVDate)
	}
	if h.NAVStale {
		t.Error("2 days old must not be stale")
	}
	if *h.DayChange != "0.3000" {
		t.Errorf("day change %v", *h.DayChange)
	}
}

// MFH-F41: stale at 5 days, not at exactly 4; NAV after as_of is ignored by the caller's query.
func TestStaleRule(t *testing.T) {
	buy := []Txn{tx(1, TypePurchase, "2024-01-01", "10", "10", "100", "0")}
	five := Build(baseInput("2024-06-10", buy, map[int32]SchemeNAV{1: {Latest: nav("2024-06-05", "20")}}))
	if !five.Items[0].NAVStale || !five.Stale || five.Items[0].MarketValue == nil {
		t.Errorf("5 days: %+v", five.Items[0])
	}
	if five.Items[0].DayChangeReason == nil || *five.Items[0].DayChangeReason != "nav_stale" {
		t.Errorf("stale day change reason %v", five.Items[0].DayChangeReason)
	}
	four := Build(baseInput("2024-06-09", buy, map[int32]SchemeNAV{1: {Latest: nav("2024-06-05", "20"), Prev: nav("2024-06-04", "19")}}))
	if four.Items[0].NAVStale || four.Stale {
		t.Error("exactly 4 days must not be stale")
	}
}

// MFH-F42: one scheme without NAV makes the view value null with a reason naming it, no partial sum.
func TestNoNAV(t *testing.T) {
	t1 := tx(1, TypePurchase, "2023-01-01", "10", "10", "100", "0")
	t2 := tx(2, TypePurchase, "2023-01-01", "5", "20", "100", "0")
	t2.Scheme = 2
	in := baseInput("2024-06-10", []Txn{t1, t2}, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "20")}})
	r := Build(in)
	var beta Holding
	for _, h := range r.Items {
		if h.SchemeCode == 2 {
			beta = h
		}
	}
	if beta.NAV != nil || beta.MarketValue != nil || beta.Unrealized != nil || beta.XIRRPct != nil || *beta.NAVReason != ReasonNoNAV || *beta.XIRRReason != ReasonNoNAV {
		t.Errorf("unpriced holding: %+v", beta)
	}
	if beta.Units != "5.0000" || beta.Invested != "100.0000" {
		t.Errorf("units/invested must still show: %+v", beta)
	}
	if r.Totals.MarketValue != nil || r.Totals.TotalPnL != nil || *r.Totals.MarketValueReason != "missing_nav: Beta Fund" {
		t.Errorf("totals: %+v", r.Totals)
	}
	if r.Returns.XIRRPct != nil || *r.Returns.XIRRReason != ReasonMissingNAV {
		t.Errorf("returns: %+v", r.Returns)
	}
}

// MFH-F44 / F45 / F46 / F58 / F59.
func TestBucketsExitedAndAllocation(t *testing.T) {
	var txns []Txn
	for i := 0; i < 80; i++ { // an 80-instalment SIP
		txns = append(txns, tx(int64(i+1), TypeSIP, "2023-01-05", "1", "10", "9.95", "0.05"))
	}
	r := Build(baseInput("2024-06-10", txns, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "12")}}))
	tot := r.Totals
	if tot.Invested != "800.0000" || tot.Realized != "0.0000" || tot.IDCWIncome != "0.0000" {
		t.Errorf("totals %+v", tot)
	}
	if *tot.Unrealized != "160.0000" || *tot.TotalPnL != "160.0000" || tot.PurchaseCash != "800.0000" {
		t.Errorf("pnl %+v", tot)
	}
	// Absolute return equals unrealised / invested when nothing was redeemed (MFH-F58).
	if r.Returns.AbsPct == nil || *r.Returns.AbsPct != 20 {
		t.Errorf("abs return %v", r.Returns.AbsPct)
	}
	if len(r.AllocScheme) != 1 || r.AllocScheme[0].WeightPct != 100 || r.AllocCategory[0].WeightPct != 100 {
		t.Errorf("alloc %+v %+v", r.AllocScheme, r.AllocCategory)
	}

	// Fully redeemed scheme: hidden by default, realised stays in totals, no terminal flow (F45).
	ex := []Txn{tx(1, TypePurchase, "2023-01-01", "10", "10", "100", "0"), tx(2, TypeRedemption, "2023-06-01", "10", "12", "120", "0")}
	hidden := Build(baseInput("2024-06-10", ex, nil))
	if len(hidden.Items) != 0 || hidden.Totals.Realized != "20.0000" || hidden.Terminal != nil {
		t.Errorf("exited hidden: items %d totals %+v", len(hidden.Items), hidden.Totals)
	}
	in := baseInput("2024-06-10", ex, nil)
	in.IncludeExited = true
	shown := Build(in)
	if len(shown.Items) != 1 || !shown.Items[0].Exited || shown.Items[0].Units != "0.0000" || shown.Items[0].MarketValue != nil {
		t.Errorf("exited shown: %+v", shown.Items)
	}
	if shown.Items[0].XIRRReason == nil && shown.Items[0].XIRRPct == nil {
		t.Error("exited holding needs a return or a reason")
	}
}

// MFH-F46: property test over random ledgers: total = unrealised + realised + idcw income, and the
// cash-flow identity holds for the absolute return.
func TestPropertyBuckets(t *testing.T) {
	rng := rand.New(rand.NewSource(7)) //nolint:gosec // fixed seed: deterministic test data, not security
	for n := 0; n < 200; n++ {
		var txns []Txn
		held := 0
		for i := 0; i < 12; i++ {
			dt := day("2022-01-01").AddDate(0, 0, i*20)
			switch k := rng.Intn(4); {
			case k <= 1 || held == 0:
				u := rng.Intn(50) + 1
				txns = append(txns, Txn{ID: int64(i + 1), Scheme: 1, Folio: "F", Type: TypeSIP, Date: dt, Units: decimal.NewFromInt(int64(u)),
					NAV: d("10"), Amount: decimal.NewFromInt(int64(u * 10)), Stamp: d("0.05")})
				held += u
			case k == 2:
				u := rng.Intn(held) + 1
				txns = append(txns, Txn{ID: int64(i + 1), Scheme: 1, Folio: "F", Type: TypeRedemption, Date: dt, Units: decimal.NewFromInt(int64(u)),
					NAV: d("11"), Amount: decimal.NewFromInt(int64(u * 11))})
				held -= u
			default:
				txns = append(txns, Txn{ID: int64(i + 1), Scheme: 1, Folio: "F", Type: TypeIDCWPayout, Date: dt, Units: d("1"), NAV: d("1"), Amount: d("7")})
			}
		}
		r := Build(baseInput("2024-06-10", txns, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "13")}}))
		a := r.Agg
		if r.Totals.TotalPnL == nil {
			continue
		}
		want := a.MarketValue.Sub(a.Invested).Add(a.Realized).Add(a.IDCWIncome)
		if *r.Totals.TotalPnL != want.StringFixed(4) {
			t.Fatalf("total_pnl %s != %s", *r.Totals.TotalPnL, want.StringFixed(4))
		}
		// total P&L from cash flows: value + proceeds + idcw cash - purchase cash (no reinvest here).
		cash := a.MarketValue.Add(a.Proceeds).Add(a.IDCWCash).Sub(a.PurchaseCash)
		if !cash.Equal(want) {
			t.Fatalf("cash-flow gain %s != bucket sum %s", cash, want)
		}
	}
}

// MFH-F48: reinvest keeps total P&L equal to the gain computed from cash flows.
func TestReinvestInvariant(t *testing.T) {
	txns := []Txn{
		tx(1, TypePurchase, "2023-01-01", "10", "100", "1000", "0"),
		tx(2, TypeIDCWReinvest, "2023-06-01", "0.5", "100", "50", "0"),
	}
	r := Build(baseInput("2024-06-10", txns, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "120")}}))
	a := r.Agg
	// value 1260, invested 1050, idcw income 50 -> total 260; cash view: 1260 - 1000 = 260.
	if *r.Totals.TotalPnL != "260.0000" || !a.MarketValue.Sub(a.PurchaseCash).Equal(d("260")) {
		t.Errorf("total %v", *r.Totals.TotalPnL)
	}
}

// MFH-F55 / F56 / F57.
func TestFlagsAndWarnings(t *testing.T) {
	buy := tx(1, TypePurchase, "2024-01-01", "10", "10", "100", "0")
	buy.Scheme = 2
	in := baseInput("2024-06-30", []Txn{buy}, map[int32]SchemeNAV{2: {Latest: nav("2024-06-15", "20")}}) // 15 days old
	s := in.Schemes[2]
	s.Status = "inactive"
	first := day("2024-03-01")
	s.FirstNAV = &first
	in.Schemes[2] = s
	r := Build(in)
	codes := map[string]bool{}
	for _, w := range r.Warnings {
		codes[w.Code] = true
	}
	for _, c := range []string{"SCHEME_MAY_BE_MERGED", "NAV_STALE", "IDCW_PAYOUTS_NOT_RECORDED", "NAV_FEED_STARTS_AFTER_TXN"} {
		if !codes[c] {
			t.Errorf("missing warning %s: %v", c, r.Warnings)
		}
	}
	h := r.Items[0]
	if h.MarketValue == nil || *h.MarketValue != "200.0000" || h.Plan != "regular" || h.Option != "idcw" {
		t.Errorf("holding %+v", h)
	}
	// Growth scheme never gets the IDCW warning; unknown plan is shown as unknown.
	g := Build(baseInput("2024-06-10", []Txn{tx(1, TypePurchase, "2024-01-01", "10", "10", "100", "0")}, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "11")}}))
	for _, w := range g.Warnings {
		if w.Code == "IDCW_PAYOUTS_NOT_RECORDED" {
			t.Error("growth scheme must not warn")
		}
	}
	if o := orUnknown(""); o != "unknown" {
		t.Error(o)
	}
	// F57: only one NAV row.
	if g.Items[0].DayChange != nil || *g.Items[0].DayChangeReason != "no_previous_nav" || g.Totals.DayChange != nil {
		t.Errorf("day change %+v", g.Items[0])
	}
}

// MFH-I36 (engine part): one folio number under two funds is two ledgers; folios of one fund sum.
func TestSharedFolioAcrossFunds(t *testing.T) {
	a := tx(1, TypePurchase, "2024-01-01", "10", "10", "100", "0")
	b := tx(2, TypePurchase, "2024-01-01", "20", "10", "200", "0")
	b.Scheme = 2 // same folio "F1", another fund
	r := Build(baseInput("2024-06-10", []Txn{a, b}, map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "10")}, 2: {Latest: nav("2024-06-10", "10")}}))
	if len(r.Items) != 2 {
		t.Fatalf("items %d", len(r.Items))
	}
	in := baseInput("2024-06-10", []Txn{a, b}, nil)
	in.GroupFolio = true
	if g := Build(in); len(g.Items) != 2 || *g.Items[0].Folio != "F1" {
		t.Errorf("folio grouping %+v", g.Items)
	}
}

// MFHX-18 (N3): a null unrealized percentage always has a reason; a zero cost base is "n/m".
func TestUnrealizedPctReason(t *testing.T) {
	// A zero-cost lot (a free allotment recorded with a zero amount, only reachable through a restore).
	in := baseInput("2024-06-10", []Txn{tx(1, TypePurchase, "2023-01-01", "10", "10", "0", "0")},
		map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "20")}})
	r := Build(in)
	h := r.Items[0]
	if h.UnrealizedPct != nil || h.UnrealizedPctReason == nil || *h.UnrealizedPctReason != "n/m" {
		t.Errorf("holding: pct %v reason %v", h.UnrealizedPct, h.UnrealizedPctReason)
	}
	if r.Totals.UnrealizedPct != nil || r.Totals.UnrealizedPctReason == nil || *r.Totals.UnrealizedPctReason != "n/m" {
		t.Errorf("totals: pct %v reason %v", r.Totals.UnrealizedPct, r.Totals.UnrealizedPctReason)
	}
	// A normal holding has the percentage and no reason.
	ok := Build(baseInput("2024-06-10", []Txn{tx(1, TypePurchase, "2023-01-01", "10", "10", "100", "0")},
		map[int32]SchemeNAV{1: {Latest: nav("2024-06-10", "20")}}))
	if ok.Items[0].UnrealizedPct == nil || ok.Items[0].UnrealizedPctReason != nil || *ok.Items[0].UnrealizedPct != 100 {
		t.Errorf("normal holding: %+v", ok.Items[0])
	}
}
