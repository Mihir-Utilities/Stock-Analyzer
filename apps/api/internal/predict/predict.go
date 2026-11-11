// Package predict serves the experimental prediction read API (docs/03 section 6, docs/05 10.6,
// 10.7). It only reads rows written by the worker's ML jobs (D07). It never computes a forecast, never
// returns a single target price, and shows nothing without an active model that passes its guardrail.
package predict

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/instruments"
)

// Disclaimer is the fixed experimental text (docs/03 section 6).
const Disclaimer = "Experimental. Not investment advice. Statistical models often fail out of sample."

// Hidden-reason enum (docs/03 section 6).
const (
	ReasonNotBetter  = "model_not_better_than_baseline"
	ReasonHistory    = "insufficient_history"
	ReasonLiquidity  = "low_liquidity"
	ReasonNearAction = "near_corporate_action"
	ReasonNoModel    = "no_model"
	ReasonStale      = "stale_data"

	freshTradingDays = 3 // docs/05 10.6: last bar within 3 trading days
)

var reasons = map[string]bool{
	ReasonNotBetter: true, ReasonHistory: true, ReasonLiquidity: true,
	ReasonNearAction: true, ReasonNoModel: true, ReasonStale: true,
}

// Horizons are the forecast horizons in trading days.
var Horizons = []int{5, 21}

// NotFoundError is an unknown symbol (404 NOT_FOUND).
type NotFoundError struct{ Symbol string }

func (e *NotFoundError) Error() string { return "predict: instrument not found" }

var symbolPattern = regexp.MustCompile(`^[A-Za-z0-9&._-]{1,20}$`)

// Service reads predictions.
type Service struct {
	db  dbq.DBTX
	Now func() time.Time
}

// New builds a Service.
func New(db dbq.DBTX) *Service { return &Service{db: db, Now: time.Now} }

// Band is the volatility-scaled return band (fractions) with the matching price levels.
type Band struct {
	Q10      float64  `json:"q10"`
	Q50      float64  `json:"q50"`
	Q90      float64  `json:"q90"`
	PriceQ10 *float64 `json:"price_q10"`
	PriceQ50 *float64 `json:"price_q50"`
	PriceQ90 *float64 `json:"price_q90"`
}

// Horizon is one entry of data.horizons. A hidden horizon carries no numbers, only the reason.
type Horizon struct {
	Days         int          `json:"days"`
	Shown        bool         `json:"shown"`
	PUp          *float64     `json:"p_up,omitempty"`
	Bucket       *string      `json:"bucket,omitempty"`
	Band         *Band        `json:"band,omitempty"`
	HiddenReason *string      `json:"hidden_reason"`
	Model        *ModelCard   `json:"model"`
	TrackRecord  *TrackRecord `json:"track_record"`
}

// ModelCard summarises the active model of a horizon (out-of-fold numbers from the guardrail).
type ModelCard struct {
	Version       string   `json:"version"`
	TrainedAt     string   `json:"trained_at"`
	OOSAUC        *float64 `json:"oos_auc"`
	OOSBrier      *float64 `json:"oos_brier"`
	BaselineBrier *float64 `json:"baseline_brier"`
	Folds         *int     `json:"folds"`
	GuardrailPass bool     `json:"guardrail_pass"`
}

// TrackRecord is the live record of the active direction model (docs/05 10.7). Rates are fractions.
type TrackRecord struct {
	Resolved         int      `json:"resolved"`
	DirectionHitRate *float64 `json:"direction_hit_rate"`
	BandCoverage80   *float64 `json:"band_coverage_80"`
	Since            *string  `json:"since"`
	Reason           *string  `json:"reason,omitempty"`
}

// Score is the rule-based trend or risk score (always shown when data suffices).
type Score struct {
	Score  *float64 `json:"score"`
	Label  *string  `json:"label"`
	Reason *string  `json:"reason,omitempty"`
}

// Result is data of GET /stocks/{symbol}/prediction.
type Result struct {
	Experimental bool         `json:"experimental"`
	Disclaimer   string       `json:"disclaimer"`
	State        string       `json:"state"`
	StateReason  *string      `json:"state_reason"`
	AsOf         *string      `json:"as_of"`
	RefClose     *float64     `json:"ref_close"`
	RefReason    *string      `json:"ref_close_reason,omitempty"`
	Horizons     []Horizon    `json:"horizons"`
	Trend        *Score       `json:"trend"`
	Risk         *Score       `json:"risk"`
	Model        *ModelCard   `json:"model"`
	TrackRecord  *TrackRecord `json:"track_record"`

	Redirect string    `json:"-"`
	Now      time.Time `json:"-"`
}

