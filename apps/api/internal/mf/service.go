package mf

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/pagination"
	"github.com/india-analyzer/api/internal/validate"
)

// Backfiller enqueues the mf_refresh job for a scheme that has no NAV rows (docs/03 section 10).
// The adapter lives in cmd/api so this package does not import the jobs package.
type Backfiller interface {
	EnqueueMFRefresh(ctx context.Context, code int32) (Backfill, error)
}

// Backfill is the `backfill` block of the detail response.
type Backfill struct {
	Status string `json:"status"` // queued | running | none
	JobID  *int64 `json:"job_id"`
}

// Staleness thresholds (docs/05 section 9.5 for the 10-day merged/closed notice; B10-3 for stale).
const (
	mergedAfterDays = 10
	staleAfterDays  = 4
)

// Service is the mutual fund use-case layer.
type Service struct {
	db       dbq.DBTX
	q        *dbq.Queries
	Now      func() time.Time
	Backfill Backfiller
}

// New builds a Service over a pool (or anything satisfying dbq.DBTX).
func New(db dbq.DBTX, bf Backfiller) *Service {
	return &Service{db: db, q: dbq.New(db), Now: time.Now, Backfill: bf}
}

// Warning is one entry of the response-level warnings[].
type Warning struct{ Code, Message string }

// Freshness feeds the envelope `meta`.
type Freshness struct {
	AsOf     time.Time
	Stale    bool
	AgeHours float64
}

func pgDate(t time.Time) pgtype.Date { return pgtype.Date{Time: t, Valid: true} }

func dateStr(d pgtype.Date) *string {
	if !d.Valid {
		return nil
	}
	s := d.Time.Format(time.DateOnly)
	return &s
}

func text(t pgtype.Text) *string {
	if !t.Valid {
		return nil
	}
	return &t.String
}

func unknownAs(t pgtype.Text) string {
	if !t.Valid || t.String == "" {
		return "unknown"
	}
	return t.String
}

func (s *Service) freshness(last *time.Time) Freshness {
	now := s.Now()
	if last == nil {
		return Freshness{AsOf: now}
	}
	age := now.Sub(*last)
	return Freshness{AsOf: *last, Stale: age > staleAfterDays*24*time.Hour, AgeHours: age.Hours()}
}

// ---- search ----

// SchemeItem is one search row.
type SchemeItem struct {
	Code        int32    `json:"code"`
	Name        string   `json:"name"`
	FundHouse   *string  `json:"fund_house"`
	Category    *string  `json:"category"`
	Plan        string   `json:"plan"`
	Option      string   `json:"option"`
	Status      string   `json:"status"`
	LatestNav   *float64 `json:"latest_nav"`    // INR per unit, from the 1Y cache when present
	LastNavDate *string  `json:"last_nav_date"` // the NAV's own date
	Return1YPct *float64 `json:"return_1y_pct"` // percent (CAGR), null when not cached or short history
	AsOf        *string  `json:"returns_as_of"` // date of the cached metrics
	Unit        string   `json:"unit"`          // "INR per unit"
	Source      string   `json:"source"`        // attribution source
}

// SearchResult is `data` of GET /mf/schemes: Items are SchemeItem, or Group when group=true.
type SearchResult struct {
	Items       any     `json:"items"`
	NextCursor  *string `json:"next_cursor"`
	Attribution string  `json:"attribution"`
	// Freshness is the newest NAV date on the page (meta.as_of); now when the page has none.
	Freshness Freshness `json:"-"`
}

type searchCursor struct {
	Name string
	Code int32
}

