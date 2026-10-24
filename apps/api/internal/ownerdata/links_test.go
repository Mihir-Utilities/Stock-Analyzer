package ownerdata

import (
	"net/url"
	"strings"
	"testing"

	"github.com/india-analyzer/api/internal/testdb"
)

func TestRepoLinksFileIsValid(t *testing.T) {
	tpl, err := LoadLinks(testdb.ConfigDir() + "/research_links.json")
	if err != nil || len(tpl) == 0 {
		t.Fatalf("links: %v (%d)", err, len(tpl))
	}
}

// Acceptance: links contain a properly encoded M%26M.
func TestRenderLinksEncodes(t *testing.T) {
	tpl := []LinkTemplate{
		{Label: "NSE", URL: "https://example.test/quote?symbol={symbol}"},
		{Label: "Search", URL: "https://example.test/search?q={name}+results"},
	}
	got := RenderLinks(tpl, "M&M", "Mahindra & Mahindra Ltd")
	if got[0].URL != "https://example.test/quote?symbol=M%26M" {
		t.Errorf("symbol: %s", got[0].URL)
	}
	if got[1].URL != "https://example.test/search?q=Mahindra+%26+Mahindra+Ltd+results" {
		t.Errorf("name: %s", got[1].URL)
	}
	u, err := url.Parse(got[0].URL)
	if err != nil || u.Query().Get("symbol") != "M&M" {
		t.Errorf("round trip: %v %v", u, err)
	}
	if strings.Contains(RenderLinks(tpl, "BAJAJ-AUTO", "x")[0].URL, "%") {
		t.Error("hyphen must stay literal")
	}
	if got := RenderLinks(nil, "A", "B"); got == nil || len(got) != 0 {
		t.Errorf("want empty non-nil slice, got %#v", got)
	}
}

// A path placeholder must not turn a space into `+` (a literal plus in a path).
func TestRenderLinksPathPlaceholderUsesPathEscape(t *testing.T) {
	tpl := []LinkTemplate{{Label: "p", URL: "https://example.test/company/{name}/overview?q={name}"}}
	got := RenderLinks(tpl, "X", "Tata Motors Ltd")
	want := "https://example.test/company/Tata%20Motors%20Ltd/overview?q=Tata+Motors+Ltd"
	if got[0].URL != want {
		t.Fatalf("got %s, want %s", got[0].URL, want)
	}
}

func TestParseLinksRejects(t *testing.T) {
	for name, raw := range map[string]string{
		"http":        `{"links":[{"label":"a","url":"http://x.test/{symbol}"}]}`,
		"placeholder": `{"links":[{"label":"a","url":"https://x.test/{isin}"}]}`,
		"nolabel":     `{"links":[{"label":" ","url":"https://x.test/"}]}`,
		"badjson":     `{`,
	} {
		if _, err := ParseLinks([]byte(raw)); err == nil {
			t.Errorf("%s: expected error", name)
		}
	}
}
