package screener

import "encoding/json"

// Preset is a named starting point defined in code (docs/03 section 9).
type Preset struct {
	Name string `json:"name"`
	Spec Spec   `json:"spec"`
}

func f(metric, op string, v float64) Filter {
	raw, _ := json.Marshal(v)
	return Filter{Metric: metric, Op: op, Value: raw}
}

// Presets returns the four documented presets, validated (a bad preset is a programming error).
func Presets() []Preset {
	ps := []Preset{
		{Name: "Quality", Spec: Spec{Filters: []Filter{
			f("roe", ">", 15), f("debt_equity", "<", 0.5), f("profit_growth_3y", ">", 10), f("promoter_pledged_pct", "<", 5)}}},
		{Name: "Value", Spec: Spec{Filters: []Filter{
			f("pe", "<", 15), f("pb", "<", 2), f("roe", ">", 12)}}},
		{Name: "Growth", Spec: Spec{Filters: []Filter{
			f("rev_growth_3y", ">", 15), f("profit_growth_3y", ">", 15)}}},
		{Name: "Momentum", Spec: Spec{Filters: []Filter{
			f("dist_52w_high_pct", ">", -10), f("ret_6m", ">", 15)}}},
	}
	for i := range ps {
		if err := ps[i].Spec.Validate(); err != nil {
			panic("screener: invalid preset " + ps[i].Name)
		}
	}
	return ps
}