func escapeLike(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// buildSearch assembles the parameterised statement. Every value is a bind parameter; only fixed
// SQL fragments are concatenated. Each word is an `ILIKE '%word%'` so the trigram index
// mf_scheme_name_trgm can serve it (MF-12).
func buildSearch(p SearchParams, cur *searchCursor) (string, []any) {
	var (
		where []string
		args  []any
	)
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	if !p.IncludeAll {
		where = append(where, "s.status = 'active'")
	}
	for _, tok := range p.Tokens {
		where = append(where, "s.name ILIKE "+arg("%"+escapeLike(tok)+"%"))
	}
	if p.Category != "" {
		where = append(where, "s.category = "+arg(p.Category))
	}
	if p.FundHouse != "" {
		where = append(where, "s.fund_house = "+arg(p.FundHouse))
	}
	if p.Plan != "" {
		where = append(where, "s.plan = "+arg(p.Plan))
	}
	if p.Option != "" {
		where = append(where, "s.option_type = "+arg(p.Option))
	}
	if cur != nil {
		where = append(where, "(s.name, s.code) > ("+arg(cur.Name)+", "+arg(cur.Code)+")")
	}
	sql := `SELECT s.code, s.name, s.fund_house, s.category, s.plan, s.option_type, s.status,
       CASE WHEN c.metrics->>'end_nav' IS NOT NULL AND c.metrics->>'end_date' IS NOT NULL
            THEN (c.metrics->>'end_date')::date ELSE s.last_nav_date END,
       (c.metrics->>'end_nav')::float8, (c.metrics->'returns'->>'1y')::float8, c.as_of
FROM mf_scheme s LEFT JOIN mf_return_cache c ON c.scheme_code = s.code`
	if len(where) > 0 {
		sql += "\nWHERE " + strings.Join(where, " AND ")
	}
	sql += "\nORDER BY s.name, s.code LIMIT " + arg(p.Page.Limit+1)
	return sql, args
}

// Search lists schemes (docs/03 section 10), keyset-paginated by (name, code). With group=true the
// rows of the page are folded into funds; variants that sort onto another page appear in that
// page's group (B10-1).
func (s *Service) Search(ctx context.Context, p SearchParams) (SearchResult, error) {
	var cur *searchCursor
	if p.Page.Cursor != "" {
		var raw [2]json.RawMessage
		if err := pagination.Decode(p.Page.Cursor, &raw); err != nil {
			return SearchResult{}, ErrInvalidCursor
		}
		var c searchCursor
		if json.Unmarshal(raw[0], &c.Name) != nil || json.Unmarshal(raw[1], &c.Code) != nil || !validate.Text(c.Name) {
			return SearchResult{}, ErrInvalidCursor
		}
		cur = &c
	}
	sqlText, args := buildSearch(p, cur)
	rows, err := s.db.Query(ctx, sqlText, args...)
	if err != nil {
		return SearchResult{}, err
	}
	defer rows.Close()
	var items []SchemeItem
	for rows.Next() {
		var (
			it                    SchemeItem
			house, cat, plan, opt pgtype.Text
			last, asOf            pgtype.Date
			nav, r1y              pgtype.Float8
		)
		if err := rows.Scan(&it.Code, &it.Name, &house, &cat, &plan, &opt, &it.Status, &last, &nav, &r1y, &asOf); err != nil {
			return SearchResult{}, err
		}
		it.FundHouse, it.Category = text(house), text(cat)
		it.Plan, it.Option = unknownAs(plan), unknownAs(opt)
		it.LastNavDate, it.AsOf = dateStr(last), dateStr(asOf)
		if nav.Valid {
			it.LatestNav = &nav.Float64
		}
		if r1y.Valid {
			it.Return1YPct = &r1y.Float64
		}
		it.Unit, it.Source = "INR per unit", "mfapi.in"
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return SearchResult{}, err
	}
	page, err := pagination.NewPage(items, p.Page.Limit, func(last SchemeItem) (string, error) {
		return pagination.Encode(last.Name, last.Code)
	})
	if err != nil {
		return SearchResult{}, err
	}
	res := SearchResult{NextCursor: page.NextCursor, Attribution: Attribution, Freshness: s.freshness(nil)}
	var newest time.Time
	for _, it := range page.Items {
		if it.LastNavDate == nil {
			continue
		}
		if t, perr := time.Parse(time.DateOnly, *it.LastNavDate); perr == nil && t.After(newest) {
			newest = t
		}
	}
	if !newest.IsZero() {
		res.Freshness = s.freshness(&newest)
	}
	if p.Group {
		res.Items = GroupItems(page.Items)
	} else {
		res.Items = page.Items
	}
	return res, nil
}

// Categories lists the distinct categories of active schemes.
func (s *Service) Categories(ctx context.Context) ([]string, error) {
	rows, err := s.q.ListMFCategories(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.String)
	}
	return out, nil
}

// ---- detail ----

