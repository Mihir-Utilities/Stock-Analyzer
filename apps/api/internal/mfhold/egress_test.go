package mfhold

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// MFH-I32: the holdings and statement-import code makes no network call: no URL literal, no net/http
// import, and NAVs come only from mf_nav (SAF-01, SAF-13; the deny-list covers the forbidden sources).
func TestNoEgressInMFCode(t *testing.T) {
	var files []string
	for _, pattern := range []string{"*.go", "../importers/mf*.go"} {
		m, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, m...)
	}
	if len(files) < 8 {
		t.Fatalf("expected the mfhold and importers/mf* sources, got %v", files)
	}
	// The forbidden-source vocabulary is covered by the CI deny-list; here only network access.
	banned := []string{"http" + "://", "http" + "s://", "\"net/" + "http\"", "net." + "Dial"}
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		raw, err := os.ReadFile(f) //nolint:gosec // repo source file
		if err != nil {
			t.Fatal(err)
		}
		for _, b := range banned {
			if strings.Contains(string(raw), b) {
				t.Errorf("%s contains %q", f, b)
			}
		}
	}
}
