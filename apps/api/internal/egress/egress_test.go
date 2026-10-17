package egress

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

// counting returns a server that counts the requests it receives.
func counting(h http.HandlerFunc) (*httptest.Server, *atomic.Int32) {
	var n atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n.Add(1)
		if h != nil {
			h(w, r)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	return srv, &n
}

func get(t *testing.T, c *Client, raw string) (*http.Response, error) {
	t.Helper()
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, raw, nil)
	if err != nil {
		t.Fatal(err)
	}
	return c.Do(req)
}

// getErr sends a request that is expected to fail and returns only the error.
func getErr(t *testing.T, c *Client, raw string) error {
	t.Helper()
	resp, err := get(t, c, raw)
	if resp != nil {
		_ = resp.Body.Close()
	}
	return err
}

func hostOf(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	return u.Host
}

// SAF-13: an allowed host works.
func TestAllowedHostWorks(t *testing.T) {
	srv, hits := counting(nil)
	defer srv.Close()
	c, err := New(Allow{Scheme: "http", Host: hostOf(t, srv)})
	if err != nil {
		t.Fatal(err)
	}
	resp, err := get(t, c, srv.URL+"/x")
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if hits.Load() != 1 {
		t.Fatalf("hits = %d", hits.Load())
	}
}

// SAF-13: requests outside the allow-list fail before dialing (the other server sees nothing).
func TestDisallowedDestinationsRejectedBeforeDial(t *testing.T) {
	allowed, _ := counting(nil)
	defer allowed.Close()
	other, otherHits := counting(nil)
	defer other.Close()
	c, err := New(Allow{Scheme: "http", Host: hostOf(t, allowed)})
	if err != nil {
		t.Fatal(err)
	}
	otherURL, _ := url.Parse(other.URL)
	cases := []struct{ name, url string }{
		{"other host and port", other.URL + "/x"},
		{"ip literal", "http://127.0.0.1:" + otherURL.Port() + "/x"},
		{"other scheme (https to an http-only entry)", "https://" + hostOf(t, allowed) + "/x"},
		{"unlisted domain", "http://unlisted.example.test/x"},
		{"credentials trick", "http://" + hostOf(t, allowed) + "@" + hostOf(t, other) + "/x"},
		{"credentials in allowed host url", "http://user:pw@" + hostOf(t, allowed) + "/x"},
		{"suffix trick", "http://127.0.0.1.unlisted.example.test:" + otherURL.Port() + "/x"},
		{"ftp", "ftp://" + hostOf(t, allowed) + "/x"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := getErr(t, c, tc.url)
			if !errors.Is(err, ErrNotAllowed) {
				t.Fatalf("err = %v, want ErrNotAllowed", err)
			}
		})
	}
	if otherHits.Load() != 0 {
		t.Fatalf("a disallowed server was contacted %d times", otherHits.Load())
	}
}

// SAF-13: a redirect hop to a non-allowed host fails before dialing it.
func TestRedirectToOtherHostRejected(t *testing.T) {
	other, otherHits := counting(nil)
	defer other.Close()
	allowed, allowedHits := counting(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/landing", http.StatusFound)
	})
	defer allowed.Close()
	c, err := New(Allow{Scheme: "http", Host: hostOf(t, allowed)})
	if err != nil {
		t.Fatal(err)
	}
	err = getErr(t, c, allowed.URL+"/start")
	if !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v, want ErrNotAllowed", err)
	}
	if allowedHits.Load() != 1 || otherHits.Load() != 0 {
		t.Fatalf("allowed hits %d (want 1), other hits %d (want 0)", allowedHits.Load(), otherHits.Load())
	}
}

func TestRedirectLoopWithinAllowedHostIsBounded(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, srv.URL+"/again", http.StatusFound)
	}))
	defer srv.Close()
	c, _ := New(Allow{Scheme: "http", Host: hostOf(t, srv)})
	if err := getErr(t, c, srv.URL); !errors.Is(err, ErrNotAllowed) {
		t.Fatalf("err = %v", err)
	}
}

func TestHostMatchingIsCaseAndDotInsensitiveWithDefaultPorts(t *testing.T) {
	c, err := New(Allow{Scheme: "https", Host: "API.Example.Test."}, Allow{Scheme: "https", Host: "other.example.test:8443"})
	if err != nil {
		t.Fatal(err)
	}
	ok := []string{"https://api.example.test/a", "https://API.EXAMPLE.TEST:443/a", "https://other.example.test:8443/b"}
	bad := []string{"http://api.example.test/a", "https://api.example.test:8443/a", "https://other.example.test/b", "https://example.test/"}
	for _, raw := range ok {
		u, _ := url.Parse(raw)
		if !c.Allowed(u) {
			t.Errorf("%s should be allowed", raw)
		}
	}
	for _, raw := range bad {
		u, _ := url.Parse(raw)
		if c.Allowed(u) {
			t.Errorf("%s should be rejected", raw)
		}
	}
}

func TestNewValidatesInput(t *testing.T) {
	if _, err := New(); err == nil {
		t.Fatal("empty allow-list accepted")
	}
	if _, err := New(Allow{Scheme: "ftp", Host: "x.example.test"}); err == nil {
		t.Fatal("ftp accepted")
	}
	if _, err := New(Allow{Scheme: "https", Host: ""}); err == nil {
		t.Fatal("empty host accepted")
	}
}

func TestDialGuardRejectsUnlistedAddress(t *testing.T) {
	c, _ := New(Allow{Scheme: "https", Host: "api.example.test"})
	_, err := c.guardedDial(context.Background(), "tcp", "127.0.0.1:9")
	if !errors.Is(err, ErrNotAllowed) || !strings.Contains(err.Error(), "dial") {
		t.Fatalf("err = %v", err)
	}
}