type cachedMetrics struct {
	EndDate         string              `json:"end_date"`
	EndNav          float64             `json:"end_nav"`
	FirstNavDate    string              `json:"first_nav_date"`
	Returns         map[string]*float64 `json:"returns"`
	ReturnReasons   map[string]string   `json:"return_reasons"`
	Volatility      *float64            `json:"volatility"`
	VolatilityRsn   *string             `json:"volatility_reason"`
	VolatilityYears *float64            `json:"volatility_years"`
	MaxDrawdown     *float64            `json:"max_drawdown"`
	SharpeLike      *float64            `json:"sharpe_like"`
	SharpeReason    *string             `json:"sharpe_reason"`
	RiskFreeRate    *float64            `json:"risk_free_rate"`
	Rolling1Y       json.RawMessage     `json:"rolling_1y"`
	NavJumps        json.RawMessage     `json:"nav_jumps"`
}

// ReasonNoNavYet is the null reason for every figure of a scheme with no NAV rows.
const ReasonNoNavYet = "no_nav_yet"

var returnKeys = []string{"1m", "3m", "6m", "ytd", "1y", "3y", "5y", "since"}

// LatestNav is a NAV with its own date (INR per unit).
type LatestNav struct {
	Value float64 `json:"value"`
	Date  string  `json:"date"`
	Unit  string  `json:"unit"`
}

// Risk is the risk block (percent figures; null with a reason when not computable).
type Risk struct {
	VolatilityPct    *float64 `json:"volatility_pct"`
	VolatilityReason *string  `json:"volatility_reason"`
	VolatilityYears  *float64 `json:"volatility_years"`
	MaxDrawdownPct   *float64 `json:"max_drawdown_pct"`
	SharpeLike       *float64 `json:"sharpe_like"`
	SharpeReason     *string  `json:"sharpe_reason"`
	RiskFreeRatePct  *float64 `json:"risk_free_rate"`
}

// Detail is `data` of GET /mf/schemes/{code}.
type Detail struct {
	Code            int32               `json:"code"`
	Name            string              `json:"name"`
	FundHouse       *string             `json:"fund_house"`
	SchemeType      *string             `json:"scheme_type"`
	Category        *string             `json:"category"`
	Plan            string              `json:"plan"`
	Option          string              `json:"option"`
	IsinGrowth      *string             `json:"isin_growth"`
	IsinDivReinvest *string             `json:"isin_div_reinvest"`
	Status          string              `json:"status"`
	Tracked         bool                `json:"tracked"`
	FirstNavDate    *string             `json:"first_nav_date"`
	NavCount        int64               `json:"nav_count"`
	LatestNav       *LatestNav          `json:"latest_nav"`
	Returns         map[string]*float64 `json:"returns"`        // r_* keys, percent
	ReturnBasis     map[string]string   `json:"return_basis"`   // cagr | absolute
	ReturnReasons   map[string]string   `json:"return_reasons"` // why a return is null
	Risk            *Risk               `json:"risk"`
	Rolling1Y       json.RawMessage     `json:"rolling_1y"`
	NavJumps        json.RawMessage     `json:"nav_jumps"`
	MetricsAsOf     *string             `json:"metrics_as_of"`
	Units           map[string]string   `json:"units"`
	Backfill        *Backfill           `json:"backfill"`
	Attribution     string              `json:"attribution"`
}

// DetailResult adds the envelope pieces.
type DetailResult struct {
	Detail    Detail
	Warnings  []Warning
	Freshness Freshness
}

func (s *Service) scheme(ctx context.Context, code int32) (dbq.GetMFSchemeRow, error) {
	row, err := s.q.GetMFScheme(ctx, code)
	if errors.Is(err, pgx.ErrNoRows) {
		return row, s.notFound(ctx, code)
	}
	return row, err
}

// notFound builds the 404 with suggestions (B10-4): active schemes sharing the first 4 digits.
func (s *Service) notFound(ctx context.Context, code int32) error {
	nf := &NotFoundError{Code: code, Suggestions: []Suggestion{}}
	digits := strconv.Itoa(int(code))
	if len(digits) > 4 {
		digits = digits[:4]
	}
	if rows, err := s.q.SuggestMFSchemes(ctx, digits); err == nil {
		for _, r := range rows {
			nf.Suggestions = append(nf.Suggestions, Suggestion{Code: r.Code, Name: r.Name})
		}
	}
	return nf
}

