package screener

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Peer selection (docs/05 section 7).
const (
	DefaultPeerLimit = 8
	MaxPeerOverrides = 10
	minPeers         = 4
	NoteFewPeers     = "few comparable peers"
)

// PeerMetrics are the columns of the peer table, in documentation order (docs/03 section 5).
var PeerMetrics = []string{"market_cap_cr", "ret_1y", "pe", "pb", "roe", "rev_growth_3y", "op_margin", "debt_equity"}

// PeerParams are the validated query parameters of GET /stocks/{symbol}/peers.
type PeerParams struct {
	Limit  int
	Add    []string
	Remove []string
}

// ParsePeers validates `limit`, `add` and `remove` (temporary overrides, never persisted).
func ParsePeers(q url.Values) (PeerParams, error) {
	var fe fieldErrs
	p := PeerParams{Limit: DefaultPeerLimit}
	if raw := strings.TrimSpace(q.Get("limit")); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 1 {
			fe.add("limit", "must be a positive integer")
		} else {
			p.Limit = min(n, 200)
		}
	}
	list := func(field string) []string {
		var out []string
		seen := map[string]bool{}
		items := splitList(q.Get(field))
		if len(items) > MaxPeerOverrides {
			fe.add(field, fmt.Sprintf("at most %d symbols are allowed", MaxPeerOverrides))
			items = items[:MaxPeerOverrides]
		}
		for _, x := range items {
			if !ValidSymbol(x) {
				fe.add(field, "contains an invalid symbol")
				return out
			}
			u := strings.ToUpper(x)
			if !seen[u] {
				seen[u] = true
				out = append(out, u)
			}
		}
		return out
	}
	p.Add, p.Remove = list("add"), list("remove")
	for _, a := range p.Add {
		for _, r := range p.Remove {
			if a == r {
				fe.add("remove", "must not repeat a symbol listed in add")
			}
		}
	}
	return p, fe.err()
}

// PeerRow is one row of the peer table (and `self`). Missing values are null with a reason.
type PeerRow struct {
	Symbol         string              `json:"symbol"`
	Name           string              `json:"name"`
	Origin         string              `json:"origin"` // self | auto | added
	MarketCapCr    *float64            `json:"market_cap_cr"`
	Ret1Y          *float64            `json:"ret_1y"`
	PE             *float64            `json:"pe"`
	PB             *float64            `json:"pb"`
	ROE            *float64            `json:"roe"`
	RevGrowth3Y    *float64            `json:"rev_growth_3y"`
	OpMargin       *float64            `json:"op_margin"`
	DebtEquity     *float64            `json:"debt_equity"`
	ValueReasons   map[string]string   `json:"value_reasons"`
	PercentileRank map[string]*float64 `json:"percentile_rank"`
	AsOf           *string             `json:"as_of"`
	Stamp
}

// PeersResult is the data of GET /stocks/{symbol}/peers.
type PeersResult struct {
	Symbol     string            `json:"symbol"`
	Sector     *string           `json:"sector"`
	Industry   *string           `json:"industry"`
	Basis      string            `json:"basis"` // industry | sector (the candidate pool used)
	CapBand    string            `json:"market_cap_band"`
	Note       *string           `json:"note"`
	Units      map[string]string `json:"units"`
	Peers      []PeerRow         `json:"peers"`
	Self       PeerRow           `json:"self"`
	Percentile string            `json:"percentile_method"`

	AsOf     time.Time `json:"-"`
	Redirect string    `json:"-"` // set when the symbol is an old alias
}

type peerCand struct {
	ref  instRef
	mcap float64
	data rowData
}

func numeric(m map[string]any, k string) *float64 {
	if v, ok := metricValue(k, m); ok {
		f := v.(float64)
		return &f
	}
	return nil
}

