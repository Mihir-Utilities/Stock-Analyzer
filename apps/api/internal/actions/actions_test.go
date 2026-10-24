package actions

import (
	"testing"

	"github.com/shopspring/decimal"
)

func dec(s string) decimal.Decimal { return decimal.RequireFromString(s) }

func TestMultiplier(t *testing.T) {
	for _, c := range []struct {
		typ, num, den, want string
		ok                  bool
	}{
		{"split", "10", "2", "5", true},   // docs/05 8.2
		{"bonus", "1", "1", "2", true},    // 1:1 gives 2
		{"bonus", "1", "2", "1.5", true},  // 1:2 gives 1.5
		{"split", "2", "10", "0.2", true}, // consolidation is accepted by the validator
		{"dividend", "1", "1", "0", false},
		{"split", "0", "1", "0", false},
	} {
		got, ok := Multiplier(c.typ, dec(c.num), dec(c.den))
		if ok != c.ok || (ok && !got.Equal(dec(c.want))) {
			t.Errorf("%s %s/%s: %s %v", c.typ, c.num, c.den, got, ok)
		}
	}
}

func TestDisagreesWithDetected(t *testing.T) {
	// Detected r = 1/2, implied multiplier 2; the band is 3% of 2 = 0.06.
	for _, c := range []struct {
		mult string
		want bool
	}{{"2", false}, {"2.06", false}, {"2.0601", true}, {"1.94", false}, {"1.9399", true}, {"1.5", true}} {
		if got := DisagreesWithDetected(dec(c.mult), dec("1"), dec("2")); got != c.want {
			t.Errorf("%s: %v", c.mult, got)
		}
	}
	if DisagreesWithDetected(dec("2"), decimal.Zero, dec("2")) {
		t.Error("no detected ratio must not warn")
	}
}
