package importers

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
)

// undoWindow is how long a batch can be undone (docs/01 section 7).
const undoWindow = 30 * 24 * time.Hour

// UndoResult is the response of POST /imports/batches/{id}/undo.
type UndoResult struct {
	BatchID         int64  `json:"batch_id"`
	Removed         int    `json:"removed"`
	PostImportJobID *int64 `json:"post_import_job_id"`
}

// undoTables maps an undoable kind to the table whose rows carry the batch id.
var undoTables = map[string]string{
	KindResultsQuarterly: "fundamental_value",
	KindResultsAnnual:    "fundamental_value",
	KindBalanceCashflow:  "fundamental_value",
	KindFundamentalsLong: "fundamental_value",
	KindShareholding:     "shareholding",
	KindCorporateActions: "corporate_action",
}

// Undo removes the rows tagged with the batch within 30 days (IMP-14). Values the batch overwrote
// are NOT restored (the UI warns). prices, instruments, holidays, instrument_meta and manual-entry
// batches are not undoable (409): they change rows that carry no batch tag or are corrected by
// importing again. An already-undone or expired batch is a 409 too.
func (s *Service) Undo(ctx context.Context, id int64) (*UndoResult, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var kind string
	var undone *time.Time
	var created time.Time
	err = tx.QueryRow(ctx, `SELECT kind, undone_at, created_at FROM import_batch WHERE id = $1 FOR UPDATE`, id).Scan(&kind, &undone, &created)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrBatchNotFound
	}
	if err != nil {
		return nil, err
	}
	table, ok := undoTables[kind]
	if !ok {
		return nil, ErrNotUndoable
	}
	if undone != nil {
		return nil, ErrConflict
	}
	now := s.Now()
	if now.Sub(created) > undoWindow {
		return nil, ErrUndoExpired
	}
	res := &UndoResult{BatchID: id}
	affected := map[int32]bool{}
	rows, err := tx.Query(ctx, `DELETE FROM `+table+` WHERE import_batch_id = $1 RETURNING instrument_id`, id) //nolint:gosec // the table name comes from the constant undoTables map
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var inst int32
		if err := rows.Scan(&inst); err != nil {
			rows.Close()
			return nil, err
		}
		affected[inst] = true
		res.Removed++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if _, err := tx.Exec(ctx, `UPDATE import_batch SET undone_at = $2 WHERE id = $1`, id, now); err != nil {
		return nil, err
	}
	symbols, err := symbolsOf(ctx, tx, affected)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	res.PostImportJobID = s.queuePostImport(ctx, id, symbols)
	return res, nil
}

func symbolsOf(ctx context.Context, tx pgx.Tx, set map[int32]bool) ([]string, error) {
	if len(set) == 0 {
		return nil, nil
	}
	ids := make([]int32, 0, len(set))
	for i := range set {
		ids = append(ids, i)
	}
	rows, err := tx.Query(ctx, `SELECT symbol FROM instrument WHERE id = ANY($1::int[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var sym string
		if err := rows.Scan(&sym); err != nil {
			return nil, err
		}
		out = append(out, sym)
	}
	sort.Strings(out)
	return out, rows.Err()
}