type runRow struct {
	id        int64
	name      string
	trainedAt time.Time
	valid     map[string]any
	baseline  map[string]any
	guardrail bool
}

type predRow struct {
	asOf     time.Time
	pUp      *float32
	q10      *float32
	q50      *float32
	q90      *float32
	refClose float64
	shown    bool
	reason   *string
}

// Get builds the prediction response for a symbol.
func (s *Service) Get(ctx context.Context, symbol string) (Result, error) {
	id, canonical, viaAlias, err := s.resolve(ctx, symbol)
	if err != nil {
		return Result{}, err
	}
	if viaAlias {
		return Result{Redirect: canonical}, nil
	}
	now := s.Now()
	res := Result{Experimental: true, Disclaimer: Disclaimer, Horizons: []Horizon{}, Now: now}

	anyActive := false
	var newest *predRow
	for _, h := range Horizons {
		hz, pr, active, err := s.horizon(ctx, id, h, now)
		if err != nil {
			return Result{}, err
		}
		anyActive = anyActive || active
		res.Horizons = append(res.Horizons, hz)
		if pr != nil && (newest == nil || pr.asOf.After(newest.asOf)) {
			newest = pr
		}
		if res.Model == nil && hz.Model != nil {
			res.Model, res.TrackRecord = hz.Model, hz.TrackRecord
		}
	}
	if newest != nil {
		d := newest.asOf.Format(time.DateOnly)
		res.AsOf, res.RefClose = &d, ptr(newest.refClose)
	} else {
		res.RefReason = ptr("no_prediction")
	}
	if res.State, res.StateReason, err = s.state(ctx, anyActive, res.Horizons); err != nil {
		return Result{}, err
	}
	if res.Trend, res.Risk, err = s.scores(ctx, id); err != nil {
		return Result{}, err
	}
	return res, nil
}

func ptr[T any](v T) *T { return &v }

func (s *Service) resolve(ctx context.Context, symbol string) (id int32, canonical string, viaAlias bool, err error) {
	if !symbolPattern.MatchString(symbol) {
		return 0, "", false, &NotFoundError{Symbol: symbol}
	}
	err = s.db.QueryRow(ctx, `SELECT id, symbol FROM instrument WHERE upper(symbol) = upper($1::text)
		ORDER BY (symbol = $1::text) DESC, id LIMIT 1`, symbol).Scan(&id, &canonical)
	if errors.Is(err, pgx.ErrNoRows) {
		err = s.db.QueryRow(ctx, `SELECT i.id, i.symbol FROM symbol_alias a JOIN instrument i ON i.id = a.instrument_id
			WHERE upper(a.old_symbol) = upper($1::text) ORDER BY a.changed_on DESC NULLS LAST, a.instrument_id LIMIT 1`,
			symbol).Scan(&id, &canonical)
		viaAlias = err == nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", false, &NotFoundError{Symbol: symbol}
	}
	return id, canonical, viaAlias, err
}

func (s *Service) run(ctx context.Context, where string, args ...any) (*runRow, error) {
	var r runRow
	var valid, base []byte
	err := s.db.QueryRow(ctx, `SELECT id, model_name, trained_at, valid_metrics, baseline_metrics, guardrail_pass
		FROM model_run WHERE `+where, args...).Scan(&r.id, &r.name, &r.trainedAt, &valid, &base, &r.guardrail)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	_ = json.Unmarshal(valid, &r.valid)
	_ = json.Unmarshal(base, &r.baseline)
	return &r, nil
}

func hidden(days int, reason string) Horizon {
	return Horizon{Days: days, Shown: false, HiddenReason: &reason}
}

