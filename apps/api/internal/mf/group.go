package mf

import (
	"strings"
	"unicode"
)

// Words that only describe the plan or option of a scheme variant (MF-01). Everything else in the
// name identifies the fund, so variants of one fund share the remaining words.
var variantWords = map[string]bool{
	"direct": true, "regular": true, "plan": true, "growth": true, "idcw": true, "dividend": true,
	"payout": true, "reinvestment": true, "reinvest": true, "option": true, "bonus": true,
	"income": true, "distribution": true, "cum": true, "capital": true, "withdrawal": true,
	"daily": true, "weekly": true, "fortnightly": true, "monthly": true, "quarterly": true,
	"half": true, "yearly": true, "annual": true, "annually": true, "of": true,
}

// BaseName strips plan/option words and separators from a scheme name: "HDFC Flexi Cap Fund -
// Direct Plan - Growth Option" -> "HDFC Flexi Cap Fund". It returns the original-case words.
func BaseName(name string) string {
	fields := strings.FieldsFunc(name, func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '&' && r != '.' && r != '\''
	})
	out := make([]string, 0, len(fields))
	for _, f := range fields {
		if variantWords[strings.ToLower(strings.Trim(f, "."))] {
			continue
		}
		out = append(out, f)
	}
	return strings.Join(out, " ")
}

// groupKey identifies one fund across its variants.
func groupKey(fundHouse, name string) string {
	return strings.ToLower(fundHouse) + "|" + strings.ToLower(BaseName(name))
}

// Group is one fund with its plan/option variants.
type Group struct {
	Name      string       `json:"name"`
	FundHouse *string      `json:"fund_house"`
	Category  *string      `json:"category"`
	Variants  []SchemeItem `json:"variants"`
}

// GroupItems folds consecutive-or-not variants of the same fund into one Group, keeping the order
// of first appearance.
func GroupItems(items []SchemeItem) []Group {
	idx := map[string]int{}
	out := []Group{}
	for _, it := range items {
		house := ""
		if it.FundHouse != nil {
			house = *it.FundHouse
		}
		k := groupKey(house, it.Name)
		i, ok := idx[k]
		if !ok {
			idx[k] = len(out)
			out = append(out, Group{Name: BaseName(it.Name), FundHouse: it.FundHouse, Category: it.Category})
			i = len(out) - 1
		}
		out[i].Variants = append(out[i].Variants, it)
	}
	return out
}
