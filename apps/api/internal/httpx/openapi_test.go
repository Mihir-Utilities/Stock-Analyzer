package httpx

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/go-chi/chi/v5"
)

func loadSpec(t *testing.T) *openapi3.T {
	t.Helper()
	path, err := filepath.Abs(filepath.Join("..", "..", "..", "..", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	doc, err := openapi3.NewLoader().LoadFromFile(path)
	if err != nil {
		t.Fatalf("load openapi.yaml: %v", err)
	}
	return doc
}

// The OpenAPI document validates.
func TestOpenAPIValidates(t *testing.T) {
	if err := loadSpec(t).Validate(context.Background()); err != nil {
		t.Fatalf("openapi.yaml invalid: %v", err)
	}
}

// Every documented operation exists in the router and vice versa (contract-first rule).
// API-08
func TestRoutesMatchOpenAPI(t *testing.T) {
	doc := loadSpec(t)
	want := map[string]bool{}
	for path, item := range doc.Paths.Map() {
		for method := range item.Operations() {
			want[method+" "+BasePath+path] = true
		}
	}
	got := map[string]bool{}
	err := chi.Walk(NewRouter(testDeps(&bytes.Buffer{})), func(method, route string, _ http.Handler, _ ...func(http.Handler) http.Handler) error {
		if route == "/healthz" { // root alias of the health check
			return nil
		}
		got[method+" "+strings.TrimSuffix(route, "/")] = true
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for k := range want {
		if !got[k] {
			t.Errorf("in openapi.yaml but not in the router: %s", k)
		}
	}
	for k := range got {
		if !want[k] {
			t.Errorf("in the router but not in openapi.yaml: %s", k)
		}
	}
}

// Every stub answers with a JSON envelope (never a bare 404 or an HTML page).
func TestEveryOperationAnswersWithEnvelope(t *testing.T) {
	doc := loadSpec(t)
	d := testDeps(&bytes.Buffer{})
	d.Pinger = &fakePinger{}
	h := NewRouter(d)
	param := regexp.MustCompile(`\{[a-z]+\}`)
	for path, item := range doc.Paths.Map() {
		for method := range item.Operations() {
			target := BasePath + param.ReplaceAllString(path, "1")
			req := httptest.NewRequest(method, target, strings.NewReader("{}"))
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			switch rec.Code {
			case 200:
				if !strings.Contains(rec.Body.String(), `"ok"`) && !strings.Contains(rec.Body.String(), `"data"`) {
					t.Errorf("%s %s: unexpected 200 body %s", method, path, rec.Body.String())
				}
			case http.StatusNotImplemented, http.StatusUnprocessableEntity:
				if decodeErr(t, rec).Error.Code == "" {
					t.Errorf("%s %s: no envelope", method, path)
				}
			default:
				t.Errorf("%s %s: status %d %s", method, path, rec.Code, rec.Body.String())
			}
		}
	}
}
