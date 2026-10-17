package main

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

// Config problems stop the process before it listens (fail fast), and the message names the
// variable but never its value.
func TestRunFailsFastOnMissingConfig(t *testing.T) {
	env := map[string]string{"WORKER_HMAC_KEY": "short-secret-value"}
	var out bytes.Buffer
	err := run(context.Background(), func(k string) string { return env[k] }, &out)
	if err == nil {
		t.Fatal("expected an error")
	}
	for _, want := range []string{"DATABASE_URL", "WORKER_BASE_URL", "WORKER_HMAC_KEY"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %s: %v", want, err)
		}
	}
	if strings.Contains(err.Error(), "short-secret-value") {
		t.Fatal("error leaks a secret value")
	}
}
