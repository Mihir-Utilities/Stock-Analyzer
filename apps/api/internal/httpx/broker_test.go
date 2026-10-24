package httpx

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
)

// B08 (manual price mode): status reports disabled; every other broker route is 422 BROKER_DISABLED.
func TestBrokerStatusManualMode(t *testing.T) {
	h := NewRouter(testDeps(&bytes.Buffer{}))
	rec := do(h, http.MethodGet, "/api/v1/broker/status", "", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Data struct {
			Enabled *bool  `json:"enabled"`
			Mode    string `json:"mode"`
		} `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Data.Enabled == nil || *got.Data.Enabled || got.Data.Mode != "manual" {
		t.Fatalf("unexpected body %s", rec.Body.String())
	}
}

func TestBrokerOtherRoutesDisabled(t *testing.T) {
	h := NewRouter(testDeps(&bytes.Buffer{}))
	for _, c := range [][2]string{
		{http.MethodGet, "/api/v1/broker/login"},
		{http.MethodGet, "/api/v1/broker/callback"},
		{http.MethodDelete, "/api/v1/broker/session"},
	} {
		rec := do(h, c[0], c[1], "", nil)
		if rec.Code != http.StatusUnprocessableEntity || decodeErr(t, rec).Error.Code != "BROKER_DISABLED" {
			t.Fatalf("%s %s: %d %s", c[0], c[1], rec.Code, rec.Body.String())
		}
	}
}
