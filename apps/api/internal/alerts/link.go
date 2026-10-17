package alerts

import (
	"context"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/telegram"
)

// LinkCode is the response of POST /telegram/link-code. BotUsername and DeepLink are nil until the
// owner has created the bot and set TELEGRAM_BOT_USERNAME (D-9).
type LinkCode struct {
	Code        string  `json:"code"`
	ExpiresAt   string  `json:"expires_at"`
	BotUsername *string `json:"bot_username"`
	DeepLink    *string `json:"deep_link"`
}

// Messages sent in the chat (static text; chat content is never echoed back).
const (
	MsgLinked      = "Telegram is linked. Alert messages will arrive in this chat."
	MsgInvalidCode = "That link code is invalid, expired or already used. Create a new one in the app (Settings, Telegram)."
	MsgTest        = "Test message from India Stock & MF Analyzer. If you can read this, alerts will reach you."
)

// NewLinkCode creates a one-time code valid for 15 minutes. Only its sha256 is stored.
func (s *Service) NewLinkCode(ctx context.Context) (LinkCode, error) {
	display, norm, err := GenerateCode()
	if err != nil {
		return LinkCode{}, err
	}
	now := s.Now()
	if err := s.q.PurgeLinkCodes(ctx, pgtype.Timestamptz{Time: now, Valid: true}); err != nil {
		return LinkCode{}, err
	}
	exp := now.Add(LinkCodeTTL)
	if err := s.q.InsertLinkCode(ctx, dbq.InsertLinkCodeParams{CodeHash: HashCode(norm), ExpiresAt: pgtype.Timestamptz{Time: exp, Valid: true}}); err != nil {
		return LinkCode{}, err
	}
	out := LinkCode{Code: display, ExpiresAt: exp.UTC().Format(time.RFC3339)}
	if s.BotUsername != "" {
		u := s.BotUsername
		d := "https://t.me/" + u + "?start=" + display
		out.BotUsername, out.DeepLink = &u, &d
	}
	return out, nil
}

// Unlink clears the chat id (docs/03 section 13).
func (s *Service) Unlink(ctx context.Context) error { return s.q.ClearTelegramChat(ctx) }

// LinkChat is the webhook's `/start <code>`: it consumes a valid unused unexpired code and stores
// the chat id, atomically. It returns false for unknown, used, expired or malformed codes (ALR-12).
// The chat then gets a short fixed reply; a failed reply is logged without any secret.
func (s *Service) LinkChat(ctx context.Context, chatID int64, rawCode string) (bool, error) {
	linked := false
	if norm, ok := NormalizeCode(rawCode); ok {
		err := s.inTx(ctx, func(q *dbq.Queries) error {
			n, err := q.ConsumeLinkCode(ctx, dbq.ConsumeLinkCodeParams{
				Now: pgtype.Timestamptz{Time: s.Now(), Valid: true}, CodeHash: HashCode(norm),
			})
			if err != nil || n == 0 {
				return err
			}
			linked = true
			return q.SetTelegramChat(ctx, pgtype.Int8{Int64: chatID, Valid: true})
		})
		if err != nil {
			return false, err
		}
	}
	if s.Sender != nil {
		msg := MsgInvalidCode
		if linked {
			msg = MsgLinked
		}
		if err := s.Sender.SendMessage(ctx, chatID, telegram.Escape(msg)); err != nil {
			s.log.Warn().Err(err).Bool("linked", linked).Msg("telegram: reply to /start failed")
		}
	}
	return linked, nil
}

// SendTest sends a test message to the linked chat, at most once per minute.
func (s *Service) SendTest(ctx context.Context) error {
	if s.Sender == nil {
		return ErrNoTelegram
	}
	chat, err := s.q.GetTelegramChat(ctx)
	if err != nil {
		return err
	}
	if !chat.Valid {
		return ErrNotLinked
	}
	s.testMu.Lock()
	now := s.Now()
	if wait := s.lastTest.Add(TestMessageGap).Sub(now); !s.lastTest.IsZero() && wait > 0 {
		s.testMu.Unlock()
		secs := int(wait.Seconds())
		if wait%time.Second != 0 {
			secs++
		}
		return &RateLimitedError{RetryAfterSeconds: secs}
	}
	s.lastTest = now
	s.testMu.Unlock()
	if err := s.Sender.SendMessage(ctx, chat.Int64, telegram.Escape(MsgTest)); err != nil {
		s.log.Warn().Err(err).Msg("telegram: test message failed")
		return ErrSendFailed
	}
	return nil
}
