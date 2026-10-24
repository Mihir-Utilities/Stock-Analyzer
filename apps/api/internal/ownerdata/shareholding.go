package ownerdata

import (
	"math"
	"strconv"
	"time"
)

// SHRow is one stored shareholding quarter; nil percentages are unknown, never 0.
type SHRow struct {
	QuarterEnd time.Time
	Promoter   *float64
	FII        *float64
	DII        *float64
	MF         *float64
	Insurance  *float64
	Govt       *float64
	Public     *float64
	Pledged    *float64
	FiledOn    *time.Time
	Source     string
	FetchedAt  time.Time
}

// Shareholding is `data` of GET /stocks/{symbol}/shareholding. All series are aligned to Quarters
// and hold percent numbers (12.34 = 12.34% of shares); QoQChange is in percentage points.
type Shareholding struct {
	Quarters         []string            `json:"quarters"`
	Promoter         []*float64          `json:"promoter"`
	FII              []*float64          `json:"fii"`
	DII              []*float64          `json:"dii"`
	MF               []*float64          `json:"mf"`
	Insurance        []*float64          `json:"insurance"`
	Govt             []*float64          `json:"govt"`
	Public           []*float64          `json:"public"`
	Pledged          []*float64          `json:"pledged"`
	Unit             string              `json:"unit"`
	QoQChange        map[string]*float64 `json:"qoq_change"`
	QoQReason        *string             `json:"qoq_reason"`
	LatestFiledOn    *string             `json:"latest_filed_on"`
	MFAvailable      bool                `json:"mf_available"`
	Note             *string             `json:"note"`
	Reason           *string             `json:"reason"`
	EntryHint        *string             `json:"entry_hint"`
	Source           *string             `json:"source"`
	LastUpdated      *string             `json:"last_updated"`
	LatestQuarterEnd *time.Time          `json:"-"`
	UpdatedAt        time.Time           `json:"-"`
}

// f32 turns a REAL column value into the decimal the owner typed (12.3, not 12.300000190734863).
func f32(v *float32) *float64 {
	if v == nil {
		return nil
	}
	f, err := strconv.ParseFloat(strconv.FormatFloat(float64(*v), 'g', -1, 32), 64)
	if err != nil {
		return nil
	}
	return &f
}

const (
	noMFNote   = "MF holding was not entered; DII includes mutual funds"
	noQoQNote  = "single_quarter"
	noPrevNote = "previous_quarter_missing"
)

// BuildShareholding aligns the rows (ascending by quarter) and derives qoq_change between the
// latest quarter and the one directly before it (a quarter that is not ~3 months earlier gives
// null, not a multi-quarter difference). SHP-01: no MF figure -> mf_available=false. SHP-04: a
// single quarter has no QoQ.
func BuildShareholding(rows []SHRow) Shareholding {
	out := Shareholding{
		Quarters: []string{}, Promoter: []*float64{}, FII: []*float64{}, DII: []*float64{}, MF: []*float64{},
		Insurance: []*float64{}, Govt: []*float64{}, Public: []*float64{}, Pledged: []*float64{},
		Unit: "PERCENT", QoQChange: map[string]*float64{},
	}
	keys := []string{"promoter", "fii", "dii", "mf", "insurance", "govt", "public", "pledged"}
	for _, k := range keys {
		out.QoQChange[k] = nil
	}
	if len(rows) == 0 {
		r := ReasonNoData
		out.Reason, out.QoQReason = &r, &r
		h := "Add shareholding via Import or the manual form"
		out.EntryHint = &h
		return out
	}
	for _, r := range rows {
		out.Quarters = append(out.Quarters, r.QuarterEnd.Format(time.DateOnly))
		out.Promoter = append(out.Promoter, r.Promoter)
		out.FII = append(out.FII, r.FII)
		out.DII = append(out.DII, r.DII)
		out.MF = append(out.MF, r.MF)
		out.Insurance = append(out.Insurance, r.Insurance)
		out.Govt = append(out.Govt, r.Govt)
		out.Public = append(out.Public, r.Public)
		out.Pledged = append(out.Pledged, r.Pledged)
		if r.FetchedAt.After(out.UpdatedAt) {
			out.UpdatedAt = r.FetchedAt
		}
	}
	last := rows[len(rows)-1]
	q := last.QuarterEnd
	out.LatestQuarterEnd = &q
	if last.FiledOn != nil {
		s := last.FiledOn.Format(time.DateOnly)
		out.LatestFiledOn = &s
	}
	src := last.Source
	out.Source = &src
	u := out.UpdatedAt.UTC().Format(time.RFC3339)
	out.LastUpdated = &u
	out.MFAvailable = last.MF != nil
	if !out.MFAvailable {
		n := noMFNote
		out.Note = &n
	}

	if len(rows) < 2 {
		r := noQoQNote
		out.QoQReason = &r
		return out
	}
	prev := rows[len(rows)-2]
	gap := last.QuarterEnd.Sub(prev.QuarterEnd).Hours() / 24
	if gap < 70 || gap > 111 { // about 3 months, +/- 20 days (docs/05 section 5)
		r := noPrevNote
		out.QoQReason = &r
		return out
	}
	pairs := map[string][2]*float64{
		"promoter": {last.Promoter, prev.Promoter}, "fii": {last.FII, prev.FII}, "dii": {last.DII, prev.DII},
		"mf": {last.MF, prev.MF}, "insurance": {last.Insurance, prev.Insurance}, "govt": {last.Govt, prev.Govt},
		"public": {last.Public, prev.Public}, "pledged": {last.Pledged, prev.Pledged},
	}
	for k, p := range pairs {
		if p[0] != nil && p[1] != nil {
			d := math.Round((*p[0]-*p[1])*10000) / 10000
			out.QoQChange[k] = &d
		}
	}
	return out
}