// Detail returns the scheme page (docs/03 section 10): meta, latest NAV, the cached return table
// and risk figures, warnings, and the backfill block when no NAV rows exist yet. It stamps
// last_opened_at.
func (s *Service) Detail(ctx context.Context, code int32) (DetailResult, error) {
	sc, err := s.scheme(ctx, code)
	if err != nil {
		return DetailResult{}, err
	}
	if err := s.q.TouchMFSchemeOpened(ctx, code); err != nil {
		return DetailResult{}, err
	}
	stats, err := s.q.GetMFNavStats(ctx, code)
	if err != nil {
		return DetailResult{}, err
	}
	d := Detail{
		Code: sc.Code, Name: sc.Name, FundHouse: text(sc.FundHouse), SchemeType: text(sc.SchemeType),
		Category: text(sc.Category), Plan: unknownAs(sc.Plan), Option: unknownAs(sc.OptionType),
		IsinGrowth: text(sc.IsinGrowth), IsinDivReinvest: text(sc.IsinDivReinvest), Status: sc.Status,
		Tracked: sc.IsTracked, NavCount: stats.NavCount, FirstNavDate: dateStr(stats.FirstNavDate),
		Returns: map[string]*float64{}, ReturnBasis: map[string]string{}, ReturnReasons: map[string]string{},
		Units: map[string]string{
			"nav": "INR per unit", "returns": "percent", "volatility_pct": "percent",
			"max_drawdown_pct": "percent", "sharpe_like": "ratio",
		},
		Attribution: Attribution,
	}
	var warns []Warning
	var last *time.Time
	if stats.NavCount == 0 {
		d.Backfill = &Backfill{Status: "none"}
		if s.Backfill != nil {
			if bf, err := s.Backfill.EnqueueMFRefresh(ctx, code); err == nil {
				d.Backfill = &bf
			}
		}
		for _, k := range returnKeys {
			d.Returns["r_"+k] = nil
			d.ReturnReasons["r_"+k] = ReasonNoNavYet
		}
		warns = append(warns, Warning{"NO_NAV_DATA", "No NAV history is stored for this scheme yet; a refresh has been requested."})
		return DetailResult{Detail: d, Warnings: warns, Freshness: s.freshness(nil)}, nil
	}
	latest, err := s.q.GetMFLatestNav(ctx, code)
	if err != nil {
		return DetailResult{}, err
	}
	lt := latest.NavDate.Time
	last = &lt
	d.LatestNav = &LatestNav{Value: latest.Nav, Date: lt.Format(time.DateOnly), Unit: "INR per unit"}

	cache, err := s.q.GetMFReturnCache(ctx, code)
	switch {
	case errors.Is(err, pgx.ErrNoRows):
		warns = append(warns, Warning{"METRICS_PENDING", "Returns and risk figures have not been computed yet."})
		for _, k := range returnKeys {
			d.Returns["r_"+k] = nil
			d.ReturnReasons["r_"+k] = "not_computed"
		}
	case err != nil:
		return DetailResult{}, err
	default:
		var m cachedMetrics
		if err := json.Unmarshal(cache.Metrics, &m); err != nil {
			return DetailResult{}, fmt.Errorf("mf_return_cache.metrics for %d: %w", code, err)
		}
		d.MetricsAsOf = dateStr(cache.AsOf)
		sinceCAGR := false
		if fd, e1 := time.Parse(time.DateOnly, m.FirstNavDate); e1 == nil {
			if ed, e2 := time.Parse(time.DateOnly, m.EndDate); e2 == nil {
				sinceCAGR = !fd.After(SubtractMonths(ed, 12))
			}
		}
		for _, k := range returnKeys {
			key := "r_" + k
			v := m.Returns[k]
			d.Returns[key] = v // null stays null: never 0 for unknown (MF-04)
			if v == nil {
				if r, ok := m.ReturnReasons[k]; ok {
					d.ReturnReasons[key] = r
				} else {
					d.ReturnReasons[key] = "insufficient_history"
				}
			}
			switch k {
			case "1y", "3y", "5y":
				d.ReturnBasis[key] = "cagr"
			case "since":
				d.ReturnBasis[key] = map[bool]string{true: "cagr", false: "absolute"}[sinceCAGR]
			default:
				d.ReturnBasis[key] = "absolute"
			}
		}
		d.Risk = &Risk{
			VolatilityPct: m.Volatility, VolatilityReason: m.VolatilityRsn, VolatilityYears: m.VolatilityYears,
			MaxDrawdownPct: m.MaxDrawdown, SharpeLike: m.SharpeLike, SharpeReason: m.SharpeReason,
			RiskFreeRatePct: m.RiskFreeRate,
		}
		d.Rolling1Y, d.NavJumps = m.Rolling1Y, m.NavJumps
	}
	if sc.OptionType.String == "idcw" {
		warns = append(warns, Warning{"IDCW_NOT_COMPARABLE",
			"Returns are computed from NAV and exclude IDCW payouts, so they are not comparable with Growth plans."})
	}
	if sc.Status == "inactive" || s.Now().Sub(lt) > mergedAfterDays*24*time.Hour {
		warns = append(warns, Warning{"SCHEME_MAY_BE_MERGED", "No recent NAV: this scheme may be merged or closed."})
	}
	return DetailResult{Detail: d, Warnings: warns, Freshness: s.freshness(last)}, nil
}

