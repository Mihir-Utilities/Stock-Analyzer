package importers

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/india-analyzer/api/internal/jobs"
)

// failEnq is a PostImportEnqueuer whose queue is down.
type failEnq struct{}

func (failEnq) EnqueuePostImport(context.Context, int64, []string) (jobs.Job, bool, error) {
	return jobs.Job{}, false, errors.New("queue down")
}

func hasWarn(ws []string, code string) bool {
	for _, w := range ws {
		if w == code {
			return true
		}
	}
	return false
}

// IMP-53 (IMP-14): review B08-1: undoing a corporate_actions batch whose action has a portfolio adjustment is
// refused with DependentsError and changes nothing; without dependents it still works.
func TestUndoCorporateActionsWithDependents(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	ctx := context.Background()
	ac := e.mustCommit(KindCorporateActions, actHdr+"AAA,2026-02-10,split,10,2,,x\n")
	e.exec(`INSERT INTO portfolio_adjustment (instrument_id, corporate_action_id, effective_date, qty_multiplier)
		SELECT instrument_id, id, ex_date, 5 FROM corporate_action`)
	_, err := e.svc.Undo(ctx, ac.BatchID)
	var dep *DependentsError
	if !errors.As(err, &dep) || dep.Table != "portfolio_adjustment" || dep.Count != 1 {
		t.Fatalf("want DependentsError, got %v", err)
	}
	if e.count(`SELECT count(*) FROM corporate_action`) != 1 || e.count(`SELECT count(*) FROM portfolio_adjustment`) != 1 ||
		e.count(`SELECT count(*) FROM import_batch WHERE id = $1 AND undone_at IS NOT NULL`, ac.BatchID) != 0 {
		t.Error("a refused undo must change nothing")
	}
	// Once the owner removes the adjustment the undo works.
	e.exec(`DELETE FROM portfolio_adjustment`)
	if r, err := e.svc.Undo(ctx, ac.BatchID); err != nil || r.Removed != 1 {
		t.Errorf("undo without dependents: %+v %v", r, err)
	}
	// A foreign-key violation from a dependent the explicit check does not know is a DependentsError too.
	if errors.As(undoDBError(errors.New("x")), new(*DependentsError)) {
		t.Error("other errors pass through")
	}
	pg := &pgconn.PgError{Code: "23503", TableName: "portfolio_adjustment"}
	if !errors.As(undoDBError(pg), &dep) || dep.Table != "portfolio_adjustment" {
		t.Error("a 23503 becomes a DependentsError")
	}
}

// IMP-54: B06b-1 / review B08-3: a queue failure adds POST_IMPORT_NOT_QUEUED on manual POST, manual DELETE and undo.
func TestQueueFailureWarningOnAllWrites(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	ctx := context.Background()
	b := e.mustCommit(KindShareholding, shareHdr+"AAA,2026-06-30,50,20,15,9,3,1,14,,,\n")
	e.svc.enq = failEnq{}
	entry := ResultsEntry{Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30", Values: map[string]string{"revenue": "1"}}
	m, err := e.svc.AddResults(ctx, "AAA", entry)
	if err != nil || m.PostImportJobID != nil || len(m.Warnings) != 1 || m.Warnings[0].Code != WarnPostImportNotQueued {
		t.Fatalf("manual POST: %+v %v", m, err)
	}
	d, err := e.svc.DeleteResults(ctx, "AAA", "Q", "2026-06-30", "consolidated")
	if err != nil || d.Deleted != 1 || !hasWarn(d.Warnings, WarnPostImportNotQueued) {
		t.Fatalf("manual DELETE: %+v %v", d, err)
	}
	u, err := e.svc.Undo(ctx, b.BatchID)
	if err != nil || u.Removed != 1 || !hasWarn(u.Warnings, WarnPostImportNotQueued) {
		t.Fatalf("undo: %+v %v", u, err)
	}
	// Healthy queue: no warning.
	e.svc.enq = e.jobs
	ok, err := e.svc.AddResults(ctx, "AAA", entry)
	if err != nil || len(ok.Warnings) != 0 {
		t.Errorf("healthy manual POST: %+v %v", ok, err)
	}
}

// IMP-55: review B08-5: undoing a re-imported identical file removes values that existed before the first
// import; the response says so. Undoing the older batch removes nothing and warns.
func TestUndoReimportedFileWarns(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	ctx := context.Background()
	csv := resHdr + "AAA,consolidated,2026-06-30,100,,,,,,,,,\n"
	first := e.mustCommit(KindResultsQuarterly, csv)
	second := e.mustCommit(KindResultsQuarterly, csv)
	u, err := e.svc.Undo(ctx, second.BatchID)
	if err != nil || u.Removed != 1 || !hasWarn(u.Warnings, "UNDO_REMOVES_EARLIER_IMPORT") ||
		len(u.EarlierBatchIDs) != 1 || u.EarlierBatchIDs[0] != first.BatchID {
		t.Fatalf("undo second: %+v %v", u, err)
	}
	if e.count(`SELECT count(*) FROM fundamental_value`) != 0 {
		t.Error("documented behaviour: the value is removed and not restored")
	}
	o, err := e.svc.Undo(ctx, first.BatchID)
	if err != nil || o.Removed != 0 || !hasWarn(o.Warnings, "UNDO_REMOVED_NOTHING") {
		t.Errorf("undo older: %+v %v", o, err)
	}
	// A different file gives no earlier-import warning.
	a := e.mustCommit(KindResultsQuarterly, resHdr+"AAA,consolidated,2026-03-31,1,,,,,,,,,\n")
	if r, err := e.svc.Undo(ctx, a.BatchID); err != nil || len(r.Warnings) != 0 {
		t.Errorf("plain undo: %+v %v", r, err)
	}
}

// IMP-56: review B08-7: keys that differ only by case are a duplicate, not a random pick.
func TestManualResultsDuplicateKeys(t *testing.T) {
	e := newEnv(t)
	e.stocks("AAA")
	var ve *ValidationError
	_, err := e.svc.AddResults(context.Background(), "AAA", ResultsEntry{Basis: "consolidated", PeriodType: "Q", PeriodEnd: "2026-06-30",
		Values: map[string]string{"Revenue": "1", "revenue": "2"}})
	if !errors.As(err, &ve) || !strings.Contains(ve.Fields[0].Message, "duplicate key") {
		t.Fatalf("want duplicate key error, got %v", err)
	}
	if e.count(`SELECT count(*) FROM fundamental_value`) != 0 {
		t.Error("nothing written")
	}
}

// IMP-56: review B08-6: exponent notation gets a clear message and is not accepted.
func TestCleanNumberExponent(t *testing.T) {
	for _, in := range []string{"1e5", "1E5", "1.5e-3", "-2e+4"} {
		_, err := CleanNumber(in)
		if err == nil || !strings.Contains(err.Error(), "exponent notation not accepted") {
			t.Errorf("%q: %v", in, err)
		}
	}
	if _, err := CleanNumber("abc"); err == nil || !strings.Contains(err.Error(), "not a number") {
		t.Error("other junk keeps the generic message")
	}
}
