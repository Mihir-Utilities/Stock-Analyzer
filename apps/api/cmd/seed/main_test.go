package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/india-analyzer/api/internal/passhash"
)

func TestHashPasswordCommand(t *testing.T) {
	var out, errOut bytes.Buffer
	if err := run([]string{"hash-password"}, strings.NewReader("a long test password\n"), &out, &errOut); err != nil {
		t.Fatal(err)
	}
	hash := strings.TrimSpace(out.String())
	if ok, err := passhash.Verify("a long test password", hash); err != nil || !ok {
		t.Fatalf("printed hash does not verify: %v %v", ok, err)
	}
	if strings.Contains(out.String(), "a long test password") {
		t.Fatal("output must not echo the password")
	}
}

func TestRunErrors(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		stdin   string
		wantErr string
	}{
		{"short password", []string{"hash-password"}, "short\n", "at least"},
		{"unknown command", []string{"frobnicate"}, "", "unknown command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			err := run(tc.args, strings.NewReader(tc.stdin), &out, &errOut)
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestSeedNeedsDatabaseURL(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	var out, errOut bytes.Buffer
	err := run(nil, strings.NewReader(""), &out, &errOut)
	if err == nil || !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("err = %v", err)
	}
}
