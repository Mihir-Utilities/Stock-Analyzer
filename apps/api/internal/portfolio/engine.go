// Package portfolio implements the stocks-only portfolio (docs/03 sections 11-12, docs/05 section 8):
// the FIFO lot engine with confirmed corporate-action adjustments, the summary, the watchlist and
// the transaction store. All money is shopspring/decimal; floats appear only at the XIRR boundary.
package portfolio

import (
	"fmt"
	"sort"
	"time"

	"github.com/shopspring/decimal"
)

// Txn is one owner-entered trade. Date is a market date (00:00 UTC carrying the IST date).
type Txn struct {
	ID    int64
	Side  string // "buy" | "sell"
	Qty   decimal.Decimal
	Price decimal.Decimal
	Fees  decimal.Decimal
	Date  time.Time
}

// Adj is an effective quantity multiplier on an ex-date (docs/05 section 8.2).
type Adj struct {
	Date       time.Time
	Type       string // split | bonus | override
	Multiplier decimal.Decimal
	Source     string // "confirmed_action" | "override"
}

// Lot is the open part of one buy. Qty is in the units of the latest processed date; Cost is the
// total remaining cost (unchanged by splits).
type Lot struct {
	TxnID int64
	Date  time.Time
	Qty   decimal.Decimal
	Cost  decimal.Decimal
}

// Sale is the FIFO result of one sell.
type Sale struct {
	TxnID    int64
	Date     time.Time
	Qty      decimal.Decimal
	Proceeds decimal.Decimal // qty*price - fees
	Cost     decimal.Decimal // consumed cost
}

// PnL is Proceeds - Cost.
func (s Sale) PnL() decimal.Decimal { return s.Proceeds.Sub(s.Cost) }

// Position is the replay result for one instrument.
type Position struct {
	Lots    []Lot
	Sales   []Sale
	Applied []Adj // adjustments that touched at least one open or closed lot, in date order
}

// Qty is the open quantity in the units of the replay's as-of date.
func (p Position) Qty() decimal.Decimal {
	q := decimal.Zero
	for _, l := range p.Lots {
		q = q.Add(l.Qty)
	}
	return q
}

// Cost is the remaining cost of the open lots.
func (p Position) Cost() decimal.Decimal {
	c := decimal.Zero
	for _, l := range p.Lots {
		c = c.Add(l.Cost)
	}
	return c
}

// Realized is the sum of FIFO realized P&L.
func (p Position) Realized() decimal.Decimal {
	r := decimal.Zero
	for _, s := range p.Sales {
		r = r.Add(s.PnL())
	}
	return r
}

// InsufficientError is returned when a sell exceeds the quantity held on its date.
type InsufficientError struct {
	TxnID  int64
	Date   time.Time
	Held   decimal.Decimal
	Wanted decimal.Decimal
}

func (e *InsufficientError) Error() string {
	return fmt.Sprintf("sell of %s on %s exceeds held quantity %s", e.Wanted, e.Date.Format(time.DateOnly), e.Held)
}

const divPrecision = 12

// Replay processes the transactions dated on or before asOf in (date, buys before sells, id)
// order (docs/05 section 8.1) and applies every adjustment with ex_date <= the event date to the
// lots bought strictly before the ex-date (section 8.2), so a sell validates against holdings
// computed with the actions known on that date. Adjustments after the last event but on or before
// asOf are applied at the end.
func Replay(txns []Txn, adjs []Adj, asOf time.Time) (Position, error) {
	ts := make([]Txn, 0, len(txns))
	for _, t := range txns {
		if !t.Date.After(asOf) {
			ts = append(ts, t)
		}
	}
	sort.SliceStable(ts, func(i, j int) bool {
		if !ts[i].Date.Equal(ts[j].Date) {
			return ts[i].Date.Before(ts[j].Date)
		}
		if ts[i].Side != ts[j].Side {
			return ts[i].Side == "buy" // buys before sells on the same date
		}
		return ts[i].ID < ts[j].ID
	})
	as := make([]Adj, 0, len(adjs))
	for _, a := range adjs {
		if !a.Date.After(asOf) {
			as = append(as, a)
		}
	}
	sort.SliceStable(as, func(i, j int) bool { return as[i].Date.Before(as[j].Date) })

	var pos Position
	next := 0
	apply := func(upTo time.Time) {
		for next < len(as) && !as[next].Date.After(upTo) {
			a := as[next]
			next++
			touched := false
			for i := range pos.Lots {
				if pos.Lots[i].Date.Before(a.Date) {
					pos.Lots[i].Qty = pos.Lots[i].Qty.Mul(a.Multiplier)
					touched = true
				}
			}
			if touched {
				pos.Applied = append(pos.Applied, a)
			}
		}
	}
	for _, t := range ts {
		apply(t.Date)
		switch t.Side {
		case "buy":
			pos.Lots = append(pos.Lots, Lot{TxnID: t.ID, Date: t.Date, Qty: t.Qty, Cost: t.Qty.Mul(t.Price).Add(t.Fees)})
		case "sell":
			held := pos.Qty()
			if t.Qty.GreaterThan(held) {
				return pos, &InsufficientError{TxnID: t.ID, Date: t.Date, Held: held, Wanted: t.Qty}
			}
			pos.Sales = append(pos.Sales, consume(&pos, t))
		}
	}
	apply(asOf)
	return pos, nil
}

