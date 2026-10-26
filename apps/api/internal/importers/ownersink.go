package importers

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5"
)

// metricVal is one stored fundamentals value; Val nil means "reported but missing" (NULL).
type metricVal struct {
	Key, Unit string
	Val       *float64
}

type fundOp struct {
	Inst    int32
	Sym     string
	Period  NormalizedPeriod
	Metrics []metricVal
}

type shareOp struct {
	Inst int32
	Sym  string
	N    NormalizedShareholding
}

type actionOp struct {
	Inst int32
	Sym  string
	N    NormalizedAction
}

type metaOp struct {
	Inst int32
	Sym  string
	N    NormalizedMeta
}

type holidayOp struct{ N NormalizedHoliday }

// ownerSink buffers accepted rows of the B06b kinds and writes them in chunks inside the caller's
// transaction with parameterised bulk upserts. Every row carries the import_batch id, so an undo can
// remove it. A buffer never holds two rows with the same key (the scanners drop identical
// duplicates and reject contradictory ones), which one INSERT ... ON CONFLICT statement requires.
type ownerSink struct {
	ctx     context.Context
	tx      pgx.Tx
	batchID int64
	source  string // manual | csv_import (fundamental_value, shareholding, corporate_action)
	size    int
	hook    func(int) error // test hook: a returned error aborts and rolls back the commit
	today   time.Time

	chunks            int
	inserted, updated int
	symbols           map[string]bool
	actionIDs         []int64
	dupes             []DuplicateAction // split/bonus ex-dates that now hold more than one row (B07R-1)

	fi         []int32
	fb, fp, fk []string
	fe         []time.Time
	fv         []*float64
	fu         []string

	sh []shareOp
	ac []actionOp
	me []metaOp
	ho []holidayOp
}

func newOwnerSink(ctx context.Context, tx pgx.Tx, batchID int64, source string, size int, hook func(int) error, today time.Time) *ownerSink {
	return &ownerSink{ctx: ctx, tx: tx, batchID: batchID, source: source, size: size, hook: hook, today: today, symbols: map[string]bool{}}
}

func (k *ownerSink) count(rows pgx.Rows, err error) error {
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ins bool
		var id int64
		if err := rows.Scan(&id, &ins); err != nil {
			return err
		}
		k.actionIDs = append(k.actionIDs, id)
		k.tally(ins)
	}
	return rows.Err()
}

func (k *ownerSink) tally(ins bool) {
	if ins {
		k.inserted++
	} else {
		k.updated++
	}
}

func (k *ownerSink) countBool(rows pgx.Rows, err error) error {
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var ins bool
		if err := rows.Scan(&ins); err != nil {
			return err
		}
		k.tally(ins)
	}
	return rows.Err()
}

func (k *ownerSink) endChunk() error {
	k.chunks++
	if k.hook != nil {
		return k.hook(k.chunks)
	}
	return nil
}

// ---- fundamentals ----

func (k *ownerSink) addFund(op fundOp) error {
	k.symbols[op.Sym] = true
	for _, m := range op.Metrics {
		k.fi = append(k.fi, op.Inst)
		k.fb, k.fp, k.fe = append(k.fb, op.Period.Basis), append(k.fp, op.Period.PeriodType), append(k.fe, op.Period.End)
		k.fk, k.fv, k.fu = append(k.fk, m.Key), append(k.fv, m.Val), append(k.fu, m.Unit)
	}
	if len(k.fi) >= k.size {
		return k.flushFund()
	}
	return nil
}

const upsertFund = `
INSERT INTO fundamental_value (instrument_id, basis, period_type, period_end, metric_key, value, unit, source, import_batch_id)
SELECT t.i, t.b, t.p, t.e, t.k, t.v, t.u, $7::text, $8::bigint
FROM unnest($1::int[], $2::text[], $3::text[], $4::date[], $5::text[], $6::float8[], $9::text[]) AS t(i, b, p, e, k, v, u)
ON CONFLICT (instrument_id, basis, period_type, period_end, metric_key, source) DO UPDATE SET
  value = EXCLUDED.value, unit = EXCLUDED.unit, import_batch_id = EXCLUDED.import_batch_id, fetched_at = now()
RETURNING (xmax = 0)`

func (k *ownerSink) flushFund() error {
	if len(k.fi) == 0 {
		return nil
	}
	if err := k.countBool(k.tx.Query(k.ctx, upsertFund, k.fi, k.fb, k.fp, k.fe, k.fk, k.fv, k.source, k.batchID, k.fu)); err != nil {
		return err
	}
	k.fi, k.fb, k.fp, k.fk, k.fe, k.fv, k.fu = nil, nil, nil, nil, nil, nil, nil
	return k.endChunk()
}

// ---- shareholding ----

func (k *ownerSink) addShare(op shareOp) error {
	k.symbols[op.Sym] = true
	k.sh = append(k.sh, op)
	if len(k.sh) >= k.size {
		return k.flushShare()
	}
	return nil
}

