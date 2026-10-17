// Package telegram is the API's side of the Telegram Bot API (docs/01-data-sources.md section 6):
// HTML escaping, the sendMessage client (through internal/egress only) and webhook update parsing.
// The bot token and the webhook secret are never logged or put into error text.
package telegram

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/india-analyzer/api/internal/egress"
)

// Host is the only Telegram destination; main allow-lists it in the egress client.
const Host = "api.telegram.org"

// Escape makes dynamic text safe for parse_mode=HTML (ALR-09: `M&M` becomes `M&amp;M`).
func Escape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// SecretMatches compares the webhook secret header with the configured secret in constant time.
// Both sides are hashed first so the comparison also hides the length. An empty configured secret
// never matches (fail closed).
func SecretMatches(got, want string) bool {
	if want == "" {
		return false
	}
	a, b := sha256.Sum256([]byte(got)), sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(a[:], b[:]) == 1
}

// Sender sends one HTML message to a chat.
type Sender interface {
	SendMessage(ctx context.Context, chatID int64, htmlText string) error
}

// Client implements Sender over the egress client.
type Client struct {
	token string
	base  string
	hc    *egress.Client
}

// NewClient builds a sender. hc must allow https://api.telegram.org (tests allow a local server and
// pass its URL through WithBaseURL).
func NewClient(token string, hc *egress.Client) *Client {
	return &Client{token: token, base: "https://" + Host, hc: hc}
}

// WithBaseURL overrides the API base URL (tests only; the egress allow-list still applies).
func (c *Client) WithBaseURL(u string) *Client {
	c.base = strings.TrimRight(u, "/")
	return c
}

type sendBody struct {
	ChatID                int64  `json:"chat_id"`
	Text                  string `json:"text"`
	ParseMode             string `json:"parse_mode"`
	DisableWebPagePreview bool   `json:"disable_web_page_preview"`
}

// SendMessage calls sendMessage with parse_mode=HTML. The text must already be escaped.
func (c *Client) SendMessage(ctx context.Context, chatID int64, htmlText string) error {
	body, err := json.Marshal(sendBody{ChatID: chatID, Text: htmlText, ParseMode: "HTML", DisableWebPagePreview: true})
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+"/bot"+c.token+"/sendMessage", bytes.NewReader(body))
	if err != nil {
		return c.scrub(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return c.scrub(err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Description string `json:"description"`
		}
		_ = json.Unmarshal(raw, &e)
		return c.scrub(fmt.Errorf("telegram: sendMessage status %d: %s", resp.StatusCode, e.Description))
	}
	return nil
}

// scrub removes the token from an error (net/http errors contain the request URL).
func (c *Client) scrub(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	if c.token != "" {
		msg = strings.ReplaceAll(msg, c.token, "***")
	}
	if errors.Is(err, egress.ErrNotAllowed) {
		return fmt.Errorf("telegram: %s: %w", msg, egress.ErrNotAllowed)
	}
	return errors.New("telegram: " + msg)
}

// Update is the subset of a Telegram update the webhook reads. Unknown fields are ignored on
// purpose (Telegram adds fields over time).
type Update struct {
	Message *struct {
		Chat struct {
			ID   int64  `json:"id"`
			Type string `json:"type"`
		} `json:"chat"`
		Text string `json:"text"`
	} `json:"message"`
}

// Start is a well-formed `/start <code>` in a private chat.
type Start struct {
	ChatID int64
	Code   string // raw argument, not yet normalised
}

// ParseStart returns the /start request in body, or ok=false for everything else: other commands,
// plain text, group chats, edited messages, channel posts, malformed JSON, `/start` without a code.
// botUsername (optional) restricts `/start@name` to this bot.
func ParseStart(body []byte, botUsername string) (Start, bool) {
	var u Update
	if err := json.Unmarshal(body, &u); err != nil || u.Message == nil {
		return Start{}, false
	}
	m := u.Message
	if m.Chat.Type != "private" || m.Chat.ID == 0 {
		return Start{}, false
	}
	fields := strings.Fields(m.Text)
	if len(fields) != 2 {
		return Start{}, false
	}
	cmd := fields[0]
	if !strings.HasPrefix(cmd, "/start") {
		return Start{}, false
	}
	rest := strings.TrimPrefix(cmd, "/start")
	if rest != "" {
		if !strings.HasPrefix(rest, "@") || (botUsername != "" && !strings.EqualFold(rest[1:], botUsername)) {
			return Start{}, false
		}
	}
	return Start{ChatID: m.Chat.ID, Code: fields[1]}, true
}
