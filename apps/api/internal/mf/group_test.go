package mf

import "testing"

// MF-01: variants of one fund share a base name; different funds do not.
func TestBaseNameAndGrouping(t *testing.T) {
	cases := map[string]string{
		"HDFC Flexi Cap Fund - Direct Plan - Growth Option":                                                       "HDFC Flexi Cap Fund",
		"HDFC Flexi Cap Fund - Regular Plan - IDCW":                                                               "HDFC Flexi Cap Fund",
		"ICICI Prudential Bluechip Fund - Direct Plan - Income Distribution cum Capital Withdrawal option (IDCW)": "ICICI Prudential Bluechip Fund",
		"Axis Bluechip Fund-Direct Plan-Dividend Reinvestment":                                                    "Axis Bluechip Fund",
		"SBI Magnum Children's Benefit Fund - Savings Plan":                                                       "SBI Magnum Children's Benefit Fund Savings",
		"Parag Parikh Flexi Cap Fund - Direct Growth":                                                             "Parag Parikh Flexi Cap Fund",
	}
	for in, want := range cases {
		if got := BaseName(in); got != want {
			t.Errorf("BaseName(%q) = %q, want %q", in, got, want)
		}
	}
	house := func(s string) *string { return &s }
	items := []SchemeItem{
		{Code: 1, Name: "Alpha Fund - Direct Plan - Growth", FundHouse: house("Alpha")},
		{Code: 2, Name: "Alpha Fund - Regular Plan - Growth", FundHouse: house("Alpha")},
		{Code: 3, Name: "Alpha Fund - Direct Plan - Growth", FundHouse: house("Other")}, // same name, other house
		{Code: 4, Name: "Alpha Fund II - Direct Plan - Growth", FundHouse: house("Alpha")},
	}
	g := GroupItems(items)
	if len(g) != 3 || len(g[0].Variants) != 2 || g[0].Variants[1].Code != 2 {
		t.Fatalf("groups = %+v", g)
	}
}

func TestParseSearchDefaults(t *testing.T) {
	p, err := ParseSearch(map[string][]string{})
	if err != nil || p.Plan != "direct" || p.Option != "growth" || p.IncludeAll {
		t.Fatalf("%+v %v", p, err)
	}
	p, err = ParseSearch(map[string][]string{"include_all": {"true"}})
	if err != nil || p.Plan != "" || p.Option != "" || !p.IncludeAll {
		t.Fatalf("%+v %v", p, err)
	}
	if _, err = ParseSearch(map[string][]string{"q": {"a b c d e f g h i j k l m"}}); err == nil {
		t.Fatal("13 words must be rejected")
	}
}

func TestBuildSearchParameterised(t *testing.T) {
	p, _ := ParseSearch(map[string][]string{"q": {"x'; DROP TABLE mf_scheme;--  50%"}})
	sqlText, args := buildSearch(p, nil)
	for _, a := range args {
		if s, ok := a.(string); ok && len(s) > 3 && containsAny(sqlText, s) {
			t.Fatalf("value %q was concatenated into the SQL", s)
		}
	}
	if len(args) < 5 {
		t.Fatalf("args = %v", args)
	}
}

func containsAny(sqlText, s string) bool {
	for i := 0; i+len(s) <= len(sqlText); i++ {
		if sqlText[i:i+len(s)] == s {
			return true
		}
	}
	return false
}
