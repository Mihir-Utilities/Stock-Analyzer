package importers

import (
	"context"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// WarnDuplicateExDateAction is the warning code when a confirmed or pending split/bonus already
// exists for the same stock and ex-date (B07R-1, interim): the row is still stored, the worker
// applies only one of them.
const WarnDuplicateExDateAction = "DUPLICATE_EX_DATE_ACTION"

// LockActionDate takes a transaction-scoped advisory lock on (instrument, ex-date) so that a
// manual or CSV insert and a candidate confirm cannot race past each other's duplicate check
// (B07R-1). Callers lock in ascending key order to avoid deadlocks.
func LockActionDate(ctx context.Context, tx pgx.Tx, instID int32, exDate time.Time) error {
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtext('corporate_action_ex_date'), hashtext($1::text))`,
		fmt.Sprintf("%d:%s", instID, exDate.Format(time.DateOnly)))
	return err
}

type actionDayKey struct {
	inst int32
	day  string
}

// lockActionDays locks every split/bonus (instrument, ex-date) of the chunk in a stable order.
func (k *ownerSink) lockActionDays() error {
	seen := map[actionDayKey]time.Time{}
	for _, op := range k.ac {
		if op.N.Type == "split" || op.N.Type == "bonus" {
			seen[actionDayKey{op.Inst, op.N.ExDate.Format(time.DateOnly)}] = op.N.ExDate
		}
	}
	keys := make([]actionDayKey, 0, len(seen))
	for key := range seen {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].inst != keys[j].inst {
			return keys[i].inst < keys[j].inst
		}
		return keys[i].day < keys[j].day
	})
	for _, key := range keys {
		if err := LockActionDate(k.ctx, k.tx, key.inst, seen[key]); err != nil {
			return err
		}
	}
	return nil
}

// DuplicateAction names the other split/bonus row found on an ex-date.
type DuplicateAction struct {
	Symbol string
	ExDate string
	ID     int64
}

// checkDuplicateDays runs after the upsert (so rows of the same file see each other): when two or
// more confirmed or pending split/bonus rows share a (stock, ex-date) it records one hit that
// names the earliest row other than those written by this chunk (the worker applies the earliest).
func (k *ownerSink) checkDuplicateDays(written []int64) error {
	done := map[actionDayKey]bool{}
	mine := map[int64]bool{}
	for _, id := range written {
		mine[id] = true
	}
	for _, op := range k.ac {
		if op.N.Type != "split" && op.N.Type != "bonus" {
			continue
		}
		key := actionDayKey{op.Inst, op.N.ExDate.Format(time.DateOnly)}
		if done[key] {
			continue
		}
		done[key] = true
		rows, err := k.tx.Query(k.ctx, `SELECT id FROM corporate_action WHERE instrument_id = $1 AND ex_date = $2
			AND status IN ('confirmed','detected') AND action_type IN ('split','bonus','split_or_bonus') ORDER BY id`, op.Inst, op.N.ExDate)
		if err != nil {
			return err
		}
		var ids []int64
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			ids = append(ids, id)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(ids) < 2 {
			continue
		}
		pick := ids[0]
		for _, id := range ids {
			if !mine[id] {
				pick = id
				break
			}
		}
		k.dupes = append(k.dupes, DuplicateAction{Symbol: op.Sym, ExDate: key.day, ID: pick})
	}
	return nil
}
