package egress

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// SAF-13: golangci-lint rejects direct HTTP client use outside internal/egress. The test lints a
// throwaway module with this repository's .golangci.yml. It needs the golangci-lint binary (CI runs
// the real lint step over the whole module; this proves the configuration itself).
func TestLintRejectsDirectHTTPUse(t *testing.T) {
	bin, err := exec.LookPath("golangci-lint")
	if err != nil {
		t.Skip("golangci-lint not on PATH; the CI lint step still enforces the rule")
	}
	cfg, err := os.ReadFile(filepath.Join("..", "..", ".golangci.yml"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, code string
		bad        bool
	}{
		{"http.Get", `r, _ := http.Get("https://example.test"); _ = r.Body.Close()`, true},
		{"http.Post", `r, _ := http.Post("https://example.test", "text/plain", nil); _ = r.Body.Close()`, true},
		{"http.DefaultClient", `_ = http.DefaultClient`, true},
		{"http.Client literal", `_ = &http.Client{}`, true},
		{"http.DefaultTransport", `_ = http.DefaultTransport`, true},
		{"no http use", `_ = 1`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			write := func(name, content string) {
				if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil { //nolint:gosec // fixed file names inside t.TempDir()
					t.Fatal(err)
				}
			}
			write("go.mod", "module probe\n\ngo 1.22\n")
			write(".golangci.yml", string(cfg))
			write("probe.go", "package probe\n\nimport \"net/http\"\n\nvar _ = http.StatusOK\n\nfunc F() {\n\t"+tc.code+"\n}\n")
			cmd := exec.Command(bin, "run", "./...") //nolint:gosec // fixed binary found on PATH, fixed arguments
			cmd.Dir = dir
			out, err := cmd.CombinedOutput()
			if tc.bad && (err == nil || !strings.Contains(string(out), "forbidigo")) {
				t.Fatalf("lint accepted %s: err=%v out=%s", tc.name, err, out)
			}
			if !tc.bad && err != nil {
				t.Fatalf("lint rejected clean code: %v\n%s", err, out)
			}
		})
	}
}
