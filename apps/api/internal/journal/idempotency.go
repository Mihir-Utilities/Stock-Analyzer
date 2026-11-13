package journal

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
)

// claimKey claims an Idempotency-Key inside the transaction (same store and 24 h rule as the
// portfolio transactions, docs/03 section 1). It returns the stored item when the key was already
// used with the same request, a ConflictError when the request differs or is still running.
func claimKey(ctx context.Context, tx pgx.Tx, key, hash string) (*Item, error) {
	if _, err := tx.Exec(ctx, `DELETE FROM idempotency_key WHERE created_at < now() - interval '24 hours'`); err != nil {
		return nil, err
	}
	tag, err := tx.Exec(ctx, `INSERT INTO idempotency_key (key, scope, request_hash) VALUES ($1::uuid, $2, $3)
		ON CONFLICT (key) DO NOTHING`, key, scope, hash)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 1 {
		return nil, nil
	}
	var gotScope, gotHash string
	var resp []byte
	if err := tx.QueryRow(ctx, `SELECT scope, request_hash, response FROM idempotency_key WHERE key = $1::uuid`, key).
		Scan(&gotScope, &gotHash, &resp); err != nil {
		return nil, err
	}
	if gotScope != scope || gotHash != hash {
		return nil, &ConflictError{Message: "Idempotency-Key was already used with a different request"}
	}
	if resp == nil {
		return nil, &ConflictError{Message: "A request with this Idempotency-Key is still being processed"}
	}
	var it Item
	if err := json.Unmarshal(resp, &it); err != nil {
		return nil, err
	}
	return &it, nil
}

func requestHash(symbol, note string, reviewOn *string, txnID *int64) string {
	ro := ""
	if reviewOn != nil {
		ro = *reviewOn
	}
	tid := json.RawMessage("null")
	if txnID != nil {
		tid, _ = json.Marshal(*txnID)
	}
	b, _ := json.Marshal([]any{strings.ToUpper(symbol), note, ro, tid})
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}
