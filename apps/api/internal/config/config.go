// Package config loads and validates the API configuration from environment variables
// (CLAUDE.md 0.7: no secrets in code; docs/03-api-spec.md; .env.example; MASTER_PLAN section 5).
package config

import (
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// Config holds validated settings. Secrets are never printed: use Secrets() to feed the log scrubber.
type Config struct {
	Port     int
	LogLevel string

	DatabaseURL   string
	WorkerBaseURL *url.URL
	WorkerHMACKey string

	AppBaseURL   string
	APIPublicURL string

	InitialPasswordHash   string
	TelegramBotToken      string
	TelegramWebhookSecret string
	TelegramBotUsername   string
	BrokerTokenKey        string

	// Tunables (MASTER_PLAN section 5); an env var overrides the stored default.
	SessionDays          int
	LoginMaxFails        int
	TrustedProxyHops     int
	RefreshCooldownMin   int
	RefreshGlobalPerHour int
	DBSoftLimitMB        int
}

const minHMACKeyLen = 32

var logLevels = map[string]bool{"trace": true, "debug": true, "info": true, "warn": true, "error": true}

// Load reads the configuration through getenv (os.Getenv in production) and returns every
// validation problem at once. Error text never contains a variable's value.
func Load(getenv func(string) string) (Config, error) {
	var p problems
	get := func(k string) string { return strings.TrimSpace(getenv(k)) }
	c := Config{
		Port:                  p.intIn(get("PORT"), "PORT", 8080, 1, 65535),
		LogLevel:              strings.ToLower(get("LOG_LEVEL")),
		DatabaseURL:           get("DATABASE_URL"),
		WorkerHMACKey:         get("WORKER_HMAC_KEY"),
		AppBaseURL:            get("APP_BASE_URL"),
		APIPublicURL:          get("API_PUBLIC_URL"),
		InitialPasswordHash:   get("INITIAL_PASSWORD_HASH"),
		TelegramBotToken:      get("TELEGRAM_BOT_TOKEN"),
		TelegramWebhookSecret: get("TELEGRAM_WEBHOOK_SECRET"),
		TelegramBotUsername:   get("TELEGRAM_BOT_USERNAME"),
		BrokerTokenKey:        get("BROKER_TOKEN_KEY"),
		SessionDays:           p.intIn(get("SESSION_DAYS"), "SESSION_DAYS", 30, 1, 365),
		LoginMaxFails:         p.intIn(get("LOGIN_MAX_FAILS"), "LOGIN_MAX_FAILS", 5, 1, 100),
		TrustedProxyHops:      p.intIn(get("TRUSTED_PROXY_HOPS"), "TRUSTED_PROXY_HOPS", 0, 0, 5),
		RefreshCooldownMin:    p.intIn(get("REFRESH_COOLDOWN_MIN"), "REFRESH_COOLDOWN_MIN", 15, 1, 1440),
		RefreshGlobalPerHour:  p.intIn(get("REFRESH_GLOBAL_PER_HOUR"), "REFRESH_GLOBAL_PER_HOUR", 30, 1, 1000),
		DBSoftLimitMB:         p.intIn(get("DB_SOFT_LIMIT_MB"), "DB_SOFT_LIMIT_MB", 380, 1, 100000),
	}
	if c.LogLevel == "" {
		c.LogLevel = "info"
	} else if !logLevels[c.LogLevel] {
		p.add("LOG_LEVEL must be one of trace, debug, info, warn, error")
	}

	if c.DatabaseURL == "" {
		p.add("DATABASE_URL is required")
	} else if u, err := url.Parse(c.DatabaseURL); err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Host == "" {
		p.add("DATABASE_URL must be a postgres:// or postgresql:// URL")
	}

	if len(c.WorkerHMACKey) < minHMACKeyLen {
		p.add(fmt.Sprintf("WORKER_HMAC_KEY is required and must be at least %d characters", minHMACKeyLen))
	}

	if raw := get("WORKER_BASE_URL"); raw == "" {
		p.add("WORKER_BASE_URL is required")
	} else if u, err := parseBaseURL(raw); err != nil {
		p.add("WORKER_BASE_URL " + err.Error())
	} else {
		c.WorkerBaseURL = u
	}

	for _, k := range []string{"APP_BASE_URL", "API_PUBLIC_URL"} {
		if v := get(k); v != "" {
			if _, err := parseBaseURL(v); err != nil {
				p.add(k + " " + err.Error())
			}
		}
	}

	if c.BrokerTokenKey != "" {
		if key, err := base64.StdEncoding.DecodeString(c.BrokerTokenKey); err != nil || len(key) != 32 {
			p.add("BROKER_TOKEN_KEY must be 32 random bytes, base64 encoded")
		}
	}
	if strings.EqualFold(get("BROKER_ENABLED"), "true") {
		p.add("BROKER_ENABLED=true is not supported: manual price mode is the only mode (decision D-1)")
	}
	if c.TelegramBotToken != "" && c.TelegramWebhookSecret == "" {
		p.add("TELEGRAM_WEBHOOK_SECRET is required when TELEGRAM_BOT_TOKEN is set")
	}

	if err := p.err(); err != nil {
		return Config{}, err
	}
	return c, nil
}

// Secrets returns every secret value so the log scrubber can redact them literally.
func (c Config) Secrets() []string {
	var out []string
	for _, s := range []string{
		c.DatabaseURL, c.WorkerHMACKey, c.InitialPasswordHash, c.TelegramBotToken,
		c.TelegramWebhookSecret, c.BrokerTokenKey,
	} {
		if s != "" {
			out = append(out, s)
		}
	}
	if u, err := url.Parse(c.DatabaseURL); err == nil && u.User != nil {
		if pw, ok := u.User.Password(); ok && pw != "" {
			out = append(out, pw)
		}
	}
	return out
}

func parseBaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return nil, errors.New("must be an http(s) URL with a host")
	}
	if u.User != nil {
		return nil, errors.New("must not contain credentials")
	}
	return u, nil
}

type problems []string

func (p *problems) add(s string) { *p = append(*p, s) }

func (p *problems) err() error {
	if len(*p) == 0 {
		return nil
	}
	return errors.New("invalid configuration: " + strings.Join(*p, "; "))
}

func (p *problems) intIn(raw, name string, def, lo, hi int) int {
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n < lo || n > hi {
		p.add(fmt.Sprintf("%s must be an integer between %d and %d", name, lo, hi))
		return def
	}
	return n
}