// ---- NAV series ----

// NavSeries is `data` of GET /mf/schemes/{code}/nav.
type NavSeries struct {
	Code        int32   `json:"code"`
	Range       string  `json:"range"`
	Log         bool    `json:"log"`
	Unit        string  `json:"unit"`
	Points      [][]any `json:"points"` // [date, nav]
	RawCount    int     `json:"raw_count"`
	Downsampled bool    `json:"downsampled"`
	Attribution string  `json:"attribution"`
}

var minDate = time.Date(1900, 1, 1, 0, 0, 0, 0, time.UTC)

func (s *Service) loadNavs(ctx context.Context, code int32, from, to time.Time) ([]NavPoint, error) {
	if from.IsZero() {
		from = minDate
	}
	rows, err := s.q.ListMFNavRange(ctx, dbq.ListMFNavRangeParams{SchemeCode: code, NavDate: pgDate(from), NavDate_2: pgDate(to)})
	if err != nil {
		return nil, err
	}
	out := make([]NavPoint, len(rows))
	for i, r := range rows {
		out[i] = NavPoint{Date: r.NavDate.Time, NAV: r.Nav}
	}
	return out, nil
}

// lastNavDate checks the scheme exists and has NAVs, returning its latest NAV date.
func (s *Service) lastNavDate(ctx context.Context, code int32) (dbq.GetMFSchemeRow, dbq.GetMFNavStatsRow, error) {
	sc, err := s.scheme(ctx, code)
	if err != nil {
		return sc, dbq.GetMFNavStatsRow{}, err
	}
	st, err := s.q.GetMFNavStats(ctx, code)
	if err != nil {
		return sc, st, err
	}
	if st.NavCount == 0 {
		return sc, st, &NoDataError{Code: code}
	}
	return sc, st, nil
}

// NAV returns the series for the range ending at the scheme's latest NAV date, downsampled to at
// most MaxPoints. `log` only labels the requested axis scale; values are never transformed (B10-5).
func (s *Service) NAV(ctx context.Context, code int32, rng string, logScale bool) (NavSeries, Freshness, error) {
	_, st, err := s.lastNavDate(ctx, code)
	if err != nil {
		return NavSeries{}, Freshness{}, err
	}
	end := st.LastNavDate.Time
	start, _ := RangeStart(rng, end)
	navs, err := s.loadNavs(ctx, code, start, end)
	if err != nil {
		return NavSeries{}, Freshness{}, err
	}
	out := Downsample(navs, MaxPoints)
	pts := make([][]any, len(out))
	for i, p := range out {
		pts[i] = []any{p.Date.Format(time.DateOnly), p.NAV}
	}
	return NavSeries{
		Code: code, Range: rng, Log: logScale, Unit: "INR per unit", Points: pts,
		RawCount: len(navs), Downsampled: len(out) < len(navs), Attribution: Attribution,
	}, s.freshness(&end), nil
}

// ---- SIP ----

// SIPInstallment is one executed installment (units as a decimal string).
type SIPInstallment struct {
	Date    string  `json:"date"`
	NavDate string  `json:"nav_date"`
	NAV     float64 `json:"nav"`
	Units   string  `json:"units"`
}

