package finmath

import (
	"errors"
	"math"
	"testing"
	"time"
)

func day(s string) time.Time {
	t, err := time.Parse(time.DateOnly, s)
	if err != nil {
		panic(err)
	}
	return t
}

// docs/05 section 8.3 golden vector: -1000 on 2020-01-01, +1100 on 2021-01-01 -> 0.09973.
func TestXIRRGoldenVector(t *testing.T) {
	r, err := XIRR([]CashFlow{{day("2020-01-01"), -1000}, {day("2021-01-01"), 1100}})
	if err != nil {
		t.Fatal(err)
	}
	if math.Abs(r-0.09973) > 1e-4 {
		t.Fatalf("xirr = %v, want 0.09973", r)
	}
}

func TestXIRRProperties(t *testing.T) {
	flows := func(back float64) []CashFlow {
		return []CashFlow{{day("2020-01-01"), -1000}, {day("2020-07-01"), -500}, {day("2022-01-01"), back}}
	}
	lo, _ := XIRR(flows(1600))
	hi, _ := XIRR(flows(2200))
	if !(hi > lo) {
		t.Fatalf("not monotonic: %v then %v", lo, hi)
	}
	if loss, _ := XIRR(flows(1000)); loss >= 0 {
		t.Fatalf("loss should be negative, got %v", loss)
	}
	if zero, _ := XIRR(flows(1500)); math.Abs(zero) > 1e-6 {
		t.Fatalf("break-even should be 0, got %v", zero)
	}
}

func TestXIRRNoSolution(t *testing.T) {
	if _, err := XIRR([]CashFlow{{day("2020-01-01"), -1000}}); !errors.Is(err, ErrNoFlows) {
		t.Fatalf("err = %v", err)
	}
	if _, err := XIRR([]CashFlow{{day("2020-01-01"), 1000}, {day("2021-01-01"), 5}}); !errors.Is(err, ErrNoFlows) {
		t.Fatalf("err = %v", err)
	}
}
