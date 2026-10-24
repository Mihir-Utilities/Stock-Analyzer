package main

import (
	"os"
	"path/filepath"

	"github.com/india-analyzer/api/internal/dbq"
	"github.com/india-analyzer/api/internal/ownerdata"
)

// ownerDataService wires the B05 read service. The research link templates come from
// CONFIG_DIR/research_links.json (default ./config); a missing or invalid file stops startup so a
// broken template is never served.
func ownerDataService(db dbq.DBTX) (*ownerdata.Service, error) {
	dir := os.Getenv("CONFIG_DIR")
	if dir == "" {
		dir = "config"
	}
	links, err := ownerdata.LoadLinks(filepath.Join(dir, "research_links.json"))
	if err != nil {
		return nil, err
	}
	return ownerdata.New(db, links), nil
}
