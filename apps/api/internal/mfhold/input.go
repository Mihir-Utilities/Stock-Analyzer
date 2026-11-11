package mfhold

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/shopspring/decimal"
)

// IST is the market time zone.
var IST = time.FixedZone("IST", 5*3600+30*60)

// FieldError is one validation failure (422 details.fields[]).
type FieldError struct{ Field, Message string }

// ValidationError carries every field failure of one request.
type ValidationError struct{ Fields []FieldError }

func (e *ValidationError) Error() string { return "mfhold: validation failed" }

// TypeUnsupportedError is 422 MF_TXN_TYPE_NOT_SUPPORTED (MFH-4).
type TypeUnsupportedError struct{ Type string }

// TypeUnsupportedMessage is the exact message of docs/06 section 9.
const TypeUnsupportedMessage = "Switches and merger/bonus entries are not supported yet. Enter a switch as a redemption plus a purchase."

func (e *TypeUnsupportedError) Error() string { return TypeUnsupportedMessage }

// NotFoundError names what was not found.
type NotFoundError struct {
	What    string
	Details map[string]any
}

func (e *NotFoundError) Error() string { return "mfhold: " + e.What + " not found" }

// ConflictError is a 409 with a stable code ("" = CONFLICT) and details.
type ConflictError struct {
	Code    string
	Message string
	Details map[string]any
}

func (e *ConflictError) Error() string { return e.Message }

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

// ParseDecimal accepts plain non-negative decimals with at most maxDP fraction digits (no exponent).
func ParseDecimal(d Dec, maxDP int32) (decimal.Decimal, string) {
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

// Limits of the stored numbers (numeric(18,4) holds < 1e14).
var (
	unitsMax = decimal.NewFromInt(1_000_000_000)
	moneyMax = decimal.NewFromInt(10_000_000_000_000)
)

// Text limits.
const (
	MaxNote  = 500
	MaxFolio = 40
	MaxFund  = 200
)

// DateFloor is the earliest accepted transaction date.
var DateFloor = time.Date(1990, 1, 1, 0, 0, 0, 0, time.UTC)

// TxnInput is the body of POST /portfolio/mf/txns (and, with every field optional, of PATCH).
// SchemeCode and Source are decoded only so that PATCH can refuse them (MFH-V14).
type TxnInput struct {
	SchemeCode *int64  `json:"scheme_code"`
	Folio      *string `json:"folio"`
	TxnType    *string `json:"txn_type"`
	TxnDate    *string `json:"txn_date"`
	Units      Dec     `json:"units"`
	NAV        Dec     `json:"nav"`
	Amount     Dec     `json:"amount"`
	StampDuty  Dec     `json:"stamp_duty"`
	Note       *string `json:"note"`
	Source     *string `json:"source"`
}

// Values are validated, typed values (only the fields that were present are set).
type Values struct {
	Folio, Type, Note  string
	Date               time.Time
	Units, NAV, Amount decimal.Decimal
	Stamp              decimal.Decimal
}

// CleanText removes control characters and trims (docs/01 7.9 text cells).
func CleanText(s string) string {
	return strings.TrimSpace(strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s))
}

// Today is the current IST market date as midnight UTC.
func Today(now time.Time) time.Time {
	i := now.In(IST)
	return time.Date(i.Year(), i.Month(), i.Day(), 0, 0, 0, 0, time.UTC)
}

// ParseDay parses YYYY-MM-DD.
func ParseDay(s string) (time.Time, bool) {
	t, err := time.Parse(time.DateOnly, s)
	return t, err == nil
}

// ValidateValues checks the fields of docs/03 12a. needAll is true for create. The scheme and the
// sequence are checked by the caller.
func ValidateValues(in TxnInput, v *Values, now time.Time, needAll bool) []FieldError {
	var fe []FieldError
	if in.Folio != nil || needAll {
		f := ""
		if in.Folio != nil {
			f = CleanText(*in.Folio)
		}
		if n := utf8.RuneCountInString(f); n < 1 || n > MaxFolio {
			fe = append(fe, FieldError{"folio", "must be 1-40 characters"})
		} else {
			v.Folio = f
		}
	}
	if in.TxnType != nil || needAll {
		t := ""
		if in.TxnType != nil {
			t = *in.TxnType
		}
		if !SupportedType(t) && !KnownType(t) {
			fe = append(fe, FieldError{"txn_type", "must be purchase, sip, redemption, idcw_payout or idcw_reinvest"})
		} else {
			v.Type = t
		}
	}
	if in.Units.Set || needAll {
		u, msg := ParseDecimal(in.Units, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"units", msg})
		case !u.IsPositive() || u.GreaterThan(unitsMax):
			fe = append(fe, FieldError{"units", "must be > 0 and <= 1e9"})
		default:
			v.Units = u
		}
	}
	if in.NAV.Set || needAll {
		n, msg := ParseDecimal(in.NAV, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"nav", msg})
		case !n.IsPositive() || n.GreaterThan(moneyMax):
			fe = append(fe, FieldError{"nav", "must be > 0"})
		default:
			v.NAV = n
		}
	}
	if in.Amount.Set || needAll {
		a, msg := ParseDecimal(in.Amount, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"amount", msg})
		case !a.IsPositive() || a.GreaterThan(moneyMax):
			fe = append(fe, FieldError{"amount", "must be > 0"})
		default:
			v.Amount = a
		}
	}
	if in.StampDuty.Set {
		s, msg := ParseDecimal(in.StampDuty, 4)
		switch {
		case msg != "":
			fe = append(fe, FieldError{"stamp_duty", msg})
		case s.GreaterThan(moneyMax):
			fe = append(fe, FieldError{"stamp_duty", "must be >= 0"})
		default:
			v.Stamp = s
		}
	}
	if in.TxnDate != nil || needAll {
		raw := ""
		if in.TxnDate != nil {
			raw = *in.TxnDate
		}
		d, ok := ParseDay(raw)
		switch {
		case !ok:
			fe = append(fe, FieldError{"txn_date", "must be YYYY-MM-DD"})
		case d.After(Today(now)):
			fe = append(fe, FieldError{"txn_date", "must not be in the future (IST)"})
		case d.Before(DateFloor):
			fe = append(fe, FieldError{"txn_date", "must not be before 1990-01-01"})
		default:
			v.Date = d
		}
	}
	if in.Note != nil {
		if utf8.RuneCountInString(*in.Note) > MaxNote {
			fe = append(fe, FieldError{"note", "must be at most 500 characters"})
		}
		v.Note = CleanText(*in.Note)
	}
	return fe
}

// AmountTolerance is max(1.00, 1% of amount) (MFH-6 correction).
func AmountTolerance(amount decimal.Decimal) decimal.Decimal {
	one := decimal.NewFromInt(1)
	p := amount.Mul(decimal.RequireFromString("0.01"))
	if p.GreaterThan(one) {
		return p
	}
	return one
}

// AmountMismatch reports whether abs(units x nav - amount) exceeds the tolerance.
func AmountMismatch(units, nav, amount decimal.Decimal) bool {
	return units.Mul(nav).Sub(amount).Abs().GreaterThan(AmountTolerance(amount))
}
