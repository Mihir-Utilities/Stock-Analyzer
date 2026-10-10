-- Spike S10: DB sizing and trigram search on SYNTHETIC rows (no market data used).
-- Run against a throwaway Postgres that already has docs/02-database.sql applied:
--   docker exec -i <container> psql -U postgres -d <db> -v ON_ERROR_STOP=1 < scripts/spikes/s10_sizing.sql
-- mf_scheme should already hold the names to search (see docs/SPIKE_RESULTS.md S10).

\set ON_ERROR_STOP on

-- 2,300 synthetic instruments; the first 150 get 1,250 daily bars each
INSERT INTO instrument (symbol, name, is_tracked, tracked_reason)
SELECT 'SYM' || i,
       (ARRAY['Tata','Reliance','Infosys','Bharat','Hindustan','Adani','Larsen','Mahindra','Sun','Wipro','Apex','Prime','Nova','Delta'])[1 + i % 14]
       || ' ' || (ARRAY['Steel','Power','Bank','Finance','Chemicals','Pharma','Motors','Cement','Textiles','Foods','Energy','Infra','Labs','Tech'])[1 + (i / 14) % 14]
       || ' ' || (ARRAY['Limited','Industries','Corporation','Enterprises'])[1 + (i / 196) % 4] || ' ' || i,
       i <= 150,
       CASE WHEN i <= 150 THEN 'imported' END
FROM generate_series(1, 2300) AS i;

WITH days AS (
  SELECT d::date AS trade_date, row_number() OVER (ORDER BY d) AS n
  FROM generate_series(date '2021-01-01', date '2026-10-09', interval '1 day') AS d
  WHERE extract(isodow FROM d) < 6
), last1250 AS (
  SELECT trade_date, row_number() OVER (ORDER BY trade_date) AS k
  FROM (SELECT trade_date FROM days ORDER BY trade_date DESC LIMIT 1250) s
)
INSERT INTO price_daily (instrument_id, trade_date, open, high, low, close, adj_close, volume, source, src_adjusted)
SELECT inst.id, l.trade_date,
       p * 0.995, p * 1.01, p * 0.99, p, p,
       (random() * 5000000)::bigint + 1000, 'import', false
FROM instrument inst
JOIN last1250 l ON true
CROSS JOIN LATERAL (SELECT (100 + inst.id * 7 + l.k * 0.05 + random() * 20)::double precision AS p) q(p)
WHERE inst.is_tracked;

ANALYZE price_daily;
SELECT 'price_daily rows' AS metric, count(*)::text AS value FROM price_daily
UNION ALL SELECT 'total bytes (table+index+toast)', pg_total_relation_size('price_daily')::text
UNION ALL SELECT 'table bytes', pg_relation_size('price_daily')::text
UNION ALL SELECT 'pk index bytes', pg_indexes_size('price_daily')::text
UNION ALL SELECT 'bytes per row (total)', round(pg_total_relation_size('price_daily')::numeric / count(*), 1)::text FROM price_daily;

-- trigram search timing: spec form is `name % q` (similarity threshold 0.3), ordered by similarity
SET pg_trgm.similarity_threshold = 0.3;
\timing on
SELECT count(*) FROM (SELECT symbol FROM instrument WHERE name % 'Tata Steel' ORDER BY similarity(name, 'Tata Steel') DESC LIMIT 20) a;
SELECT count(*) FROM (SELECT symbol FROM instrument WHERE name % 'Mahindra Motors Limited' ORDER BY similarity(name, 'Mahindra Motors Limited') DESC LIMIT 20) a;
SELECT count(*) FROM (SELECT symbol FROM instrument WHERE name % 'Wipro Labz' ORDER BY similarity(name, 'Wipro Labz') DESC LIMIT 20) a;
SELECT count(*) FROM (SELECT code FROM mf_scheme WHERE name % 'Parag Parikh Flexi Cap' ORDER BY similarity(name, 'Parag Parikh Flexi Cap') DESC LIMIT 20) a;
SELECT count(*) FROM (SELECT code FROM mf_scheme WHERE name % 'HDFC Flexi Cap Direct Growth' ORDER BY similarity(name, 'HDFC Flexi Cap Direct Growth') DESC LIMIT 20) a;
SELECT count(*) FROM (SELECT code FROM mf_scheme WHERE name % 'ICICI Prudential Corporate Bond' ORDER BY similarity(name, 'ICICI Prudential Corporate Bond') DESC LIMIT 20) a;