// horizon builds one horizon. active reports whether an active direction model exists.
func (s *Service) horizon(ctx context.Context, instID int32, h int, now time.Time) (Horizon, *predRow, bool, error) {
	name := "dir_" + strconv.Itoa(h) + "d"
	active, err := s.run(ctx, `model_name = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`, name)
	if err != nil {
		return Horizon{}, nil, false, err
	}
	if active == nil {
		latest, err := s.run(ctx, `model_name = $1 ORDER BY id DESC LIMIT 1`, name)
		if err != nil {
			return Horizon{}, nil, false, err
		}
		switch {
		case latest == nil:
			return hidden(h, ReasonNoModel), nil, false, nil
		case guardrailReason(latest) == "insufficient_folds":
			return hidden(h, ReasonHistory), nil, false, nil
		case !latest.guardrail:
			return hidden(h, ReasonNotBetter), nil, false, nil
		}
		return hidden(h, ReasonNoModel), nil, false, nil
	}

	tr, err := s.trackRecord(ctx, active.id)
	if err != nil {
		return Horizon{}, nil, true, err
	}
	hz := Horizon{Days: h, Model: modelCard(active), TrackRecord: tr}
	var p predRow
	var asOf pgtype.Date
	err = s.db.QueryRow(ctx, `SELECT as_of, p_up, ret_q10, ret_q50, ret_q90, ref_close, shown, hidden_reason
		FROM prediction WHERE instrument_id = $1 AND horizon_days = $2 AND model_run_id = $3
		ORDER BY as_of DESC, id DESC LIMIT 1`, instID, h, active.id).
		Scan(&asOf, &p.pUp, &p.q10, &p.q50, &p.q90, &p.refClose, &p.shown, &p.reason)
	if errors.Is(err, pgx.ErrNoRows) {
		hz.HiddenReason = ptr(ReasonHistory) // no stored prediction: untracked stock or too few bars
		return hz, nil, true, nil
	}
	if err != nil {
		return Horizon{}, nil, true, err
	}
	p.asOf = asOf.Time

	reason := ""
	switch {
	case !p.shown:
		reason = ReasonNotBetter
		if p.reason != nil && reasons[*p.reason] {
			reason = *p.reason
		}
	case !active.guardrail: // the live gate switched the horizon off after the row was stored (ML-07)
		reason = ReasonNotBetter
	case p.pUp == nil || p.q10 == nil || p.q50 == nil || p.q90 == nil:
		reason = ReasonStale
	}
	if reason == "" {
		stale, err := s.isStale(ctx, p.asOf, now)
		if err != nil {
			return Horizon{}, nil, true, err
		}
		if stale {
			reason = ReasonStale
		}
	}
	if reason != "" {
		hz.HiddenReason = &reason
		return hz, &p, true, nil
	}
	// real columns widen to float64 with noise (0.54 -> 0.5400000214): round to 6 places.
	r6 := func(v float32) float64 { return math.Round(float64(v)*1e6) / 1e6 }
	pUp := r6(*p.pUp)
	q10, q50, q90 := r6(*p.q10), r6(*p.q50), r6(*p.q90)
	hz.Shown = true
	hz.PUp = &pUp
	hz.Bucket = ptr(Bucket(pUp))
	hz.Band = &Band{
		Q10: q10, Q50: q50, Q90: q90,
		PriceQ10: price(p.refClose, q10), PriceQ50: price(p.refClose, q50), PriceQ90: price(p.refClose, q90),
	}
	return hz, &p, true, nil
}

// Bucket maps a probability to its label (docs/03 section 6).
func Bucket(p float64) string {
	switch {
	case p < 0.40:
		return "strongly_down"
	case p < 0.47:
		return "slightly_down"
	case p <= 0.53:
		return "neutral"
	case p <= 0.60:
		return "slightly_up"
	}
	return "strongly_up"
}

func price(ref, ret float64) *float64 {
	v := math.Round(ref*(1+ret)*100) / 100
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return nil
	}
	return &v
}

func guardrailReason(r *runRow) string {
	g, _ := r.valid["guardrail"].(map[string]any)
	s, _ := g["reason"].(string)
	return s
}

