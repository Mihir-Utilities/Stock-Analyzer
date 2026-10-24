package importers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// undoWindow is how long a batch can be undone (docs/01 section 7).
const undoWindow = 30 * 24 * time.Hour

// UndoResult is the response of POST /imports/batches/{id}/undo.
type UndoResult struct {
	BatchID         int64  `json:"batch_id"`
	Removed         int    `json:"removed"`
	PostImportJobID *int64 `json:"post_import_job_id"`
	// Warnings: POST_IMPORT_NOT_QUEUED (queue failed after the undo), UNDO_REMOVED_NOTHING (no row
	// carried the batch id any more: a later import took the values over) and
	// UNDO_REMOVES_EARLIER_IMPORT (an identical earlier file was re-imported, so the removed rows
	// also existed before this batch; EarlierBatchIDs lists those batches).
	Warnings        []string `json:"warnings"`
	EarlierBatchIDs []int64  `json:"earlier_batch_ids"`
}

// DependentsError is the 409 of an undo (or delete) that would orphan owner data: the rows to remove
// are referenced by other tables. Nothing is changed.
type DependentsError struct {
	Table string // the referencing table, e.g. portfolio_adjustment
	Count int    // 0 when unknown (a foreign-key violation caught from the database)
}

func (e *DependentsError) Error() string {
	return fmt.Sprintf("importers: rows are referenced by %s (%d)", e.Table, e.Count)
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
	res := &UndoResult{BatchID: id, Warnings: []string{}, EarlierBatchIDs: []int64{}}
	if kind == KindCorporateActions {
		var n int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM portfolio_adjustment pa JOIN corporate_action ca ON ca.id = pa.corporate_action_id
			WHERE ca.import_batch_id = $1`, id).Scan(&n); err != nil {
			return nil, err
		}
		if n > 0 {
			return nil, &DependentsError{Table: "portfolio_adjustment", Count: n}
		}
	}
	affected := map[int32]bool{}
	rows, err := tx.Query(ctx, `DELETE FROM `+table+` WHERE import_batch_id = $1 RETURNING instrument_id`, id) //nolint:gosec // the table name comes from the constant undoTables map
	if err != nil {
		return nil, undoDBError(err)
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
		return nil, undoDBError(err)
	}
	// An identical file imported earlier (same sha256, same kind, not undone) had all its rows
	// re-tagged by this batch: the undo removes values that existed before this import too.
	earlier, err := tx.Query(ctx, `SELECT e.id FROM import_batch e JOIN import_batch b ON b.id = $1
		WHERE e.id <> b.id AND e.kind = b.kind AND e.sha256 IS NOT NULL AND e.sha256 = b.sha256
		AND e.undone_at IS NULL AND e.id < b.id ORDER BY e.id`, id)
	if err != nil {
		return nil, err
	}
	for earlier.Next() {
		var eid int64
		if err := earlier.Scan(&eid); err != nil {
			earlier.Close()
			return nil, err
		}
		res.EarlierBatchIDs = append(res.EarlierBatchIDs, eid)
	}
	earlier.Close()
	if err := earlier.Err(); err != nil {
		return nil, err
	}
	if res.Removed == 0 {
		res.Warnings = append(res.Warnings, "UNDO_REMOVED_NOTHING")
	}
	if res.Removed > 0 && len(res.EarlierBatchIDs) > 0 {
		res.Warnings = append(res.Warnings, "UNDO_REMOVES_EARLIER_IMPORT")
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
	var queued bool
	res.PostImportJobID, queued = s.queuePostImport(ctx, id, symbols)
	if !queued {
		res.Warnings = append(res.Warnings, WarnPostImportNotQueued)
	}
	return res, nil
}

// undoDBError turns a foreign-key violation (SQLSTATE 23503) into a DependentsError so a dependent
// table the explicit check does not know can never surface as a 500.
func undoDBError(err error) error {
	var pg *pgconn.PgError
	if errors.As(err, &pg) && pg.Code == "23503" {
		return &DependentsError{Table: pg.TableName}
	}
	return err
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
