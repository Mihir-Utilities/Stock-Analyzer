// Command api is the India Stock & MF Analyzer HTTP API (T00 skeleton: hello-world only).
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"
)

// newMux builds the router. Routes beyond /healthz arrive in B01.
func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"ok": true})
	})
	return mux
}

func main() {
	port := 8080
	if v := os.Getenv("PORT"); v != "" {
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 {
			log.Fatal("PORT must be an integer between 1 and 65535")
		}
		port = p
	}
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(port),
		Handler:           newMux(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Printf("api listening on :%d", port)
	log.Fatal(srv.ListenAndServe())
}
