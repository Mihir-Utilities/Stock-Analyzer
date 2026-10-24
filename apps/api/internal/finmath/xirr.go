// Package finmath holds money-weighted return math shared by the MF SIP simulator (B10) and the
// portfolio summary (docs/05-analytics-spec.md section 8.3).
package finmath

import (
	"errors"
	"math"
	"time"
)

// CashFlow is one dated flow: negative = money invested, positive = money received.
type CashFlow struct {
	Date   time.Time
	Amount float64
}

// Solver constants from docs/05 section 8.3.
const (
	lowRate    = -0.9999
	highRate   = 100.0
	tolerance  = 1e-7
	maxIter    = 200
	daysInYear = 365.0
)

// Errors: callers show "n/a" for both.
var (
	ErrNoFlows      = errors.New("finmath: need at least one outflow and one inflow")
	ErrNoSignChange = errors.New("finmath: no sign change in [-0.9999, 100]")
)

// XIRR returns the annual rate r (a fraction) with sum(cf_i / (1+r)^t_i) = 0 and
// t_i = (date_i - date_0)/365, where date_0 is the earliest flow. The root is bracketed on
// [-0.9999, 100] and found with Brent's method (bisection steps as fallback).
func XIRR(flows []CashFlow) (float64, error) {
	var neg, pos bool
	for _, f := range flows {
		if f.Amount < 0 {
			neg = true
		} else if f.Amount > 0 {
			pos = true
		}
	}
	if !neg || !pos {
		return 0, ErrNoFlows
	}
	d0 := flows[0].Date
	for _, f := range flows {
		if f.Date.Before(d0) {
			d0 = f.Date
		}
	}
	ts := make([]float64, len(flows))
	for i, f := range flows {
		ts[i] = f.Date.Sub(d0).Hours() / 24 / daysInYear
	}
	npv := func(r float64) float64 {
		s := 0.0
		for i, f := range flows {
			s += f.Amount / math.Pow(1+r, ts[i])
		}
		return s
	}
	return brent(npv, lowRate, highRate)
}

func brent(f func(float64) float64, a, b float64) (float64, error) {
	fa, fb := f(a), f(b)
	if math.IsNaN(fa) || math.IsNaN(fb) || math.IsInf(fa, 0) || math.IsInf(fb, 0) {
		return 0, ErrNoSignChange
	}
	if fa == 0 {
		return a, nil
	}
	if fb == 0 {
		return b, nil
	}
	if fa*fb > 0 {
		return 0, ErrNoSignChange
	}
	if math.Abs(fa) < math.Abs(fb) {
		a, b, fa, fb = b, a, fb, fa
	}
	c, fc := a, fa
	d := b - a
	mflag := true
	for i := 0; i < maxIter; i++ {
		if fb == 0 || math.Abs(b-a) < tolerance {
			return b, nil
		}
		var s float64
		if fa != fc && fb != fc {
			s = a*fb*fc/((fa-fb)*(fa-fc)) + b*fa*fc/((fb-fa)*(fb-fc)) + c*fa*fb/((fc-fa)*(fc-fb))
		} else {
			s = b - fb*(b-a)/(fb-fa)
		}
		lo, hi := (3*a+b)/4, b
		if lo > hi {
			lo, hi = hi, lo
		}
		if s < lo || s > hi ||
			(mflag && math.Abs(s-b) >= math.Abs(b-c)/2) ||
			(!mflag && math.Abs(s-b) >= math.Abs(c-d)/2) ||
			(mflag && math.Abs(b-c) < tolerance) ||
			(!mflag && math.Abs(c-d) < tolerance) {
			s = (a + b) / 2 // bisection fallback
			mflag = true
		} else {
			mflag = false
		}
		fs := f(s)
		d, c, fc = c, b, fb
		if fa*fs < 0 {
			b, fb = s, fs
		} else {
			a, fa = s, fs
		}
		if math.Abs(fa) < math.Abs(fb) {
			a, b, fa, fb = b, a, fb, fa
		}
	}
	return b, nil
}
