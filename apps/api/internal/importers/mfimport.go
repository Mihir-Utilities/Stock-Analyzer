package importers

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/mfhold"
)

// MFRefresher queues mf_refresh for a scheme without NAV rows (docs/03 section 10); may be nil.
type MFRefresher interface {
	EnqueueMFRefresh(ctx context.Context, code int32) error
}

// SetMFRefresher wires the optional refresh enqueuer.
func (s *Service) SetMFRefresher(r MFRefresher) { s.mfRefresh = r }

// MFCommitResult is the commit response of an mf_statement batch (docs/03 12a).
type MFCommitResult struct {
	BatchID           int64    `json:"batch_id"`
	Inserted          int      `json:"inserted"`
	SkippedDuplicates int      `json:"skipped_duplicates"`
	Warnings          []string `json:"warnings"`
}

// UndoBreaksError is 409 UNDO_BREAKS_HOLDINGS: removing the batch would make a later redemption
// exceed the held units (MFH-20). Nothing is changed.
type UndoBreaksError struct {
	Scheme int32
	Folio  string
	Date   time.Time
}

func (e *UndoBreaksError) Error() string {
	return fmt.Sprintf("importers: undo would oversell scheme %d folio %s on %s", e.Scheme, e.Folio, e.Date.Format(time.DateOnly))
}

const mfTemplate = "Date,Fund Name,Transaction Type,Folio No,Units Traded,NAV,Amount,Stamp Duty\n" +
	"05-Jan-2026,Example Flexi Cap Fund - Direct Plan - Growth,Purchase,1234567/89,12.345,81.000,999.95,0.05\n" +
	"05-Feb-2026,Example Flexi Cap Fund - Direct Plan - Growth,Purchase,1234567/89,12.100,82.640,999.95,0.05\n"

func (s *Service) mfEnv(ctx context.Context, db dbq.DBTX) (mfEnv, error) {
	hol, err := loadHolidays(ctx, db)
	if err != nil {
		return mfEnv{}, err
	}
	maps, err := mfhold.LoadMappings(ctx, db)
	if err != nil {
		return mfEnv{}, err
	}
	return mfEnv{today: s.today(), holidays: hol, mappings: maps}, nil
}

// maxCandidateNames bounds the candidate searches of one validate call.
const maxCandidateNames = 50

// buildMF scans a statement against the current mappings and fills the validate response (without
// the upload id).
func (s *Service) buildMF(ctx context.Context, db dbq.DBTX, content []byte) (*ValidateResult, *mfScan, error) {
	env, err := s.mfEnv(ctx, db)
	if err != nil {
		return nil, nil, err
	}
	sc, err := scanMF(content, env, s.Limits(KindMFStatement))
	if err != nil {
		return nil, nil, err
	}
	res := &ValidateResult{Preview: []map[string]any{}, Errors: []RowIssue{}, Warnings: []RowIssue{}}
	if sc.Header != nil {
		res.Errors, res.ErrorCount = sc.Header, len(sc.Header)
	}
	rep := sc.Report
	res.Rows = rep.Rows
	res.Preview = append(res.Preview, rep.Preview...)
	res.Errors = append(res.Errors, rep.Errors.items...)
	res.ErrorCount += rep.Errors.total
	res.Warnings = append(res.Warnings, rep.Warnings.items...)
	res.WarningCount += rep.Warnings.total
	pv := sc.Preview
	n := 0
	for _, f := range pv.Funds {
		if f.Mapped {
			continue
		}
		u := MFUnmapped{FundName: f.FundName, FundNameKey: f.FundNameKey, Rows: f.Rows, Candidates: []mfhold.Candidate{}}
		if n < maxCandidateNames {
			if u.Candidates, err = mfhold.Candidates(ctx, db, f.FundName); err != nil {
				return nil, nil, err
			}
			n++
		}
		pv.UnmappedFunds = append(pv.UnmappedFunds, u)
	}
	if len(sc.Rows) > 0 {
		keys := make([]string, 0, len(sc.Rows))
		for _, r := range sc.Rows {
			keys = append(keys, r.DedupeKey)
		}
		if err := db.QueryRow(ctx, `SELECT count(*) FROM mf_txn WHERE dedupe_key = ANY($1::text[])`, keys).Scan(&pv.DuplicatesInDB); err != nil {
			return nil, nil, err
		}
	}
	res.MF = &pv
	return res, sc, nil
}

func (s *Service) validateMF(ctx context.Context, content []byte, group string) (*ValidateResult, error) {
	res, _, err := s.buildMF(ctx, s.pool, content)
	if err != nil {
		return nil, err
	}
	id, err := s.putUpload(ctx, KindMFStatement, content)
	if err != nil {
		return nil, err
	}
	res.UploadID = id
	if group != "" {
		res.UploadGroup = &group
	}
	return res, nil
}

// RevalidateMF re-runs the validation of a stored upload against the current fund-name mappings
// without re-uploading (docs/03 12a). The upload keeps its id and its original expiry.
func (s *Service) RevalidateMF(ctx context.Context, uploadID string) (*ValidateResult, error) {
	content, err := s.getUpload(ctx, s.pool, uploadID, KindMFStatement)
	if err != nil {
		return nil, err
	}
	res, _, err := s.buildMF(ctx, s.pool, content)
	if err != nil {
		return nil, err
	}
	res.UploadID = uploadID
	return res, nil
}

