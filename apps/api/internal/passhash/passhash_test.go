package passhash

import (
	"strings"
	"testing"
)

func TestHashVerify(t *testing.T) {
	h, err := Hash("correct horse battery")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(h, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatalf("unexpected encoding: %s", h)
	}
	if err := Validate(h); err != nil {
		t.Fatalf("Validate: %v", err)
	}
	cases := []struct {
		name, password string
		want           bool
	}{
		{"right password", "correct horse battery", true},
		{"wrong password", "correct horse batterY", false},
		{"empty password", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Verify(tc.password, h)
			if err != nil || got != tc.want {
				t.Fatalf("Verify = %v, %v; want %v", got, err, tc.want)
			}
		})
	}
}

func TestHashRejectsShortPasswordAndSaltsDiffer(t *testing.T) {
	if _, err := Hash("short"); err == nil {
		t.Fatal("expected error for short password")
	}
	a, _ := Hash("another long password")
	b, _ := Hash("another long password")
	if a == b {
		t.Fatal("hashes must be salted")
	}
}

func TestValidateRejectsMalformed(t *testing.T) {
	cases := []string{
		"",
		"plaintext-password",
		"$argon2i$v=19$m=19456,t=2,p=1$c2FsdA$a2V5",
		"$argon2id$v=18$m=19456,t=2,p=1$c2FsdA$a2V5",
		"$argon2id$v=19$m=0,t=2,p=1$c2FsdA$a2V5",
		"$argon2id$v=19$m=19456,t=2,p=1$!!$a2V5",
		"$argon2id$v=19$m=19456,t=2,p=1$c2FsdA",
	}
	for _, c := range cases {
		if err := Validate(c); err == nil {
			t.Errorf("Validate(%q) accepted a malformed hash", c)
		}
	}
}
