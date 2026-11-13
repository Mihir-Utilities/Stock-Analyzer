-- +goose Up
-- Source: docs/02-database.sql (B20, plan Item D; questions JRN-1..JRN-6)

CREATE TABLE journal_note (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  instrument_id    integer NOT NULL REFERENCES instrument(id) ON DELETE RESTRICT,
  noted_on         date NOT NULL,
  note_text        text NOT NULL,
  price_at_note    numeric(18,4),
  price_as_of      date,
  review_on        date,
  status           text NOT NULL DEFAULT 'open',
  reviewed_at      timestamptz,
  portfolio_txn_id bigint REFERENCES portfolio_txn(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT journal_note_text_len CHECK (char_length(btrim(note_text)) >= 1 AND char_length(note_text) <= 1000),
  CONSTRAINT journal_note_price_pos CHECK (price_at_note IS NULL OR price_at_note > 0),
  CONSTRAINT journal_note_price_pair CHECK ((price_at_note IS NULL) = (price_as_of IS NULL)),
  CONSTRAINT journal_note_status CHECK (status IN ('open','reviewed')),
  CONSTRAINT journal_note_reviewed CHECK ((status = 'reviewed') = (reviewed_at IS NOT NULL))
);
CREATE INDEX journal_note_stock_idx ON journal_note (instrument_id, noted_on DESC, id DESC);
CREATE INDEX journal_note_txn_idx ON journal_note (portfolio_txn_id) WHERE portfolio_txn_id IS NOT NULL;

-- +goose Down
DROP TABLE journal_note;
