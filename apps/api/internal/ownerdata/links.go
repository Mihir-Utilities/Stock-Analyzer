package ownerdata

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strings"
)

// LinkTemplate is one entry of config/research_links.json.
type LinkTemplate struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

// Link is a rendered research hyperlink. The server never requests these URLs (docs/03 section 5,
// docs/01 section 9, SAF-06): they are only strings handed to the owner's browser.
type Link struct {
	Label string `json:"label"`
	URL   string `json:"url"`
}

var placeholderRe = regexp.MustCompile(`\{[^{}]*\}`)

// ParseLinks validates the content of research_links.json: https URLs only and no placeholder
// other than {symbol} and {name}.
func ParseLinks(raw []byte) ([]LinkTemplate, error) {
	var f struct {
		Links []LinkTemplate `json:"links"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("research_links.json: %w", err)
	}
	for i, l := range f.Links {
		if strings.TrimSpace(l.Label) == "" {
			return nil, fmt.Errorf("research_links.json: link %d has no label", i)
		}
		if !strings.HasPrefix(l.URL, "https://") {
			return nil, fmt.Errorf("research_links.json: link %q must be an https URL", l.Label)
		}
		for _, p := range placeholderRe.FindAllString(l.URL, -1) {
			if p != "{symbol}" && p != "{name}" {
				return nil, fmt.Errorf("research_links.json: link %q has unknown placeholder %s", l.Label, p)
			}
		}
	}
	return f.Links, nil
}

// LoadLinks reads and validates the file at path.
func LoadLinks(path string) ([]LinkTemplate, error) {
	raw, err := os.ReadFile(path) //nolint:gosec // operator-supplied config directory
	if err != nil {
		return nil, fmt.Errorf("research_links.json: %w", err)
	}
	return ParseLinks(raw)
}

// pathEscape encodes a value for a URL path: the conservative query-style escaping (M&M -> M%26M)
// but with spaces as %20, because `+` is a literal plus in a path.
func pathEscape(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "+", "%20") }

// RenderLinks substitutes {symbol} and {name}, URL-encoding both: placeholders in the path part
// of a template use path escaping (spaces -> %20), those after `?` or `#` use query escaping
// (M&M -> M%26M, spaces -> +). It always returns a non-nil slice.
func RenderLinks(tpl []LinkTemplate, symbol, name string) []Link {
	path := strings.NewReplacer("{symbol}", pathEscape(symbol), "{name}", pathEscape(name))
	query := strings.NewReplacer("{symbol}", url.QueryEscape(symbol), "{name}", url.QueryEscape(name))
	out := make([]Link, 0, len(tpl))
	for _, t := range tpl {
		head, tail := t.URL, ""
		if i := strings.IndexAny(t.URL, "?#"); i >= 0 {
			head, tail = t.URL[:i], t.URL[i:]
		}
		out = append(out, Link{Label: t.Label, URL: path.Replace(head) + query.Replace(tail)})
	}
	return out
}