// revision counts restatements: it only grows when a re-entered quarter differs from the stored one,
// so importing the same file twice stays idempotent.
const upsertShare = `
INSERT INTO shareholding (instrument_id, quarter_end, promoter_pct, fii_pct, dii_pct, mf_pct, insurance_pct, govt_pct, public_pct,
                          promoter_pledged_pct, shareholders_count, filed_on, source, import_batch_id)
SELECT t.i, t.q, t.pr::real, t.fi::real, t.di::real, t.mf::real, t.ins::real, t.gv::real, t.pu::real, t.pl::real, t.n, t.f, $13::text, $14::bigint
FROM unnest($1::int[], $2::date[], $3::float8[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::float8[],
            $10::float8[], $11::int[], $12::date[]) AS t(i, q, pr, fi, di, mf, ins, gv, pu, pl, n, f)
ON CONFLICT (instrument_id, quarter_end) DO UPDATE SET
  promoter_pct = EXCLUDED.promoter_pct, fii_pct = EXCLUDED.fii_pct, dii_pct = EXCLUDED.dii_pct, mf_pct = EXCLUDED.mf_pct,
  insurance_pct = EXCLUDED.insurance_pct, govt_pct = EXCLUDED.govt_pct, public_pct = EXCLUDED.public_pct,
  promoter_pledged_pct = EXCLUDED.promoter_pledged_pct, shareholders_count = EXCLUDED.shareholders_count, filed_on = EXCLUDED.filed_on,
  revision = shareholding.revision + CASE WHEN
    (shareholding.promoter_pct, shareholding.fii_pct, shareholding.dii_pct, shareholding.mf_pct, shareholding.insurance_pct, shareholding.govt_pct,
     shareholding.public_pct, shareholding.promoter_pledged_pct, shareholding.shareholders_count, shareholding.filed_on)
    IS DISTINCT FROM
    (EXCLUDED.promoter_pct, EXCLUDED.fii_pct, EXCLUDED.dii_pct, EXCLUDED.mf_pct, EXCLUDED.insurance_pct, EXCLUDED.govt_pct,
     EXCLUDED.public_pct, EXCLUDED.promoter_pledged_pct, EXCLUDED.shareholders_count, EXCLUDED.filed_on) THEN 1 ELSE 0 END,
  source = EXCLUDED.source, import_batch_id = EXCLUDED.import_batch_id, fetched_at = now()
RETURNING (xmax = 0)`

func (k *ownerSink) flushShare() error {
	n := len(k.sh)
	if n == 0 {
		return nil
	}
	ids, qs := make([]int32, n), make([]time.Time, n)
	cols := make([][]*float64, 7)
	for i := range cols {
		cols[i] = make([]*float64, n)
	}
	cnt, filed := make([]*int32, n), make([]*time.Time, n)
	for i, op := range k.sh {
		ids[i], qs[i] = op.Inst, op.N.QuarterEnd
		for j, p := range []*float64{op.N.Promoter, op.N.FII, op.N.DII, op.N.MF, op.N.Insurance, op.N.Govt, op.N.Public} {
			cols[j][i] = p
		}
		cnt[i], filed[i] = op.N.Count, op.N.FiledOn
	}
	pledged := make([]*float64, n)
	for i, op := range k.sh {
		pledged[i] = op.N.Pledged
	}
	if err := k.countBool(k.tx.Query(k.ctx, upsertShare, ids, qs, cols[0], cols[1], cols[2], cols[3], cols[4], cols[5], cols[6],
		pledged, cnt, filed, k.source, k.batchID)); err != nil {
		return err
	}
	k.sh = nil
	return k.endChunk()
}

// ---- corporate actions ----

func (k *ownerSink) addAction(op actionOp) error {
	k.symbols[op.Sym] = true
	k.ac = append(k.ac, op)
	if len(k.ac) >= k.size {
		return k.flushAction()
	}
	return nil
}

// An owner-entered or imported action is confirmed (docs/01 7.4); a repeat of the same
// (stock, ex_date, type, purpose) updates the ratios and stays one row (ACT-09).
const upsertAction = `
INSERT INTO corporate_action (instrument_id, ex_date, action_type, status, ratio_num, ratio_den, amount_per_share, purpose_text, parsed_ok, source, import_batch_id)
SELECT t.i, t.d, t.ty, 'confirmed', t.rn::numeric(12,4), t.rd::numeric(12,4), t.am::numeric(14,4), t.pt, true, $8::text, $9::bigint
FROM unnest($1::int[], $2::date[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[]) AS t(i, d, ty, rn, rd, am, pt)
ON CONFLICT (instrument_id, ex_date, action_type, purpose_text) DO UPDATE SET
  status = 'confirmed', ratio_num = EXCLUDED.ratio_num, ratio_den = EXCLUDED.ratio_den, amount_per_share = EXCLUDED.amount_per_share,
  parsed_ok = true, source = EXCLUDED.source, import_batch_id = EXCLUDED.import_batch_id
RETURNING id, (xmax = 0)`