func num(m map[string]any, keys ...string) *float64 {
	var cur any = m
	for _, k := range keys {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[k]
	}
	f, ok := cur.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

func modelCard(r *runRow) *ModelCard {
	c := &ModelCard{
		Version:       r.name + "@" + r.trainedAt.UTC().Format(time.DateOnly),
		TrainedAt:     r.trainedAt.UTC().Format(time.RFC3339),
		OOSAUC:        num(r.valid, "guardrail", "summary", "auc_mean"),
		OOSBrier:      num(r.valid, "guardrail", "summary", "brier_mean"),
		BaselineBrier: num(r.baseline, "b1_brier_mean"),
		GuardrailPass: r.guardrail,
	}
	if f := num(r.valid, "guardrail", "summary", "folds"); f != nil {
		c.Folds = ptr(int(*f))
	}
	return c
}

func (s *Service) trackRecord(ctx context.Context, runID int64) (*TrackRecord, error) {
	var resolved, dirN, dirHit, bandN, bandHit int
	var since pgtype.Date
	err := s.db.QueryRow(ctx, `SELECT count(o.prediction_id), count(o.direction_correct),
		count(*) FILTER (WHERE o.direction_correct), count(o.in_band), count(*) FILTER (WHERE o.in_band), min(p.as_of)
		FROM prediction p LEFT JOIN prediction_outcome o ON o.prediction_id = p.id
		WHERE p.model_run_id = $1 AND p.p_up IS NOT NULL`, runID).Scan(&resolved, &dirN, &dirHit, &bandN, &bandHit, &since)
	if err != nil {
		return nil, err
	}
	tr := &TrackRecord{Resolved: resolved}
	if since.Valid {
		tr.Since = ptr(since.Time.Format(time.DateOnly))
	}
	if dirN > 0 {
		tr.DirectionHitRate = ptr(float64(dirHit) / float64(dirN))
	}
	if bandN > 0 {
		tr.BandCoverage80 = ptr(float64(bandHit) / float64(bandN))
	}
	if resolved == 0 {
		tr.Reason = ptr("no_resolved_predictions")
	}
	return tr, nil
}

// isStale applies docs/05 10.6: the data used is older than 3 trading days.
func (s *Service) isStale(ctx context.Context, asOf, now time.Time) (bool, error) {
	from := asOf.AddDate(0, 0, -1)
	to := now.In(instruments.IST).AddDate(0, 0, 1)
	rows, err := s.db.Query(ctx, `SELECT holiday_date FROM market_holiday WHERE segment = 'trading'
		AND holiday_date >= $1::date AND holiday_date <= $2::date`, from.Format(time.DateOnly), to.Format(time.DateOnly))
	if err != nil {
		return false, err
	}
	defer rows.Close()
	var hs []time.Time
	for rows.Next() {
		var d pgtype.Date
		if err := rows.Scan(&d); err != nil {
			return false, err
		}
		hs = append(hs, d.Time)
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return TradingDaysBehind(asOf, now, hs) > freshTradingDays, nil
}

// TradingDaysBehind counts trading days after asOf up to the expected last trading date at now
// (weekends and the given holidays are not trading days).
func TradingDaysBehind(asOf, now time.Time, holidays []time.Time) int {
	exp := instruments.NewCalendar(holidays).ExpectedLastTradingDate(now)
	hs := map[string]bool{}
	for _, h := range holidays {
		hs[h.Format(time.DateOnly)] = true
	}
	a := time.Date(asOf.Year(), asOf.Month(), asOf.Day(), 0, 0, 0, 0, time.UTC)
	n := 0
	for d := a.AddDate(0, 0, 1); !d.After(exp) && n < 10000; d = d.AddDate(0, 0, 1) {
		if d.Weekday() != time.Saturday && d.Weekday() != time.Sunday && !hs[d.Format(time.DateOnly)] {
			n++
		}
	}
	return n
}

// state explains why no forecast exists when no horizon has an active model (ML-04).
func (s *Service) state(ctx context.Context, anyActive bool, hz []Horizon) (string, *string, error) {
	if anyActive {
		return "ok", nil, nil
	}
	var status *string
	err := s.db.QueryRow(ctx, `SELECT details->>'status' FROM ingestion_run
		WHERE job = 'train_models' AND status <> 'running' ORDER BY started_at DESC, id DESC LIMIT 1`).Scan(&status)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return "", nil, err
	}
	st := ""
	if status != nil {
		st = strings.TrimSpace(*status)
	}
	switch st {
	case "insufficient_universe":
		return st, ptr("Fewer than 20 stocks have enough price history for the experimental model; forecasts stay hidden."), nil
	case "insufficient_history":
		return st, ptr("Not enough price history for the walk-forward validation; forecasts stay hidden."), nil
	}
	for _, h := range hz {
		if h.HiddenReason != nil && *h.HiddenReason == ReasonNotBetter {
			return "guardrail_failed", ptr("The latest model did not beat the baseline out of sample; forecasts stay hidden."), nil
		}
	}
	return "no_model", ptr("No model has been trained yet; forecasts are not available."), nil
}

func (s *Service) scores(ctx context.Context, id int32) (trend, risk *Score, err error) {
	var raw []byte
	err = s.db.QueryRow(ctx, `SELECT scores FROM analysis_snapshot WHERE instrument_id = $1 ORDER BY as_of DESC LIMIT 1`, id).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		r := "no_analysis"
		return &Score{Reason: &r}, &Score{Reason: &r}, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var m map[string]map[string]any
	_ = json.Unmarshal(raw, &m)
	return scoreOf(m["trend"]), scoreOf(m["risk"]), nil
}

func scoreOf(m map[string]any) *Score {
	sc := &Score{Score: num(m, "score")}
	if l, ok := m["label"].(string); ok && sc.Score != nil {
		sc.Label = &l
	}
	if sc.Score == nil {
		r := "insufficient_history"
		if rs, ok := m["reason"].(string); ok && rs != "" {
			r = rs
		}
		sc.Reason = &r
	}
	return sc
}
