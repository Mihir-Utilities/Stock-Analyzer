package mfhold

import (
	"errors"
	"sort"
	"time"

	"github.com/shopspring/decimal"

	"github.com/india-analyzer/api/internal/finmath"
)

// Reason codes of a null return (docs/03 12a).
const (
	ReasonUnderOneYear = "under_one_year"
	ReasonNoSignChange = "no_sign_change"
	ReasonNoFlows      = "insufficient_flows"
	ReasonNoPurchases  = "no_purchases"
	ReasonNoTxns       = "no_transactions"
	ReasonShortPeriod  = "period_too_short"
	ReasonNoNAV        = "no_nav"
	ReasonMissingNAV   = "missing_nav"
)

// OneYearDays: a span below this shows the absolute return instead of XIRR (docs/05 8.5.6, MFH-3).
const OneYearDays = 365

// Flow is one dated cash flow of the ledger: negative = money invested, positive = money received.
type Flow struct {
	Date   time.Time
	Amount decimal.Decimal
}

// Flows returns the XIRR flows of the rows dated on or before asOf (docs/05 8.5.4): purchase and sip
// -(amount + stamp duty); redemption and idcw_payout +amount; idcw_reinvest none.
func Flows(txns []Txn, asOf time.Time) []Flow {
	var out []Flow
	for _, t := range txns {
		if t.Date.After(asOf) {
			continue
		}
		switch {
		case t.IsPurchase():
			out = append(out, Flow{t.Date, t.Cost().Neg()})
		case t.Type == TypeRedemption, t.Type == TypeIDCWPayout:
			out = append(out, Flow{t.Date, t.Amount})
		}
	}
	return out
}

// ReturnsIn is the input of ComputeReturns for one view or one holding.
type ReturnsIn struct {
	AsOf  time.Time
	Flows []Flow
	// Terminal is the market value of the open holdings, dated AsOf; nil when there is none to add
	// (HasOpen false) or when it is unknown (MissingReason set).
	Terminal      *decimal.Decimal
	HasOpen       bool
	MissingReason string // missing_nav / missing_price: an open holding is unpriced
	PurchaseCash  decimal.Decimal
	Proceeds      decimal.Decimal // redemption (or sell) proceeds
	IDCWCash      decimal.Decimal // idcw_payout cash
	// Basis is the absolute_return_basis text.
	Basis string
}

// Returns is the result: percent numbers, null with a reason when unknown.
type Returns struct {
	XIRRPct    *float64
	XIRRReason *string
	AbsPct     *float64
	Basis      string
	SpanDays   *int
	FirstFlow  *string
}

func sp(s string) *string { return &s }

// ComputeReturns applies docs/05 8.5.4-8.5.6: one XIRR over the pooled flows, absolute return
// (value + proceeds + IDCW cash - purchase cash) / purchase cash, and the one-year rule.
func ComputeReturns(in ReturnsIn) Returns {
	r := Returns{Basis: in.Basis}
	if len(in.Flows) == 0 {
		r.XIRRReason = sp(ReasonNoTxns)
		return r
	}
	first, last := in.Flows[0].Date, in.Flows[0].Date
	for _, f := range in.Flows {
		if f.Date.Before(first) {
			first = f.Date
		}
		if f.Date.After(last) {
			last = f.Date
		}
	}
	fd := first.Format(time.DateOnly)
	r.FirstFlow = &fd
	// The span runs to the valuation date while something is open, else to the last flow (a closed
	// position has no terminal value; same convention as the B11 equity XIRR).
	end := last
	if in.HasOpen {
		end = in.AsOf
	}
	days := int(end.Sub(first).Hours() / 24)
	r.SpanDays = &days
	if in.MissingReason != "" {
		r.XIRRReason = sp(in.MissingReason)
		return r
	}
	if !in.PurchaseCash.IsPositive() {
		r.XIRRReason = sp(ReasonNoPurchases)
		return r
	}
	value := decimal.Zero
	if in.HasOpen && in.Terminal != nil {
		value = *in.Terminal
	}
	abs := value.Add(in.Proceeds).Add(in.IDCWCash).Sub(in.PurchaseCash).Div(in.PurchaseCash).Mul(decimal.NewFromInt(100))
	af, _ := abs.Round(2).Float64()
	r.AbsPct = &af
	neg, pos := false, false
	for _, f := range in.Flows {
		neg = neg || f.Amount.IsNegative()
		pos = pos || f.Amount.IsPositive()
	}
	if in.HasOpen && in.Terminal != nil && in.Terminal.IsPositive() {
		pos = true
	}
	if !neg || !pos {
		r.XIRRReason = sp(ReasonNoFlows)
		return r
	}
	if days < OneYearDays {
		r.XIRRReason = sp(ReasonUnderOneYear)
		return r
	}
	fl := make([]finmath.CashFlow, 0, len(in.Flows)+1)
	for _, f := range in.Flows {
		v, _ := f.Amount.Float64()
		fl = append(fl, finmath.CashFlow{Date: f.Date, Amount: v})
	}
	if in.HasOpen && in.Terminal != nil {
		v, _ := in.Terminal.Float64()
		fl = append(fl, finmath.CashFlow{Date: in.AsOf, Amount: v})
	}
	rate, err := finmath.XIRR(fl)
	switch {
	case err == nil:
		v := decimal.NewFromFloat(rate * 100).Round(4).InexactFloat64()
		r.XIRRPct = &v
	case errors.Is(err, finmath.ErrNoSignChange):
		r.XIRRReason = sp(ReasonNoSignChange)
	default:
		r.XIRRReason = sp(ReasonNoFlows)
	}
	return r
}

// SortFlows orders flows by date (stable), for pooled lists.
func SortFlows(f []Flow) {
	sort.SliceStable(f, func(i, j int) bool { return f[i].Date.Before(f[j].Date) })
}
