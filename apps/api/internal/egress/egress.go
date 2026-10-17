// Package egress is the ONLY outbound HTTP client of the Go API (decision D-N, SAF-13,
// docs/00-legal-and-safety.md section 1, CLAUDE.md section 7).
//
// The API never calls third-party sites. The transport allows exactly the configured hosts
// (the worker base URL, plus api.telegram.org once B12 needs it), checks every request and every
// redirect hop before any socket is opened, rejects other schemes, credentials in URLs and IP
// literals that are not themselves allow-listed, and guards the dial again. golangci-lint
// (forbidigo) forbids http.Get/Post/Head/PostForm, http.DefaultClient/DefaultTransport and
// http.Client outside this package.
package egress

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// ErrNotAllowed is returned (wrapped) for any request outside the allow-list.
var ErrNotAllowed = errors.New("egress: destination not allowed")

const maxRedirects = 3

// Allow is one permitted destination. Host is a hostname or IP literal with an optional port; the
// port defaults to 443 for https and 80 for http. Scheme must match exactly.
type Allow struct {
	Scheme string
	Host   string
}

// FromURL builds an Allow from a base URL such as WORKER_BASE_URL.
func FromURL(u *url.URL) Allow { return Allow{Scheme: u.Scheme, Host: u.Host} }

// Client wraps an http.Client whose transport enforces the allow-list.
type Client struct {
	hc      *http.Client
	allowed map[string]struct{} // "scheme://host:port"
	dialOK  map[string]struct{} // "host:port"
}

// New builds a client for the given destinations. At least one is required.
func New(allows ...Allow) (*Client, error) {
	if len(allows) == 0 {
		return nil, errors.New("egress: at least one allowed destination is required")
	}
	c := &Client{allowed: map[string]struct{}{}, dialOK: map[string]struct{}{}}
	for _, a := range allows {
		scheme := strings.ToLower(a.Scheme)
		if scheme != "https" && scheme != "http" {
			return nil, fmt.Errorf("egress: scheme %q not supported", a.Scheme)
		}
		hostport, err := normalizeHost(scheme, a.Host)
		if err != nil {
			return nil, err
		}
		c.allowed[scheme+"://"+hostport] = struct{}{}
		c.dialOK[hostport] = struct{}{}
	}
	base := &http.Transport{
		Proxy:                 nil, // never route through an ambient proxy
		DialContext:           c.guardedDial,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		MaxIdleConns:          4,
		IdleConnTimeout:       60 * time.Second,
	}
	c.hc = &http.Client{
		Transport: &guardTransport{c: c, next: base},
		Timeout:   90 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > maxRedirects {
				return fmt.Errorf("%w: too many redirects", ErrNotAllowed)
			}
			return c.check(req.URL)
		},
	}
	return c, nil
}

// Do sends the request if, and only if, its destination (and every redirect hop) is allowed.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if err := c.check(req.URL); err != nil {
		return nil, err
	}
	return c.hc.Do(req)
}

// Allowed reports whether a URL would be accepted, without sending anything.
func (c *Client) Allowed(u *url.URL) bool { return c.check(u) == nil }

func (c *Client) check(u *url.URL) error {
	if u == nil {
		return fmt.Errorf("%w: missing URL", ErrNotAllowed)
	}
	if u.User != nil {
		return fmt.Errorf("%w: credentials in URL", ErrNotAllowed)
	}
	scheme := strings.ToLower(u.Scheme)
	hostport, err := normalizeHost(scheme, u.Host)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrNotAllowed, err)
	}
	if _, ok := c.allowed[scheme+"://"+hostport]; !ok {
		return fmt.Errorf("%w: %s://%s", ErrNotAllowed, scheme, hostport)
	}
	return nil
}

func (c *Client) guardedDial(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("%w: bad address", ErrNotAllowed)
	}
	if _, ok := c.dialOK[net.JoinHostPort(strings.ToLower(strings.TrimSuffix(host, ".")), port)]; !ok {
		return nil, fmt.Errorf("%w: dial %s", ErrNotAllowed, addr)
	}
	var d net.Dialer
	return d.DialContext(ctx, network, addr)
}

type guardTransport struct {
	c    *Client
	next http.RoundTripper
}

// RoundTrip runs for the first request and for every redirect hop, before any socket is opened.
func (g *guardTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if err := g.c.check(req.URL); err != nil {
		if req.Body != nil {
			_ = req.Body.Close()
		}
		return nil, err
	}
	return g.next.RoundTrip(req)
}

// normalizeHost lowercases, strips a trailing dot and adds the default port.
func normalizeHost(scheme, host string) (string, error) {
	if scheme != "https" && scheme != "http" {
		return "", fmt.Errorf("scheme %q not supported", scheme)
	}
	if host == "" {
		return "", errors.New("empty host")
	}
	h, p, err := net.SplitHostPort(host)
	if err != nil {
		h, p = strings.Trim(host, "[]"), ""
	}
	h = strings.ToLower(strings.TrimSuffix(h, "."))
	if h == "" {
		return "", errors.New("empty host")
	}
	if p == "" {
		p = map[string]string{"https": "443", "http": "80"}[scheme]
	}
	return net.JoinHostPort(h, p), nil
}