func (k *ownerSink) flushAction() error {
	n := len(k.ac)
	if n == 0 {
		return nil
	}
	ids, days, types, purpose := make([]int32, n), make([]time.Time, n), make([]string, n), make([]string, n)
	num, den, amt := make([]*string, n), make([]*string, n), make([]*string, n)
	for i, op := range k.ac {
		ids[i], days[i], types[i], purpose[i] = op.Inst, op.N.ExDate, op.N.Type, op.N.Purpose
		num[i], den[i], amt[i] = op.N.RatioNum, op.N.RatioDen, op.N.Amount
	}
	if err := k.lockActionDays(); err != nil {
		return err
	}
	before := len(k.actionIDs)
	if err := k.count(k.tx.Query(k.ctx, upsertAction, ids, days, types, num, den, amt, purpose, k.source, k.batchID)); err != nil {
		return err
	}
	if err := k.checkDuplicateDays(k.actionIDs[before:]); err != nil {
		return err
	}
	k.ac = nil
	return k.endChunk()
}

// ---- instrument_meta ----

func (k *ownerSink) addMeta(op metaOp) error {
	k.symbols[op.Sym] = true
	k.me = append(k.me, op)
	if len(k.me) >= k.size {
		return k.flushMeta()
	}
	return nil
}

// flushMeta updates sector, industry and company_type (an empty cell keeps the stored value) and
// replaces the index memberships of every stock whose index_tags cell is not empty.
func (k *ownerSink) flushMeta() error {
	if len(k.me) == 0 {
		return nil
	}
	var b pgx.Batch
	for _, op := range k.me {
		b.Queue(`UPDATE instrument SET sector = COALESCE($2::text, sector), industry = COALESCE($3::text, industry),
			company_type = COALESCE($4::text, company_type), updated_at = now() WHERE id = $1`, op.Inst, op.N.Sector, op.N.Industry, op.N.CompanyType)
		if len(op.N.Tags) > 0 {
			b.Queue(`DELETE FROM index_constituent WHERE instrument_id = $1 AND index_name <> ALL($2::text[])`, op.Inst, op.N.Tags)
			b.Queue(`INSERT INTO index_constituent (index_name, instrument_id, as_of)
				SELECT t, $1, $3::date FROM unnest($2::text[]) AS t
				ON CONFLICT (index_name, instrument_id) DO UPDATE SET as_of = EXCLUDED.as_of`, op.Inst, op.N.Tags, k.today)
		}
	}
	br := k.tx.SendBatch(k.ctx, &b)
	for _, op := range k.me {
		if _, err := br.Exec(); err != nil {
			_ = br.Close()
			return err
		}
		k.updated++
		if len(op.N.Tags) > 0 {
			for i := 0; i < 2; i++ {
				if _, err := br.Exec(); err != nil {
					_ = br.Close()
					return err
				}
			}
		}
	}
	if err := br.Close(); err != nil {
		return err
	}
	k.me = nil
	return k.endChunk()
}

// ---- holidays ----

func (k *ownerSink) addHoliday(op holidayOp) error {
	k.ho = append(k.ho, op)
	return nil // holidays are written once, at the end of the file (replace-per-year)
}

const upsertHoliday = `
INSERT INTO market_holiday (holiday_date, segment, description, source)
SELECT t.d, t.s, t.n, 'import' FROM unnest($1::date[], $2::text[], $3::text[]) AS t(d, s, n)
ON CONFLICT (holiday_date, segment) DO UPDATE SET description = EXCLUDED.description, source = 'import'
RETURNING (xmax = 0)`

// flushHolidays replaces, for every year present in the file, all stored holidays of that year by the
// file's rows (docs/01 7.8): rows are upserted, then rows of those years that are not in the file go.
func (k *ownerSink) flushHolidays() error {
	n := len(k.ho)
	if n == 0 {
		return nil
	}
	days, segs, descs := make([]time.Time, n), make([]string, n), make([]*string, n)
	yearSet := map[int32]bool{}
	for i, op := range k.ho {
		days[i], segs[i], descs[i] = op.N.Date, op.N.Segment, op.N.Description
		yearSet[int32(op.N.Date.Year())] = true //nolint:gosec // four-digit year
	}
	years := make([]int32, 0, len(yearSet))
	for y := range yearSet {
		years = append(years, y)
	}
	if err := k.countBool(k.tx.Query(k.ctx, upsertHoliday, days, segs, descs)); err != nil {
		return err
	}
	if _, err := k.tx.Exec(k.ctx, `DELETE FROM market_holiday h
		WHERE extract(year FROM h.holiday_date)::int = ANY($1::int[])
		  AND NOT EXISTS (SELECT 1 FROM unnest($2::date[], $3::text[]) AS t(d, s) WHERE t.d = h.holiday_date AND t.s = h.segment)`,
		years, days, segs); err != nil {
		return err
	}
	k.ho = nil
	return k.endChunk()
}

// flushAll writes every buffer; called at the end of each part so chunks never span two files.
func (k *ownerSink) flushAll() error {
	for _, f := range []func() error{k.flushFund, k.flushShare, k.flushAction, k.flushMeta, k.flushHolidays} {
		if err := f(); err != nil {
			return err
		}
	}
	return nil
}
