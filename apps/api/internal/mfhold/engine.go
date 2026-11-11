// Package mfhold implements mutual fund holdings (docs/03 section 12a, docs/05 section 8.5): the FIFO
// lot engine per (scheme, folio), value with the stale rule, the cash flows of the pooled XIRR and the
// one-year rule. All money is shopspring/decimal; floats appear only at the XIRR boundary.
package mfhold

import (
	"fmt"
	"sort"
	"time"

	"github.com/shopspring/decimal"
)

// Transaction types of the ledger (docs/02 mf_txn.txn_type). V1 accepts the first five.
const (
	TypePurchase     = "purchase"
	TypeSIP          = "sip"
	TypeRedemption   = "redemption"
	TypeSwitchIn     = "switch_in"
	TypeSwitchOut    = "switch_out"
	TypeIDCWPayout   = "idcw_payout"
	TypeIDCWReinvest = "idcw_reinvest"
	TypeBonusMerger  = "bonus_merger"
)

// SupportedType reports whether v1 accepts the type (MFH-4).
func SupportedType(t string) bool {
	switch t {
	case TypePurchase, TypeSIP, TypeRedemption, TypeIDCWPayout, TypeIDCWReinvest:
		return true
	}
	return false
}

// KnownType reports whether the DB CHECK lists the type.
func KnownType(t string) bool {
	switch t {
	case TypeSwitchIn, TypeSwitchOut, TypeBonusMerger:
		return true
	}
	return SupportedType(t)
}

// RoundingUnits is the largest excess of a redemption over the held units that is clamped (MFH-8).
var RoundingUnits = decimal.RequireFromString("0.001")

// Txn is one dated unit movement of one scheme in one folio. Date is a market date (00:00 UTC).
type Txn struct {
	ID     int64
	Scheme int32
	Folio  string
	Type   string
	Date   time.Time
	Units  decimal.Decimal
	NAV    decimal.Decimal
	Amount decimal.Decimal
	Stamp  decimal.Decimal
}

// AddsUnits is true for the types that create a lot.
func (t Txn) AddsUnits() bool {
	return t.Type == TypePurchase || t.Type == TypeSIP || t.Type == TypeIDCWReinvest
}

// IsPurchase is true for purchase and sip (identical math, sip is a label).
func (t Txn) IsPurchase() bool { return t.Type == TypePurchase || t.Type == TypeSIP }

// Cost is the cost of the lot a unit-adding row creates: amount + stamp duty for purchase and sip
// (the statement's amount is units x NAV and stamp duty is separate, MFH-6 correction); the reinvested
// amount for idcw_reinvest (MFH-17).
func (t Txn) Cost() decimal.Decimal {
	if t.IsPurchase() {
		return t.Amount.Add(t.Stamp)
	}
	return t.Amount
}

func (t Txn) rank() int {
	switch {
	case t.AddsUnits():
		return 0
	case t.Type == TypeIDCWPayout:
		return 1
	}
	return 2
}

// Lot is the open part of one unit-adding row.
type Lot struct {
	TxnID int64
	Date  time.Time
	Units decimal.Decimal
	Cost  decimal.Decimal
}

// Sale is the FIFO result of one redemption.
type Sale struct {
	TxnID    int64
	Date     time.Time
	Units    decimal.Decimal
	Proceeds decimal.Decimal
	Cost     decimal.Decimal
}

// PnL is Proceeds - Cost.
func (s Sale) PnL() decimal.Decimal { return s.Proceeds.Sub(s.Cost) }

// Position is the replay result of one (scheme, folio) or of any union of them.
type Position struct {
	Lots  []Lot
	Sales []Sale
	// IDCWPayout and IDCWReinvest are the amounts of idcw_payout and idcw_reinvest rows.
	IDCWPayout   decimal.Decimal
	IDCWReinvest decimal.Decimal
	// Rounded lists the redemptions that were clamped to the held units (UNITS_ROUNDED).
	Rounded []int64
}

// Units is the open unit count.
func (p Position) Units() decimal.Decimal {
	u := decimal.Zero
	for _, l := range p.Lots {
		u = u.Add(l.Units)
	}
	return u
}

// Cost is the remaining cost of the open lots (the owner's "invested": cost of units still held).
func (p Position) Cost() decimal.Decimal {
	c := decimal.Zero
	for _, l := range p.Lots {
		c = c.Add(l.Cost)
	}
	return c
}

