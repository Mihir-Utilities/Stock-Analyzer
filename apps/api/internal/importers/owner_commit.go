package importers

import (
	"context"
	"sort"

	"github.com/jackc/pgx/v5"
)

// commitOwner writes the B06b kinds inside the commit transaction. Pass 1 re-validates every part
// against the current data (a row can turn invalid between validate and commit); pass 2 writes the
// same scan through the sink. It returns the affected stock symbols for post_import (none for
// holidays) and the number of warnings of the scan.
func (s *Service) commitOwner(ctx context.Context, tx pgx.Tx, kind string, parts [][]byte, batchID int64) (*CommitResult, []string, int, error) {
	idx, err := loadIndex(ctx, tx)
	if err != nil {
		return nil, nil, 0, err
	}
	env := ownerEnv{idx: idx, today: s.today()}
	lim := s.Limits(kind)
	warnings := 0
	for _, part := range parts {
		rep, hdr, err := scanOwner(kind, part, env, lim, nil)
		if err != nil {
			return nil, nil, 0, err
		}
		if n := len(hdr); n > 0 {
			return nil, nil, 0, &HasErrorsError{Count: n}
		}
		if rep.Errors.total > 0 {
			return nil, nil, 0, &HasErrorsError{Count: rep.Errors.total}
		}
		warnings += rep.Warnings.total
	}
	sink := newOwnerSink(ctx, tx, batchID, "csv_import", s.chunkSize, s.afterChunk, env.today)
	for _, part := range parts {
		if _, _, err := scanOwner(kind, part, env, lim, sink); err != nil {
			return nil, nil, 0, err
		}
	}
	res := &CommitResult{Inserted: sink.inserted, Updated: sink.updated, Warnings: []string{}}
	if len(sink.dupes) > 0 { // B07R-1: stored as entered, one warning per file
		res.Warnings = append(res.Warnings, WarnDuplicateExDateAction)
		warnings += len(sink.dupes)
	}
	symbols := make([]string, 0, len(sink.symbols))
	for sym := range sink.symbols {
		symbols = append(symbols, sym)
	}
	sort.Strings(symbols)
	return res, symbols, warnings, nil
}