// SIPResponse is `data` of GET /mf/schemes/{code}/sip. Money fields are strings (INR).
type SIPResponse struct {
	Code         int32             `json:"code"`
	Amount       string            `json:"amount"`
	Start        string            `json:"start"`
	End          string            `json:"end"`
	Day          int               `json:"day"`
	Invested     string            `json:"invested"`
	Value        *string           `json:"value"`
	Units        string            `json:"units"`
	AbsReturnPct *float64          `json:"absolute_return_pct"`
	XIRRPct      *float64          `json:"xirr_pct"`
	XIRRReason   *string           `json:"xirr_reason"`
	Installments int               `json:"installments"`
	Skipped      int               `json:"skipped_installments"`
	EndNavDate   *string           `json:"end_nav_date"`
	EndNAV       *float64          `json:"end_nav"`
	Schedule     []SIPInstallment  `json:"schedule"`
	UnitLabels   map[string]string `json:"unit_labels"`
	Attribution  string            `json:"attribution"`
}

// SIP simulates a monthly SIP (docs/05 section 9.4). An `end` after the latest NAV date is clamped
// to it with warning END_CLAMPED.
func (s *Service) SIP(ctx context.Context, code int32, p SIPParams) (SIPResponse, []Warning, Freshness, error) {
	sc, st, err := s.lastNavDate(ctx, code)
	if err != nil {
		return SIPResponse{}, nil, Freshness{}, err
	}
	latest := st.LastNavDate.Time
	end := latest
	var warns []Warning
	if p.End != nil {
		if p.End.After(latest) {
			warns = append(warns, Warning{"END_CLAMPED", "End date is after the latest NAV (" + latest.Format(time.DateOnly) + "); the simulation ends there."})
		} else {
			end = *p.End
		}
	}
	navs, err := s.loadNavs(ctx, code, time.Time{}, latest)
	if err != nil {
		return SIPResponse{}, nil, Freshness{}, err
	}
	res := SimulateSIP(navs, SIPInput{Amount: p.Amount, Start: p.Start, End: end, Day: p.Day})
	out := SIPResponse{
		Code: code, Amount: p.Amount.StringFixed(2), Start: p.Start.Format(time.DateOnly), End: end.Format(time.DateOnly),
		Day: p.Day, Invested: res.Invested.StringFixed(2), Units: res.Units.StringFixed(4),
		AbsReturnPct: res.AbsReturnPct, XIRRPct: res.XIRRPct, Installments: len(res.Installments),
		Skipped: res.Skipped, EndNAV: res.EndNAV, Schedule: make([]SIPInstallment, 0, len(res.Installments)),
		UnitLabels:  map[string]string{"money": "INR", "returns": "percent", "nav": "INR per unit"},
		Attribution: Attribution,
	}
	if res.Value != nil {
		v := res.Value.StringFixed(2)
		out.Value = &v
	}
	if res.EndNavDate != nil {
		e := res.EndNavDate.Format(time.DateOnly)
		out.EndNavDate = &e
	}
	if res.XIRRPct == nil && res.XIRRReason != "" {
		out.XIRRReason = &res.XIRRReason
	}
	for _, in := range res.Installments {
		out.Schedule = append(out.Schedule, SIPInstallment{
			Date: in.Date.Format(time.DateOnly), NavDate: in.NavDate.Format(time.DateOnly), NAV: in.NAV,
			Units: in.Units.StringFixed(4),
		})
	}
	if res.Skipped > 0 {
		warns = append(warns, Warning{"INSTALLMENTS_SKIPPED", fmt.Sprintf("%d installment(s) fall before the first NAV (%s) or have no NAV on or before the end date to execute at, and were skipped.", res.Skipped, navs[0].Date.Format(time.DateOnly))})
	}
	if len(res.Installments) == 0 {
		warns = append(warns, Warning{"NO_INSTALLMENTS", "No installment could be executed in this period."})
	}
	if sc.OptionType.String == "idcw" {
		warns = append(warns, Warning{"IDCW_NOT_MODELLED", "IDCW payouts are not modelled in this simulation."})
	}
	return out, warns, s.freshness(&latest), nil
}

// ---- compare ----

// CompareRow is one line of the compare table (percent figures).
type CompareRow struct {
	Code             int32    `json:"code"`
	Name             string   `json:"name"`
	FirstNavDate     string   `json:"first_nav_date"`
	HistoryShorter   bool     `json:"history_shorter_than_range"`
	ReturnPct        *float64 `json:"return_pct"`
	ReturnBasis      string   `json:"return_basis"`
	VolatilityPct    *float64 `json:"volatility_pct"`
	VolatilityReason *string  `json:"volatility_reason"`
	MaxDrawdownPct   *float64 `json:"max_drawdown_pct"`
}