// Realized is the sum of FIFO realised P&L.
func (p Position) Realized() decimal.Decimal {
	r := decimal.Zero
	for _, s := range p.Sales {
		r = r.Add(s.PnL())
	}
	return r
}

// IDCWIncome is the IDCW bucket: payouts plus reinvested amounts (MFH-17).
func (p Position) IDCWIncome() decimal.Decimal { return p.IDCWPayout.Add(p.IDCWReinvest) }

func (p *Position) merge(o Position) {
	p.Lots = append(p.Lots, o.Lots...)
	p.Sales = append(p.Sales, o.Sales...)
	p.IDCWPayout = p.IDCWPayout.Add(o.IDCWPayout)
	p.IDCWReinvest = p.IDCWReinvest.Add(o.IDCWReinvest)
	p.Rounded = append(p.Rounded, o.Rounded...)
}

// InsufficientError is a redemption above the units held on its date.
type InsufficientError struct {
	TxnID  int64
	Scheme int32
	Folio  string
	Date   time.Time
	Held   decimal.Decimal
	Wanted decimal.Decimal
}

func (e *InsufficientError) Error() string {
	return fmt.Sprintf("redemption of %s units on %s exceeds the %s held", e.Wanted, e.Date.Format(time.DateOnly), e.Held)
}

const divPrecision = 12

// Replay processes the rows of ONE (scheme, folio) dated on or before asOf in (date, type rank, id)
// order: unit-adding rows before redemptions on the same date (docs/05 8.5.2, B11-1 rule).
func Replay(txns []Txn, asOf time.Time) (Position, error) {
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
		if ts[i].rank() != ts[j].rank() {
			return ts[i].rank() < ts[j].rank()
		}
		return ts[i].ID < ts[j].ID
	})
	var pos Position
	for _, t := range ts {
		switch {
		case t.AddsUnits():
			pos.Lots = append(pos.Lots, Lot{TxnID: t.ID, Date: t.Date, Units: t.Units, Cost: t.Cost()})
			if t.Type == TypeIDCWReinvest {
				pos.IDCWReinvest = pos.IDCWReinvest.Add(t.Amount)
			}
		case t.Type == TypeIDCWPayout:
			pos.IDCWPayout = pos.IDCWPayout.Add(t.Amount)
		case t.Type == TypeRedemption:
			held := pos.Units()
			units := t.Units
			if units.GreaterThan(held) {
				if units.Sub(held).GreaterThan(RoundingUnits) {
					return pos, &InsufficientError{TxnID: t.ID, Scheme: t.Scheme, Folio: t.Folio, Date: t.Date, Held: held, Wanted: t.Units}
				}
				units = held // rounding dust: clamp, no negative lot (MFH-8)
				pos.Rounded = append(pos.Rounded, t.ID)
			}
			pos.Sales = append(pos.Sales, consume(&pos, t, units))
		}
	}
	return pos, nil
}

func consume(pos *Position, t Txn, units decimal.Decimal) Sale {
	need := units
	cost := decimal.Zero
	for need.IsPositive() && len(pos.Lots) > 0 {
		l := &pos.Lots[0]
		if l.Units.LessThanOrEqual(need) {
			need = need.Sub(l.Units)
			cost = cost.Add(l.Cost)
			pos.Lots = pos.Lots[1:]
			continue
		}
		part := l.Cost.Mul(need).DivRound(l.Units, divPrecision)
		cost = cost.Add(part)
		l.Cost = l.Cost.Sub(part)
		l.Units = l.Units.Sub(need)
		need = decimal.Zero
	}
	return Sale{TxnID: t.ID, Date: t.Date, Units: units, Proceeds: t.Amount, Cost: cost}
}

// Key identifies one ledger: a scheme in one folio. A folio number is not unique per fund.
type Key struct {
	Scheme int32
	Folio  string
}

// Group splits transactions by (scheme, folio), keeping their order.
func Group(txns []Txn) map[Key][]Txn {
	out := map[Key][]Txn{}
	for _, t := range txns {
		k := Key{t.Scheme, t.Folio}
		out[k] = append(out[k], t)
	}
	return out
}

// Validate replays every ledger of the given keys and returns the first oversell (keys sorted).
func Validate(txns []Txn, asOf time.Time) error {
	groups := Group(txns)
	keys := make([]Key, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].Scheme != keys[j].Scheme {
			return keys[i].Scheme < keys[j].Scheme
		}
		return keys[i].Folio < keys[j].Folio
	})
	for _, k := range keys {
		if _, err := Replay(groups[k], asOf); err != nil {
			return err
		}
	}
	return nil
}