// commitMF writes a validated statement inside the commit transaction (docs/01 7.9, MFH-12, MFH-24).
func (s *Service) commitMF(ctx context.Context, tx pgx.Tx, content []byte, excluded []int, batchID int64) (*MFCommitResult, error) {
	res, sc, err := s.buildMF(ctx, tx, content)
	if err != nil {
		return nil, err
	}
	if res.ErrorCount > 0 {
		return nil, &HasErrorsError{Count: res.ErrorCount}
	}
	skip := map[int]bool{}
	for _, l := range excluded {
		if !sc.Lines[l] {
			return nil, validation("excluded_rows", fmt.Sprintf("line %d is not a data row of the file", l))
		}
		skip[l] = true
	}
	set := map[int32]bool{}
	for _, r := range sc.Rows {
		if !skip[r.Line] {
			set[r.SchemeCode] = true
		}
	}
	codes := make([]int32, 0, len(set))
	for c := range set {
		codes = append(codes, c)
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i] < codes[j] })
	if err := mfhold.LockSchemes(ctx, tx, codes...); err != nil {
		return nil, err
	}
	batch := &pgx.Batch{}
	n := 0
	for _, r := range sc.Rows {
		if skip[r.Line] {
			continue
		}
		batch.Queue(`INSERT INTO mf_txn (scheme_code, folio, txn_type, txn_date, units, nav, amount, stamp_duty, source, fund_name, fund_name_key, dedupe_key, import_batch_id)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'import', $9, $10, $11, $12)
			ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
			r.SchemeCode, r.Folio, r.Type, r.Date, r.Units, r.NAV, r.Amount, r.Stamp, r.FundName, r.FundKey, r.DedupeKey, batchID)
		n++
	}
	inserted := 0
	br := tx.SendBatch(ctx, batch)
	for i := 0; i < n; i++ {
		tag, err := br.Exec()
		if err != nil {
			_ = br.Close()
			return nil, err
		}
		inserted += int(tag.RowsAffected())
	}
	if err := br.Close(); err != nil {
		return nil, err
	}
	if err := mfhold.ValidateSchemes(ctx, tx, codes, s.Now()); err != nil {
		return nil, err
	}
	for _, c := range codes {
		if err := mfhold.TrackScheme(ctx, tx, c); err != nil {
			return nil, err
		}
	}
	out := &MFCommitResult{BatchID: batchID, Inserted: inserted, SkippedDuplicates: n - inserted, Warnings: []string{}}
	seen := map[string]bool{}
	for _, w := range sc.Report.Warnings.items {
		if w.Code != "" && !seen[w.Code] {
			seen[w.Code] = true
			out.Warnings = append(out.Warnings, w.Code)
		}
	}
	sort.Strings(out.Warnings)
	return out, nil
}

// afterCommitMF queues mf_refresh for schemes that have no NAV rows (best effort; no post_import job).
func (s *Service) afterCommitMF(ctx context.Context, batchID int64) {
	if s.mfRefresh == nil {
		return
	}
	rows, err := s.pool.Query(ctx, `SELECT DISTINCT t.scheme_code FROM mf_txn t
		WHERE t.import_batch_id = $1 AND NOT EXISTS (SELECT 1 FROM mf_nav n WHERE n.scheme_code = t.scheme_code)`, batchID)
	if err != nil {
		return
	}
	var codes []int32
	for rows.Next() {
		var c int32
		if rows.Scan(&c) == nil {
			codes = append(codes, c)
		}
	}
	rows.Close()
	for _, c := range codes {
		_ = s.mfRefresh.EnqueueMFRefresh(ctx, c)
	}
}

// undoMF deletes the rows of a batch inside the undo transaction and refuses (UndoBreaksError) when a
// later redemption would then exceed the held units (MFH-20).
func (s *Service) undoMF(ctx context.Context, tx pgx.Tx, id int64) (int, error) {
	rows, err := tx.Query(ctx, `DELETE FROM mf_txn WHERE import_batch_id = $1 RETURNING scheme_code`, id)
	if err != nil {
		return 0, err
	}
	set := map[int32]bool{}
	removed := 0
	for rows.Next() {
		var c int32
		if err := rows.Scan(&c); err != nil {
			rows.Close()
			return 0, err
		}
		set[c] = true
		removed++
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}
	codes := make([]int32, 0, len(set))
	for c := range set {
		codes = append(codes, c)
	}
	sort.Slice(codes, func(i, j int) bool { return codes[i] < codes[j] })
	if err := mfhold.LockSchemes(ctx, tx, codes...); err != nil {
		return 0, err
	}
	if err := mfhold.ValidateSchemes(ctx, tx, codes, s.Now()); err != nil {
		var ie *mfhold.InsufficientError
		if errors.As(err, &ie) {
			return 0, &UndoBreaksError{Scheme: ie.Scheme, Folio: ie.Folio, Date: ie.Date}
		}
		return 0, err
	}
	for _, c := range codes {
		if err := mfhold.RecomputeTracking(ctx, tx, c); err != nil {
			return 0, err
		}
	}
	return removed, nil
}
