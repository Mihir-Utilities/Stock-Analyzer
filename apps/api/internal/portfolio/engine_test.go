package portfolio

import (
	"errors"
	"testing"
	"time"

	"github.com/shopspring/decimal"
)

func dt(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func buy(id int64, date, qty, price, fees string) Txn {
	return Txn{ID: id, Side: "buy", Qty: dec(qty), Price: dec(price), Fees: dec(fees), Date: dt(date)}
}

func sell(id int64, date, qty, price, fees string) Txn {
	return Txn{ID: id, Side: "sell", Qty: dec(qty), Price: dec(price), Fees: dec(fees), Date: dt(date)}
}

func ratio(num, den string) (*decimal.Decimal, *decimal.Decimal) {
	n, d := dec(num), dec(den)
	return &n, &d
}

// PF-14 + FIFO: fees are capitalised on buys and deducted from sell proceeds. Hand-checked:
// lot1 10 @ 100 + 10 fees = 1010; lot2 10 @ 120 = 1200; sell 15 @ 130 - 15 fees = 1935;
// consumed cost = 1010 + 5/10*1200 = 1610; realized = 325; remaining 5 sh at cost 600 (avg 120).
func TestFIFOHandChecked(t *testing.T) {
	pos, err := Replay([]Txn{
		buy(1, "2024-01-02", "10", "100", "10"),
		buy(2, "2024-02-01", "10", "120", "0"),
		sell(3, "2024-03-01", "15", "130", "15"),
	}, nil, dt("2024-12-31"))
	if err != nil {
		t.Fatal(err)
	}
	if got := pos.Realized().StringFixed(4); got != "325.0000" {
		t.Errorf("realized = %s", got)
	}
	if got := pos.Qty().StringFixed(4); got != "5.0000" {
		t.Errorf("qty = %s", got)
	}
	if got := pos.Cost().StringFixed(4); got != "600.0000" {
		t.Errorf("cost = %s", got)
	}
}

// PF-12: 0.1 + 0.2 is exactly 0.3 (no float drift).
func TestSumPrecision(t *testing.T) {
	pos, err := Replay([]Txn{
		buy(1, "2024-01-02", "0.1", "0.1", "0"),
		buy(2, "2024-01-03", "0.2", "0.2", "0"),
	}, nil, dt("2024-12-31"))
	if err != nil {
		t.Fatal(err)
	}
	if pos.Qty().StringFixed(4) != "0.3000" || !pos.Qty().Equal(dec("0.3")) {
		t.Errorf("qty = %s", pos.Qty())
	}
	if pos.Cost().StringFixed(4) != "0.0500" { // 0.1*0.1 + 0.2*0.2
		t.Errorf("cost = %s", pos.Cost())
	}
}

// PF-03: fractional quantity with 4 decimals.
func TestFractionalQuantity(t *testing.T) {
	pos, err := Replay([]Txn{buy(1, "2024-01-02", "1.2345", "100", "0"), sell(2, "2024-01-03", "0.2345", "100", "0")}, nil, dt("2024-12-31"))
	if err != nil || pos.Qty().StringFixed(4) != "1.0000" {
		t.Fatalf("qty=%v err=%v", pos.Qty(), err)
	}
}

// PF-01: selling more than held is rejected, naming the offending transaction.
func TestOversell(t *testing.T) {
	_, err := Replay([]Txn{buy(1, "2024-01-02", "10", "100", "0"), sell(2, "2024-01-03", "10.0001", "100", "0")}, nil, dt("2024-12-31"))
	var ie *InsufficientError
	if !errors.As(err, &ie) || ie.TxnID != 2 || !ie.Held.Equal(dec("10")) {
		t.Fatalf("err = %v", err)
	}
}

// PF-02: removing an earlier buy invalidates a later sell.
func TestEditInvalidatesLaterSell(t *testing.T) {
	txns := []Txn{buy(1, "2024-01-02", "10", "100", "0"), buy(2, "2024-01-03", "5", "100", "0"), sell(3, "2024-01-10", "12", "100", "0")}
	if _, err := Replay(txns, nil, dt("2024-12-31")); err != nil {
		t.Fatal(err)
	}
	if _, err := Replay(txns[1:], nil, dt("2024-12-31")); err == nil {
		t.Fatal("deleting the first buy must break the sequence")
	}
}

// PF-04: same-day buy and sell: buys first, then id order, whatever the id order was.
func TestSameDayBuyBeforeSell(t *testing.T) {
	pos, err := Replay([]Txn{sell(1, "2024-01-02", "5", "110", "0"), buy(2, "2024-01-02", "5", "100", "0")}, nil, dt("2024-12-31"))
	if err != nil {
		t.Fatal(err)
	}
	if pos.Realized().StringFixed(4) != "50.0000" || !pos.Qty().IsZero() {
		t.Errorf("realized=%s qty=%s", pos.Realized(), pos.Qty())
	}
	// two sells the same day follow id order
	pos, err = Replay([]Txn{buy(1, "2024-01-01", "4", "100", "0"), buy(2, "2024-01-02", "4", "200", "0"),
		sell(4, "2024-01-05", "1", "300", "0"), sell(3, "2024-01-05", "4", "300", "0")}, nil, dt("2024-12-31"))
	if err != nil || pos.Sales[0].TxnID != 3 {
		t.Fatalf("id order: %v %+v", err, pos.Sales)
	}
}

// PF-08: a fully exited position keeps its realized P&L.
func TestFullExitKeepsRealized(t *testing.T) {
	pos, err := Replay([]Txn{buy(1, "2024-01-02", "10", "100", "0"), sell(2, "2024-02-01", "10", "150", "0")}, nil, dt("2024-12-31"))
	if err != nil || !pos.Qty().IsZero() || pos.Realized().StringFixed(4) != "500.0000" || len(pos.Lots) != 0 {
		t.Fatalf("%v %+v", err, pos)
	}
}

// PF-09 / ACT-05: split 10 -> 2 gives multiplier 5; bonus 1:1 gives 2, 1:2 gives 1.5.
func TestMultipliers(t *testing.T) {
	for _, c := range []struct{ typ, num, den, want string }{
		{"split", "10", "2", "5"}, {"bonus", "1", "1", "2"}, {"bonus", "1", "2", "1.5"}, {"split", "1", "5", "0.2"},
	} {
		n, d := ratio(c.num, c.den)
		got, ok := CorporateAction{Type: c.typ, Status: "confirmed", RatioNum: n, RatioDen: d}.Multiplier()
		if !ok || !got.Equal(dec(c.want)) {
			t.Errorf("%s %s:%s = %v %v, want %s", c.typ, c.num, c.den, got, ok, c.want)
		}
	}
}

// ACT-08: rights, buyback, merger, demerger, split_or_bonus and unconfirmed rows are never auto-applied.
func TestNotAutoApplied(t *testing.T) {
	n, d := ratio("2", "1")
	for _, typ := range []string{"rights", "buyback", "merger", "demerger", "split_or_bonus", "dividend", "other"} {
		if _, ok := (CorporateAction{Type: typ, Status: "confirmed", RatioNum: n, RatioDen: d}).Multiplier(); ok {
			t.Errorf("%s must not auto-apply", typ)
		}
	}
	for _, st := range []string{"detected", "rejected"} {
		if _, ok := (CorporateAction{Type: "split", Status: st, RatioNum: n, RatioDen: d}).Multiplier(); ok {
			t.Errorf("status %s must not apply", st)
		}
	}
}

// PF-09: lots bought before the ex-date are adjusted, later ones are not; total cost is unchanged; a
// sell validates against the actions known on its own date.
func TestSplitAdjustment(t *testing.T) {
	adjs := []Adj{{Date: dt("2024-06-01"), Type: "split", Multiplier: dec("5"), Source: "confirmed_action"}}
	txns := []Txn{buy(1, "2024-01-02", "10", "1000", "0"), buy(2, "2024-07-01", "3", "210", "0")}
	pos, err := Replay(txns, adjs, dt("2024-12-31"))
	if err != nil {
		t.Fatal(err)
	}
	if pos.Qty().StringFixed(4) != "53.0000" || pos.Cost().StringFixed(4) != "10630.0000" {
		t.Errorf("qty=%s cost=%s", pos.Qty(), pos.Cost())
	}
	if len(pos.Applied) != 1 {
		t.Errorf("applied = %+v", pos.Applied)
	}
	// 11 shares sold before the ex-date exceed the 10 held then, even though 50 exist afterwards.
	if _, err := Replay(append([]Txn{sell(9, "2024-05-31", "11", "1000", "0")}, txns...), adjs, dt("2024-12-31")); err == nil {
		t.Error("sell before ex-date must validate in pre-split units")
	}
	// 50 sold after the ex-date are fine.
	if _, err := Replay(append([]Txn{sell(9, "2024-06-02", "50", "200", "0")}, txns...), adjs, dt("2024-12-31")); err != nil {
		t.Errorf("post-split sell: %v", err)
	}
	// as_of before the ex-date: not applied.
	pos, _ = Replay(txns[:1], adjs, dt("2024-05-31"))
	if pos.Qty().StringFixed(4) != "10.0000" {
		t.Errorf("as_of before ex-date qty = %s", pos.Qty())
	}
}

// A buy on the ex-date is already in post-action units.
func TestBuyOnExDateNotAdjusted(t *testing.T) {
	adjs := []Adj{{Date: dt("2024-06-01"), Multiplier: dec("2")}}
	pos, _ := Replay([]Txn{buy(1, "2024-06-01", "10", "100", "0")}, adjs, dt("2024-12-31"))
	if pos.Qty().StringFixed(4) != "10.0000" {
		t.Errorf("qty = %s", pos.Qty())
	}
}

// An owner override replaces the confirmed action of the same ex-date.
func TestOverridePrecedence(t *testing.T) {
	n, d := ratio("10", "2")
	acts := []CorporateAction{{ExDate: dt("2024-06-01"), Type: "split", Status: "confirmed", RatioNum: n, RatioDen: d}}
	ov := []Override{{Date: dt("2024-06-01"), Multiplier: dec("4")}}
	adjs := EffectiveAdjustments(acts, ov)
	if len(adjs) != 1 || !adjs[0].Multiplier.Equal(dec("4")) || adjs[0].Source != "override" {
		t.Fatalf("%+v", adjs)
	}
	if adjs = EffectiveAdjustments(acts, nil); len(adjs) != 1 || !adjs[0].Multiplier.Equal(dec("5")) {
		t.Fatalf("%+v", adjs)
	}
}

// Partial consumption of a split-adjusted lot keeps the cost consistent (no rounding residue).
func TestPartialSellCostResidue(t *testing.T) {
	adjs := []Adj{{Date: dt("2024-06-01"), Multiplier: dec("3")}}
	pos, err := Replay([]Txn{buy(1, "2024-01-02", "7", "100", "0"), sell(2, "2024-07-01", "10", "50", "0"), sell(3, "2024-07-02", "11", "50", "0")}, adjs, dt("2024-12-31"))
	if err != nil {
		t.Fatal(err)
	}
	if !pos.Qty().IsZero() || len(pos.Lots) != 0 {
		t.Fatalf("lots = %+v", pos.Lots)
	}
	total := pos.Sales[0].Cost.Add(pos.Sales[1].Cost)
	if total.StringFixed(4) != "700.0000" {
		t.Errorf("consumed cost = %s, want the original 700", total)
	}
}
