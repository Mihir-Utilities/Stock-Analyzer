package portfolio

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/shopspring/decimal"
)

// IST is the market time zone (India has no DST).
var IST = time.FixedZone("IST", 5*3600+30*60)

// FieldError is one validation failure (422 details.fields[]).
type FieldError struct{ Field, Message string }

// ValidationError carries every field failure of one request.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "portfolio: validation failed" }

// Dec is a decimal request field that accepts a JSON string ("10.50") or number (10.5).
type Dec struct {
	S   string
	Set bool
}

// UnmarshalJSON implements json.Unmarshaler.
func (d *Dec) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if bytes.Equal(b, []byte("null")) {
		return nil
	}
	if len(b) > 0 && b[0] == '"' {
		if err := json.Unmarshal(b, &d.S); err != nil {
			return err
		}
	} else {
		var n json.Number
		if err := json.Unmarshal(b, &n); err != nil {
			return errors.New("must be a decimal string or number")
		}
		d.S = n.String()
	}
	d.Set = true
	return nil
}

var reDecimal = regexp.MustCompile(`^[0-9]{1,15}(\.[0-9]{1,8})?$`)

// parseDecimal accepts plain non-negative decimals with at most maxDP fraction digits.
func parseDecimal(d Dec, maxDP int32) (decimal.Decimal, string) {
	s := strings.TrimSpace(d.S)
	if !reDecimal.MatchString(s) {
		return decimal.Zero, "must be a plain decimal number (digits and one dot)"
	}
	v, err := decimal.NewFromString(s)
	if err != nil {
		return decimal.Zero, "must be a plain decimal number"
	}
	if v.Exponent() < -maxDP {
		return decimal.Zero, fmt.Sprintf("at most %d decimal places", maxDP)
	}
	return v, ""
}

// TxnInput is the body of POST /portfolio/txns (and, with every field optional, of PATCH).
type TxnInput struct {
	Symbol    *string `json:"symbol"`
	Side      *string `json:"side"`
	Qty       Dec     `json:"qty"`
	Price     Dec     `json:"price"`
	Fees      Dec     `json:"fees"`
	TradeDate *string `json:"trade_date"`
	Note      *string `json:"note"`
}

const (
	maxNote  = 500
	maxQty   = 1e9
	maxMoney = 1e13 // numeric(18,4) holds < 1e14; keep a margin for qty*price math
)

var qtyMax = decimal.NewFromFloat(maxQty)
var moneyMax = decimal.NewFromFloat(maxMoney)

// txnValues are validated, typed values.
type txnValues struct {
	Side  string
	Qty   decimal.Decimal
	Price decimal.Decimal
	Fees  decimal.Decimal
	Date  time.Time
	Note  string
}

func parseDate(s string) (time.Time, bool) {
	t, err := time.Parse(time.DateOnly, s)
	return t, err == nil
}

// validateNote checks the optional note.
func validateNote(n *string, fe *[]FieldError) string {
	if n == nil {
		return ""
	}
	if utf8.RuneCountInString(*n) > maxNote {
		*fe = append(*fe, FieldError{"note", "must be at most 500 characters"})
	}
	return *n
}

// Today is the current IST market date.
func today(now time.Time) time.Time {
	i := now.In(IST)
	return time.Date(i.Year(), i.Month(), i.Day(), 0, 0, 0, 0, time.UTC)
}

// ParseAsOf parses ?as_of=YYYY-MM-DD (default today IST). A future date is a 422.
func ParseAsOf(raw string, now time.Time) (time.Time, error) {
	td := today(now)
	if raw == "" {
		return td, nil
	}
	d, ok := parseDate(raw)
	if !ok {
		return td, &ValidationError{[]FieldError{{"as_of", "must be YYYY-MM-DD"}}}
	}
	if d.After(td) {
		return td, &ValidationError{[]FieldError{{"as_of", "must not be in the future"}}}
	}
	return d, nil
}
