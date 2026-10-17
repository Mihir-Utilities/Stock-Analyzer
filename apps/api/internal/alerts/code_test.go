package alerts

import (
	"strings"
	"testing"
)

// ALR-60: link codes are 8 characters from the unambiguous alphabet, shown as XXXX-XXXX, and
// normalisation accepts the display form in any case.
func TestGenerateAndNormalizeCode(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		display, norm, err := GenerateCode()
		if err != nil {
			t.Fatal(err)
		}
		if len(display) != 9 || display[4] != '-' || len(norm) != 8 || strings.Replace(display, "-", "", 1) != norm {
			t.Fatalf("bad shape %q / %q", display, norm)
		}
		for _, c := range norm {
			if !strings.ContainsRune(CodeAlphabet, c) || strings.ContainsRune("01OI", c) {
				t.Fatalf("char %q outside the alphabet", c)
			}
		}
		got, ok := NormalizeCode(strings.ToLower(display))
		if !ok || got != norm {
			t.Fatalf("normalize(%q) = %q, %v", display, got, ok)
		}
		seen[norm] = true
	}
	if len(seen) < 199 {
		t.Fatalf("codes repeat too often: %d distinct of 200", len(seen))
	}
}

func TestNormalizeCodeRejects(t *testing.T) {
	for _, s := range []string{"", "A7K9", "A7K9-Q2XM1", "A7K9-Q2X0", "A7K9-Q2XI", "a7k9 q2x!", "'; DROP TABLE"} {
		if _, ok := NormalizeCode(s); ok {
			t.Errorf("%q accepted", s)
		}
	}
	if n, ok := NormalizeCode(" a7k9 q2xm "); !ok || n != "A7K9Q2XM" {
		t.Errorf("spaces and dashes are ignored, got %q %v", n, ok)
	}
}

func TestHashCodeIsSHA256Hex32Bytes(t *testing.T) {
	h := HashCode("A7K9Q2XM")
	if len(h) != 32 {
		t.Fatalf("hash length %d", len(h))
	}
}