func nz(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// Peers builds the peer table for one stock (docs/05 section 7; assumptions B13-1..B13-3).
func (s *Service) Peers(ctx context.Context, symbol string, p PeerParams) (PeersResult, error) {
	self, err := s.resolve(ctx, symbol)
	if err != nil {
		return PeersResult{}, err
	}
	if self.ViaAlias {
		return PeersResult{Redirect: self.Symbol}, nil // docs/03 section 1: alias answers with the new symbol
	}
	if self.Sector == "" && self.Industry == "" {
		return PeersResult{}, &NoDataError{Reason: "no_sector_data"}
	}
	selfRows, err := s.metricsFor(ctx, []int32{self.ID})
	if err != nil {
		return PeersResult{}, err
	}
	selfData, ok := selfRows[self.ID]
	var selfCap float64
	if ok {
		if c := numeric(selfData.metrics, "market_cap_cr"); c != nil && *c > 0 {
			selfCap = *c
		}
	}
	if selfCap <= 0 {
		return PeersResult{}, &NoDataError{Reason: "no_market_cap"}
	}

	removed := map[string]bool{}
	for _, r := range p.Remove {
		removed[r] = true
	}
	cands, err := s.peerCandidates(ctx, self)
	if err != nil {
		return PeersResult{}, err
	}
	pool := cands[:0:0]
	for _, c := range cands {
		if !removed[strings.ToUpper(c.ref.Symbol)] {
			pool = append(pool, c)
		}
	}
	// Step 1-2: same industry; fewer than 4 candidates widens to the same sector.
	basis := "industry"
	chosen := filterCands(pool, func(c peerCand) bool { return self.Industry != "" && strings.EqualFold(c.ref.Industry, self.Industry) })
	if len(chosen) < minPeers {
		basis = "sector"
		chosen = filterCands(pool, func(c peerCand) bool {
			return (self.Sector != "" && strings.EqualFold(c.ref.Sector, self.Sector)) ||
				(self.Industry != "" && strings.EqualFold(c.ref.Industry, self.Industry))
		})
	}
	// Step 3: market cap ratio within [0.25, 4], else [0.1, 10].
	band := "0.25-4"
	inBand := func(lo, hi float64) []peerCand {
		return filterCands(chosen, func(c peerCand) bool { r := c.mcap / selfCap; return r >= lo && r <= hi })
	}
	picked := inBand(0.25, 4)
	if len(picked) < minPeers {
		band = "0.1-10"
		picked = inBand(0.1, 10)
	}
	var note *string
	if len(picked) < minPeers {
		n := NoteFewPeers
		note = &n
	}
	// Step 4: rank by |ln(mcap / mcap_self)|, ties by symbol.
	sort.SliceStable(picked, func(i, j int) bool {
		di, dj := math.Abs(math.Log(picked[i].mcap/selfCap)), math.Abs(math.Log(picked[j].mcap/selfCap))
		if di != dj {
			return di < dj
		}
		return picked[i].ref.Symbol < picked[j].ref.Symbol
	})
	if len(picked) > p.Limit {
		picked = picked[:p.Limit]
	}
	type member struct {
		ref    instRef
		data   rowData
		hasRow bool
		origin string
	}
	members := []member{{self, selfData, true, "self"}}
	have := map[int32]bool{self.ID: true}
	for _, c := range picked {
		members = append(members, member{c.ref, c.data, true, "auto"})
		have[c.ref.ID] = true
	}
	var addIDs []int32
	var added []instRef
	for _, a := range p.Add {
		ref, err := s.resolve(ctx, a)
		if err != nil {
			var nf *NotFoundError
			if errors.As(err, &nf) {
				return PeersResult{}, &ValidationError{Fields: []FieldError{{"add", "unknown symbol " + nf.Symbol}}}
			}
			return PeersResult{}, err
		}
		if ref.ID == self.ID {
			return PeersResult{}, &ValidationError{Fields: []FieldError{{"add", "must not include the stock itself"}}}
		}
		if have[ref.ID] {
			continue
		}
		have[ref.ID] = true
		added = append(added, ref)
		addIDs = append(addIDs, ref.ID)
	}
	addRows, err := s.metricsFor(ctx, addIDs)
	if err != nil {
		return PeersResult{}, err
	}
	for _, ref := range added {
		d, ok := addRows[ref.ID]
		members = append(members, member{ref, d, ok, "added"})
	}

	ids := make([]int32, len(members))
	for i, m := range members {
		ids[i] = m.ref.ID
	}
	st, err := s.stamps(ctx, ids)
	if err != nil {
		return PeersResult{}, err
	}
	// Step 5: percentile of each metric among peers + self.
	vals := make([]map[string]*float64, len(members))
	for i, m := range members {
		vals[i] = map[string]*float64{}
		for _, k := range PeerMetrics {
			vals[i][k] = numeric(m.data.metrics, k)
		}
	}
	rows := make([]PeerRow, len(members))
	for i, m := range members {
		r := PeerRow{Symbol: m.ref.Symbol, Name: m.ref.Name, Origin: m.origin, Stamp: st[m.ref.ID],
			ValueReasons: map[string]string{}, PercentileRank: map[string]*float64{}}
		if m.hasRow {
			d := m.data.asOf.Format(time.DateOnly)
			r.AsOf = &d
		}
		r.MarketCapCr, r.Ret1Y, r.PE, r.PB = vals[i]["market_cap_cr"], vals[i]["ret_1y"], vals[i]["pe"], vals[i]["pb"]
		r.ROE, r.RevGrowth3Y, r.OpMargin, r.DebtEquity = vals[i]["roe"], vals[i]["rev_growth_3y"], vals[i]["op_margin"], vals[i]["debt_equity"]
		for _, k := range PeerMetrics {
			if vals[i][k] == nil {
				if m.hasRow {
					r.ValueReasons[k] = reasonNotAvailable
				} else {
					r.ValueReasons[k] = "no_screener_row"
				}
			}
			r.PercentileRank[k] = percentile(vals, i, k)
		}
		rows[i] = r
	}
	units := map[string]string{}
	for _, k := range PeerMetrics {
		units[k] = Unit(k)
	}
	return PeersResult{
		Symbol: self.Symbol, Sector: nz(self.Sector), Industry: nz(self.Industry), Basis: basis, CapBand: band,
		Note: note, Units: units, Peers: rows[1:], Self: rows[0], AsOf: selfData.asOf,
		Percentile: "percent 0-100; (below + 0.5 x other equal) / (n - 1); n counts peers and self with a value; null when n < 2",
	}, nil
}

func filterCands(in []peerCand, keep func(peerCand) bool) []peerCand {
	out := make([]peerCand, 0, len(in))
	for _, c := range in {
		if keep(c) {
			out = append(out, c)
		}
	}
	return out
}

// peerCandidates loads every active equity with a positive market cap that shares the stock's
// industry or sector (docs/05 section 7 step 1).
func (s *Service) peerCandidates(ctx context.Context, self instRef) ([]peerCand, error) {
	rows, err := s.db.Query(ctx, `
		SELECT i.id, i.symbol, i.name, coalesce(i.sector,''), coalesce(i.industry,''), sr.as_of, sr.metrics
		FROM instrument i JOIN screener_row sr ON sr.instrument_id = i.id
		WHERE i.instrument_kind = 'equity' AND i.status = 'active' AND i.id <> $1
		  AND ((($2::text) <> '' AND lower(i.industry) = lower($2::text))
		    OR (($3::text) <> '' AND lower(i.sector) = lower($3::text)))
		  AND `+byKey["market_cap_cr"].expr+` > 0
		ORDER BY i.symbol`, self.ID, self.Industry, self.Sector)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []peerCand
	for rows.Next() {
		var c peerCand
		var d pgtype.Date
		var raw []byte
		if err := rows.Scan(&c.ref.ID, &c.ref.Symbol, &c.ref.Name, &c.ref.Sector, &c.ref.Industry, &d, &raw); err != nil {
			return nil, err
		}
		c.data = rowData{asOf: d.Time, metrics: map[string]any{}}
		if err := json.Unmarshal(raw, &c.data.metrics); err != nil {
			c.data.metrics = map[string]any{}
		}
		if m := numeric(c.data.metrics, "market_cap_cr"); m != nil && *m > 0 {
			c.mcap = *m
			out = append(out, c)
		}
	}
	return out, rows.Err()
}

// percentile ranks member i on metric k among all members with a value (D05b-4 formula).
func percentile(vals []map[string]*float64, i int, k string) *float64 {
	v := vals[i][k]
	if v == nil {
		return nil
	}
	n, below, equal := 0, 0, 0
	for j := range vals {
		x := vals[j][k]
		if x == nil {
			continue
		}
		n++
		switch {
		case *x < *v:
			below++
		case *x == *v && j != i:
			equal++
		}
	}
	if n < 2 {
		return nil
	}
	p := math.Round((float64(below)+0.5*float64(equal))/float64(n-1)*10000) / 100
	return &p
}