// consume takes t.Qty from the oldest lots. Fees are capitalised on buys and deducted from sell
// proceeds, so the sell's fees are fully charged to this sale (pro rata to quantity across the lots
// it consumes, which sums to the whole fee).
func consume(pos *Position, t Txn) Sale {
	need := t.Qty
	cost := decimal.Zero
	for need.IsPositive() && len(pos.Lots) > 0 {
		l := &pos.Lots[0]
		if l.Qty.LessThanOrEqual(need) { // whole lot: take its exact remaining cost
			need = need.Sub(l.Qty)
			cost = cost.Add(l.Cost)
			pos.Lots = pos.Lots[1:]
			continue
		}
		part := l.Cost.Mul(need).DivRound(l.Qty, divPrecision)
		cost = cost.Add(part)
		l.Cost = l.Cost.Sub(part)
		l.Qty = l.Qty.Sub(need)
		need = decimal.Zero
	}
	return Sale{TxnID: t.ID, Date: t.Date, Qty: t.Qty, Proceeds: t.Qty.Mul(t.Price).Sub(t.Fees), Cost: cost}
}

// QtyAt is the open quantity at date d (units of d), used for estimated dividends.
func QtyAt(txns []Txn, adjs []Adj, d time.Time) decimal.Decimal {
	pos, err := Replay(txns, adjs, d)
	if err != nil {
		return decimal.Zero
	}
	return pos.Qty()
}

// CorporateAction is a stored action row reduced to what the math needs.
type CorporateAction struct {
	ID        int64
	ExDate    time.Time
	RecordDay *time.Time
	Type      string
	Status    string
	RatioNum  *decimal.Decimal
	RatioDen  *decimal.Decimal
	AmountPS  *decimal.Decimal
	Purpose   string
}

// Override is a portfolio_adjustment row.
type Override struct {
	ID         int64
	ActionID   *int64
	Date       time.Time
	Multiplier decimal.Decimal
	Note       string
}

// Multiplier is the quantity multiplier of a confirmed split or bonus (docs/05 section 8.2).
// ok is false for anything that is not auto-applied (rights, buyback, merger, demerger, dividend,
// split_or_bonus, missing ratio).
func (a CorporateAction) Multiplier() (decimal.Decimal, bool) {
	if a.Status != "confirmed" || a.RatioNum == nil || a.RatioDen == nil || !a.RatioNum.IsPositive() || !a.RatioDen.IsPositive() {
		return decimal.Zero, false
	}
	switch a.Type {
	case "split":
		return a.RatioNum.DivRound(*a.RatioDen, divPrecision), true
	case "bonus":
		return a.RatioNum.Add(*a.RatioDen).DivRound(*a.RatioDen, divPrecision), true
	}
	return decimal.Zero, false
}

// EffectiveAdjustments merges confirmed actions with owner overrides: an override replaces every
// action of the same ex-date (docs/05 section 8.2). Overrides without an action apply on their own.
func EffectiveAdjustments(actions []CorporateAction, overrides []Override) []Adj {
	overridden := map[string]bool{}
	var out []Adj
	for _, o := range overrides {
		overridden[o.Date.Format(time.DateOnly)] = true
		out = append(out, Adj{Date: o.Date, Type: "override", Multiplier: o.Multiplier, Source: "override"})
	}
	for _, a := range actions {
		if m, ok := a.Multiplier(); ok && !overridden[a.ExDate.Format(time.DateOnly)] {
			out = append(out, Adj{Date: a.ExDate, Type: a.Type, Multiplier: m, Source: "confirmed_action"})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Date.Before(out[j].Date) })
	return out
}