// CompareSeries is one rebased line: [date, value] with 100 at the common start.
type CompareSeries struct {
	Code   int32   `json:"code"`
	Name   string  `json:"name"`
	Points [][]any `json:"points"`
}

// CompareResponse is `data` of GET /mf/compare.
type CompareResponse struct {
	Range           string            `json:"range"`
	CommonStart     string            `json:"common_start"`
	CommonEnd       string            `json:"common_end"`
	Base            int               `json:"base"`
	DifferentStarts bool              `json:"different_starts"`
	Series          []CompareSeries   `json:"series"`
	Table           []CompareRow      `json:"table"`
	Units           map[string]string `json:"units"`
	Attribution     string            `json:"attribution"`
}

// Compare rebases 2-5 schemes to 100 at the first date on which all have a NAV inside the window
// (the window is the range ending at the earliest of their latest NAV dates). `different_starts`
// is true when schemes' own first NAV dates in the window differ (MF-14).
func (s *Service) Compare(ctx context.Context, codes []int32, rng string) (CompareResponse, []Warning, Freshness, error) {
	type info struct {
		sc dbq.GetMFSchemeRow
		st dbq.GetMFNavStatsRow
	}
	infos := make([]info, len(codes))
	var commonEnd time.Time
	for i, c := range codes {
		sc, st, err := s.lastNavDate(ctx, c)
		if err != nil {
			return CompareResponse{}, nil, Freshness{}, err
		}
		infos[i] = info{sc, st}
		if e := st.LastNavDate.Time; commonEnd.IsZero() || e.Before(commonEnd) {
			commonEnd = e
		}
	}
	start, _ := RangeStart(rng, commonEnd)
	series := make([][]NavPoint, len(codes))
	for i, c := range codes {
		navs, err := s.loadNavs(ctx, c, start, commonEnd)
		if err != nil {
			return CompareResponse{}, nil, Freshness{}, err
		}
		series[i] = navs
	}
	common := CommonDates(series)
	if len(common) < 2 {
		return CompareResponse{}, nil, Freshness{}, &NoCommonDatesError{}
	}
	cs := common[0]
	out := CompareResponse{
		Range: rng, CommonStart: cs.Format(time.DateOnly), CommonEnd: common[len(common)-1].Format(time.DateOnly),
		Base: 100, Units: map[string]string{"series": "index (100 at common start)", "returns": "percent"},
		Attribution: Attribution,
	}
	var warns []Warning
	for i, c := range codes {
		own := series[i]
		if !own[0].Date.Equal(cs) {
			out.DifferentStarts = true
		}
		vals := Rebase(own, common)
		pts := make([]NavPoint, len(common))
		for j, dt := range common {
			pts[j] = NavPoint{Date: dt, NAV: vals[j]}
		}
		sampled := Downsample(pts, MaxPoints)
		cser := CompareSeries{Code: c, Name: infos[i].sc.Name, Points: make([][]any, len(sampled))}
		for j, p := range sampled {
			cser.Points[j] = []any{p.Date.Format(time.DateOnly), p.NAV}
		}
		out.Series = append(out.Series, cser)

		st := ComputeStats(own[onOrAfter(own, cs):])
		row := CompareRow{
			Code: c, Name: infos[i].sc.Name, FirstNavDate: infos[i].st.FirstNavDate.Time.Format(time.DateOnly),
			HistoryShorter: !start.IsZero() && infos[i].st.FirstNavDate.Time.After(start),
			ReturnPct:      st.ReturnPct, ReturnBasis: st.ReturnBasis, VolatilityPct: st.VolatilityPct,
			MaxDrawdownPct: st.MaxDrawdownPct,
		}
		if st.VolatilityNote != "" {
			n := st.VolatilityNote
			row.VolatilityReason = &n
		}
		out.Table = append(out.Table, row)
		if infos[i].sc.OptionType.String == "idcw" {
			warns = append(warns, Warning{"IDCW_NOT_COMPARABLE", fmt.Sprintf("Scheme %d pays IDCW; its NAV returns exclude payouts and are not comparable with Growth plans.", c)})
		}
	}
	if out.DifferentStarts {
		warns = append(warns, Warning{"DIFFERENT_STARTS", "Schemes start on different dates; all are rebased to 100 at the first common date (" + out.CommonStart + ")."})
	}
	end := commonEnd
	return out, warns, s.freshness(&end), nil
}
