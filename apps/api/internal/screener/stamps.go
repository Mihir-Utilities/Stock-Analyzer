package screener

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
)

// Staleness limits (docs/03 section 1): owner-entered fundamentals older than 120 days since the
// last entry; shareholding more than 135 days after the last quarter end.
const (
	FundamentalsStaleDays = 120
	ShareholdingStaleDays = 135
)

// Stale reasons.
const (
	StaleNoOwnerData     = "no_owner_data"
	StaleFundamentals    = "fundamentals_older_than_120_days"
	StaleShareholding    = "shareholding_older_than_135_days"
	updatedSourceFund    = "fundamentals"
	updatedSourceHolding = "shareholding"
)

var ist = time.FixedZone("IST", 5*3600+1800)

// Stamp is the per-stock "last updated" stamp of owner-entered data (decision D-R). Derived values
// (source `derived`) never count: they say when the worker ran, not when the owner entered data.
type Stamp struct {
	LastUpdated       *string `json:"last_updated"`        // IST date of the newest owner entry
	LastUpdatedSource *string `json:"last_updated_source"` // fundamentals | shareholding
	Stale             bool    `json:"stale"`
	StaleReason       *string `json:"stale_reason"`
}

type rawStamp struct {
	fund    *time.Time
	hold    *time.Time
	holdQtr *time.Time // latest shareholding quarter end
}

func istDate(t time.Time) time.Time {
	l := t.In(ist)
	return time.Date(l.Year(), l.Month(), l.Day(), 0, 0, 0, 0, time.UTC)
}

func (r rawStamp) stamp(now time.Time) Stamp {
	var s Stamp
	if r.fund == nil && r.hold == nil {
		reason := StaleNoOwnerData
		s.Stale, s.StaleReason = true, &reason
		return s
	}
	newest, src := r.fund, updatedSourceFund
	if r.fund == nil || (r.hold != nil && r.hold.After(*r.fund)) {
		newest, src = r.hold, updatedSourceHolding
	}
	d := istDate(*newest).Format(time.DateOnly)
	s.LastUpdated, s.LastUpdatedSource = &d, &src
	today := istDate(now)
	if r.fund != nil && int(today.Sub(istDate(*r.fund)).Hours()/24) > FundamentalsStaleDays {
		reason := StaleFundamentals
		s.Stale, s.StaleReason = true, &reason
	} else if r.holdQtr != nil && int(today.Sub(*r.holdQtr).Hours()/24) > ShareholdingStaleDays {
		reason := StaleShareholding
		s.Stale, s.StaleReason = true, &reason
	}
	return s
}

// stamps loads the owner-data stamps for the given instruments in two queries.
func (s *Service) stamps(ctx context.Context, ids []int32) (map[int32]Stamp, error) {
	raw := map[int32]*rawStamp{}
	get := func(id int32) *rawStamp {
		r := raw[id]
		if r == nil {
			r = &rawStamp{}
			raw[id] = r
		}
		return r
	}
	if len(ids) > 0 {
		rows, err := s.db.Query(ctx,
			`SELECT instrument_id, max(fetched_at) FROM fundamental_value
			 WHERE instrument_id = ANY($1::int[]) AND source <> 'derived' GROUP BY instrument_id`, ids)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int32
			var t pgtype.Timestamptz
			if err := rows.Scan(&id, &t); err != nil {
				rows.Close()
				return nil, err
			}
			if t.Valid {
				v := t.Time
				get(id).fund = &v
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		rows, err = s.db.Query(ctx,
			`SELECT instrument_id, max(fetched_at), max(quarter_end) FROM shareholding
			 WHERE instrument_id = ANY($1::int[]) GROUP BY instrument_id`, ids)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int32
			var t pgtype.Timestamptz
			var q pgtype.Date
			if err := rows.Scan(&id, &t, &q); err != nil {
				rows.Close()
				return nil, err
			}
			if t.Valid {
				v := t.Time
				get(id).hold = &v
			}
			if q.Valid {
				v := q.Time
				get(id).holdQtr = &v
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	now := s.Now()
	out := make(map[int32]Stamp, len(ids))
	for _, id := range ids {
		var r rawStamp
		if p := raw[id]; p != nil {
			r = *p
		}
		out[id] = r.stamp(now)
	}
	return out, nil
}
