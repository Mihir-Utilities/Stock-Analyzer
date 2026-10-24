package config

import (
	"encoding/base64"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

const dbPw = "s3cretpw"

func valid() map[string]string {
	return map[string]string{
		"DATABASE_URL":    "postgres://u:" + dbPw + "@db.example.test/app?sslmode=require",
		"WORKER_HMAC_KEY": strings.Repeat("k", 40),
		"WORKER_BASE_URL": "https://worker.example.test",
	}
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(valid()))
	if err != nil {
		t.Fatal(err)
	}
	if c.Port != 8080 || c.LogLevel != "info" || c.SessionDays != 30 || c.LoginMaxFails != 5 ||
		c.RefreshCooldownMin != 15 || c.RefreshGlobalPerHour != 30 || c.DBSoftLimitMB != 380 {
		t.Fatalf("unexpected defaults: %+v", c)
	}
	if c.WorkerBaseURL.Host != "worker.example.test" {
		t.Fatalf("worker url: %v", c.WorkerBaseURL)
	}
}

// API-07
func TestLoadFailFast(t *testing.T) {
	good32 := base64.StdEncoding.EncodeToString(make([]byte, 32))
	cases := []struct {
		name   string
		mutate func(map[string]string)
		want   string
	}{
		{"missing database url", func(m map[string]string) { delete(m, "DATABASE_URL") }, "DATABASE_URL is required"},
		{"bad database scheme", func(m map[string]string) { m["DATABASE_URL"] = "mysql://x/y" }, "DATABASE_URL must be"},
		{"missing hmac", func(m map[string]string) { delete(m, "WORKER_HMAC_KEY") }, "WORKER_HMAC_KEY"},
		{"short hmac", func(m map[string]string) { m["WORKER_HMAC_KEY"] = "short" }, "WORKER_HMAC_KEY"},
		{"missing worker url", func(m map[string]string) { delete(m, "WORKER_BASE_URL") }, "WORKER_BASE_URL is required"},
		{"worker url with creds", func(m map[string]string) { m["WORKER_BASE_URL"] = "https://a:b@w.example.test" }, "credentials"},
		{"worker url wrong scheme", func(m map[string]string) { m["WORKER_BASE_URL"] = "ftp://w.example.test" }, "http(s)"},
		{"bad port", func(m map[string]string) { m["PORT"] = "70000" }, "PORT"},
		{"bad tunable", func(m map[string]string) { m["SESSION_DAYS"] = "abc" }, "SESSION_DAYS"},
		{"negative proxy hops", func(m map[string]string) { m["TRUSTED_PROXY_HOPS"] = "-1" }, "TRUSTED_PROXY_HOPS"},
		{"huge proxy hops", func(m map[string]string) { m["TRUSTED_PROXY_HOPS"] = "9" }, "TRUSTED_PROXY_HOPS"},
		{"non-numeric proxy hops", func(m map[string]string) { m["TRUSTED_PROXY_HOPS"] = "one" }, "TRUSTED_PROXY_HOPS"},
		{"bad log level", func(m map[string]string) { m["LOG_LEVEL"] = "loud" }, "LOG_LEVEL"},
		{"bad broker key", func(m map[string]string) { m["BROKER_TOKEN_KEY"] = "not-base64-32" }, "BROKER_TOKEN_KEY"},
		{"broker enabled", func(m map[string]string) { m["BROKER_ENABLED"] = "true" }, "BROKER_ENABLED"},
		{"telegram without secret", func(m map[string]string) { m["TELEGRAM_BOT_TOKEN"] = "x" }, "TELEGRAM_WEBHOOK_SECRET"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := valid()
			tc.mutate(m)
			_, err := Load(env(m))
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want containing %q", err, tc.want)
			}
		})
	}
	m := valid()
	m["BROKER_TOKEN_KEY"] = good32
	if _, err := Load(env(m)); err != nil {
		t.Fatalf("valid broker key rejected: %v", err)
	}
}

func TestErrorsNeverContainValues(t *testing.T) {
	m := valid()
	m["WORKER_HMAC_KEY"] = "tooshort-secret"
	m["BROKER_TOKEN_KEY"] = "leaky-broker-key"
	_, err := Load(env(m))
	if err == nil {
		t.Fatal("expected error")
	}
	for _, leak := range []string{"tooshort-secret", "leaky-broker-key", "s3cretpw"} {
		if strings.Contains(err.Error(), leak) {
			t.Fatalf("error leaks %q: %v", leak, err)
		}
	}
}

func TestSecretsIncludesDatabasePassword(t *testing.T) {
	c, err := Load(env(valid()))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range c.Secrets() {
		if s == "s3cretpw" {
			found = true
		}
	}
	if !found {
		t.Fatalf("secrets = %v", c.Secrets())
	}
}
