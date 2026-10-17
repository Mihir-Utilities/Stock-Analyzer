package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/india-analyzer/api/internal/egress"
)

// ALR-09: HTML special characters in dynamic text are escaped.
func TestEscape(t *testing.T) {
	for in, want := range map[string]string{
		"M&M":           "M&amp;M",
		"<b>x</b>":      "&lt;b&gt;x&lt;/b&gt;",
		"plain":         "plain",
		"a & b < c > d": "a &amp; b &lt; c &gt; d",
		"&amp;":         "&amp;amp;",
	} {
		if got := Escape(in); got != want {
			t.Errorf("Escape(%q) = %q, want %q", in, got, want)
		}
	}
}

// SEC-60: the secret comparison matches only the exact secret and fails closed on an empty secret.
func TestSecretMatches(t *testing.T) {
	cases := []struct {
		got, want string
		ok        bool
	}{
		{"s3cret", "s3cret", true},
		{"s3cret ", "s3cret", false},
		{"S3CRET", "s3cret", false},
		{"", "s3cret", false},
		{"s3cre", "s3cret", false},
		{"", "", false}, // no configured secret: nothing matches
		{"anything", "", false},
	}
	for _, c := range cases {
		if SecretMatches(c.got, c.want) != c.ok {
			t.Errorf("SecretMatches(%q, %q) != %v", c.got, c.want, c.ok)
		}
	}
}

func upd(chatType string, id int64, text string) []byte {
	m := map[string]any{"update_id": 1, "message": map[string]any{
		"message_id": 5, "chat": map[string]any{"id": id, "type": chatType}, "text": text,
	}}
	b, _ := json.Marshal(m)
	return b
}

// ALR-13: only `/start <code>` in a private chat is acted on; everything else is ignored.
func TestParseStart(t *testing.T) {
	good := []struct {
		body []byte
		bot  string
		code string
	}{
		{upd("private", 42, "/start A7K9-Q2XM"), "", "A7K9-Q2XM"},
		{upd("private", 42, "/start@MyBot A7K9-Q2XM"), "MyBot", "A7K9-Q2XM"},
		{upd("private", 42, "/start@mybot A7K9-Q2XM"), "MyBot", "A7K9-Q2XM"},
		{upd("private", 42, "  /start   A7K9-Q2XM  "), "", "A7K9-Q2XM"},
	}
	for _, g := range good {
		st, ok := ParseStart(g.body, g.bot)
		if !ok || st.ChatID != 42 || st.Code != g.code {
			t.Errorf("%s: %+v %v", g.body, st, ok)
		}
	}
	bad := map[string][]byte{
		"plain text":        upd("private", 42, "hello"),
		"start no code":     upd("private", 42, "/start"),
		"other command":     upd("private", 42, "/stop A7K9-Q2XM"),
		"prefix command":    upd("private", 42, "/startx A7K9-Q2XM"),
		"extra args":        upd("private", 42, "/start A7K9 Q2XM"),
		"group chat":        upd("group", -100, "/start A7K9-Q2XM"),
		"supergroup":        upd("supergroup", -100, "/start A7K9-Q2XM"),
		"channel":           upd("channel", -100, "/start A7K9-Q2XM"),
		"chat id zero":      upd("private", 0, "/start A7K9-Q2XM"),
		"another bot":       upd("private", 42, "/start@OtherBot A7K9-Q2XM"),
		"not json":          []byte("nope"),
		"no message":        []byte(`{"update_id":1,"edited_message":{"chat":{"id":1,"type":"private"},"text":"/start A7K9-Q2XM"}}`),
		"empty object":      []byte(`{}`),
		"callback only":     []byte(`{"update_id":1,"callback_query":{"id":"1"}}`),
		"text is a number":  []byte(`{"message":{"chat":{"id":1,"type":"private"},"text":5}}`),
		"@ without name ok": upd("private", 42, "/start@ A7K9-Q2XM"),
	}
	for name, body := range bad {
		bot := ""
		if name == "another bot" || name == "@ without name ok" {
			bot = "MyBot"
		}
		if st, ok := ParseStart(body, bot); ok {
			t.Errorf("%s accepted: %+v", name, st)
		}
	}
}

func testClient(t *testing.T, token string, h http.HandlerFunc) (*Client, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	hc, err := egress.New(egress.Allow{Scheme: "http", Host: u.Host})
	if err != nil {
		t.Fatal(err)
	}
	return NewClient(token, hc).WithBaseURL(srv.URL), srv
}

// The request goes to /bot<token>/sendMessage with HTML mode and no link previews.
func TestSendMessageRequest(t *testing.T) {
	var path string
	var body map[string]any
	c, _ := testClient(t, "123:TOKEN", func(w http.ResponseWriter, r *http.Request) {
		path = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	if err := c.SendMessage(context.Background(), 42, "hi &amp; bye"); err != nil {
		t.Fatal(err)
	}
	if path != "/bot123:TOKEN/sendMessage" {
		t.Errorf("path %q", path)
	}
	if body["chat_id"] != float64(42) || body["text"] != "hi &amp; bye" || body["parse_mode"] != "HTML" || body["disable_web_page_preview"] != true {
		t.Errorf("body %v", body)
	}
}

// SEC-61: neither an API error nor a transport error exposes the bot token.
func TestSendMessageErrorsNeverContainToken(t *testing.T) {
	const token = "123456:SUPER-SECRET-TOKEN"
	c, srv := testClient(t, token, func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"ok":false,"description":"Forbidden: bot was blocked by the user"}`))
	})
	err := c.SendMessage(context.Background(), 1, "x")
	if err == nil || strings.Contains(err.Error(), token) || !strings.Contains(err.Error(), "403") {
		t.Fatalf("api error = %v", err)
	}
	srv.Close() // connection refused: net/http puts the URL (with the token) into the error
	err = c.SendMessage(context.Background(), 1, "x")
	if err == nil || strings.Contains(err.Error(), token) {
		t.Fatalf("transport error = %v", err)
	}
}

// SAF-13: the sender cannot reach any host other than the allow-listed one.
func TestSendMessageRespectsEgressAllowList(t *testing.T) {
	hc, err := egress.New(egress.Allow{Scheme: "https", Host: Host})
	if err != nil {
		t.Fatal(err)
	}
	c := NewClient("t", hc).WithBaseURL("https://example.invalid")
	err = c.SendMessage(context.Background(), 1, "x")
	if !errors.Is(err, egress.ErrNotAllowed) {
		t.Fatalf("expected ErrNotAllowed, got %v", err)
	}
}
