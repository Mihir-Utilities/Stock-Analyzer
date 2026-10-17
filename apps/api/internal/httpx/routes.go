package httpx

import "net/http"

type handlerKind int

const (
	kindStub           handlerKind = iota // 501 NOT_IMPLEMENTED until the owning task lands
	kindHealthz                           // GET /healthz
	kindReadyz                            // GET /readyz
	kindBrokerDisabled                    // 422 BROKER_DISABLED (manual price mode, D-1)
	kindAuthLogin                         // POST /auth/login
	kindAuthLogout
	kindAuthLogoutAll
	kindAuthMe
	kindAuthChangePassword
	kindJobStockRefresh // POST /stocks/{symbol}/refresh: 422 PRICE_MODE_MANUAL (B09)
	kindJobMFRefresh    // POST /mf/schemes/{code}/refresh (B09)
	kindJobGet          // GET /jobs/{id} (B09)
)

type limitKind int

const (
	limitNone limitKind = iota
	limitLogin
)

// route is one row of the contract. Path is relative to BasePath. Keep this table, openapi.yaml and
// docs/03-api-spec.md in sync (TestRoutesMatchOpenAPI enforces the first two).
type route struct {
	Method string
	Path   string
	Public bool // reachable without a session (docs/03 section 1)
	Limit  limitKind
	Body   int64 // 0 = DefaultBodyLimit
	NoCSRF bool  // authenticated by its own secret (Telegram webhook), so no CSRF header is required
	Kind   handlerKind
}

func (rt route) bodyLimit() int64 {
	if rt.Body > 0 {
		return rt.Body
	}
	return DefaultBodyLimit
}

func (rt route) handler(d Deps) http.Handler {
	switch rt.Kind {
	case kindHealthz:
		return http.HandlerFunc(healthz)
	case kindReadyz:
		return readyz(d)
	case kindBrokerDisabled:
		return Adapt(func(http.ResponseWriter, *http.Request) error {
			return NewError(http.StatusUnprocessableEntity, "BROKER_DISABLED",
				"Broker connection is disabled in manual price mode", nil)
		})
	case kindAuthLogin, kindAuthLogout, kindAuthLogoutAll, kindAuthMe, kindAuthChangePassword:
		return authHandler(d, rt.Kind)
	case kindJobStockRefresh, kindJobMFRefresh, kindJobGet:
		return jobHandler(d, rt.Kind)
	default:
		return Adapt(func(http.ResponseWriter, *http.Request) error {
			return NewError(http.StatusNotImplemented, CodeNotImplemented,
				"Not implemented yet", nil)
		})
	}
}

const (
	mGet    = http.MethodGet
	mPost   = http.MethodPost
	mPut    = http.MethodPut
	mPatch  = http.MethodPatch
	mDelete = http.MethodDelete
)

// routes lists every endpoint of docs/03-api-spec.md (sections 2-15). Broker routes other than
// /broker/status are not built in manual price mode and answer 422 BROKER_DISABLED (section 14a).
var routes = []route{
	// Ops (section 15)
	{Method: mGet, Path: "/healthz", Public: true, Kind: kindHealthz},
	{Method: mGet, Path: "/readyz", Kind: kindReadyz},
	{Method: mGet, Path: "/admin/status"},

	// Auth (section 2)
	{Method: mPost, Path: "/auth/login", Public: true, Limit: limitLogin, Kind: kindAuthLogin},
	{Method: mPost, Path: "/auth/logout", Kind: kindAuthLogout},
	{Method: mPost, Path: "/auth/logout-all", Kind: kindAuthLogoutAll},
	{Method: mGet, Path: "/auth/me", Kind: kindAuthMe},
	{Method: mPost, Path: "/auth/change-password", Kind: kindAuthChangePassword},

	// Stocks (sections 3-6)
	{Method: mGet, Path: "/stocks/index"},
	{Method: mGet, Path: "/stocks"},
	{Method: mGet, Path: "/stocks/{symbol}"},
	{Method: mGet, Path: "/stocks/{symbol}/prices"},
	{Method: mDelete, Path: "/stocks/{symbol}/prices"},
	{Method: mPost, Path: "/stocks/{symbol}/prices/delete-preview"},
	{Method: mPost, Path: "/prices/trim"},
	{Method: mPost, Path: "/prices/trim/preview"},
	{Method: mGet, Path: "/stocks/{symbol}/indicators"},
	{Method: mGet, Path: "/stocks/{symbol}/fundamentals"},
	{Method: mGet, Path: "/stocks/{symbol}/shareholding"},
	{Method: mGet, Path: "/stocks/{symbol}/events"},
	{Method: mGet, Path: "/stocks/{symbol}/peers"},
	{Method: mGet, Path: "/stocks/{symbol}/links"},
	{Method: mGet, Path: "/stocks/{symbol}/prediction"},

	// Jobs (section 7)
	{Method: mPost, Path: "/stocks/{symbol}/refresh", Kind: kindJobStockRefresh},
	{Method: mGet, Path: "/jobs/{id}", Kind: kindJobGet},
	{Method: mPost, Path: "/mf/schemes/{code}/refresh", Kind: kindJobMFRefresh},

	// Market and compare (section 8)
	{Method: mGet, Path: "/market/overview"},
	{Method: mGet, Path: "/market/holidays"},
	{Method: mGet, Path: "/compare"},

	// Screener (section 9)
	{Method: mPost, Path: "/screener/query"},
	{Method: mGet, Path: "/screener/saved"},
	{Method: mPost, Path: "/screener/saved"},
	{Method: mDelete, Path: "/screener/saved/{name}"},

	// Mutual funds (section 10)
	{Method: mGet, Path: "/mf/schemes"},
	{Method: mGet, Path: "/mf/schemes/{code}"},
	{Method: mGet, Path: "/mf/schemes/{code}/nav"},
	{Method: mGet, Path: "/mf/schemes/{code}/sip"},
	{Method: mGet, Path: "/mf/compare"},
	{Method: mGet, Path: "/mf/categories"},

	// Watchlist (section 11)
	{Method: mGet, Path: "/watchlist"},
	{Method: mPost, Path: "/watchlist"},
	{Method: mPatch, Path: "/watchlist/{id}"},
	{Method: mDelete, Path: "/watchlist/{id}"},

	// Portfolio (section 12)
	{Method: mGet, Path: "/portfolio/txns"},
	{Method: mPost, Path: "/portfolio/txns"},
	{Method: mPatch, Path: "/portfolio/txns/{id}"},
	{Method: mDelete, Path: "/portfolio/txns/{id}"},
	{Method: mGet, Path: "/portfolio/summary"},
	{Method: mGet, Path: "/portfolio/adjustments"},
	{Method: mPost, Path: "/portfolio/adjustments"},

	// Alerts and Telegram (section 13)
	{Method: mPost, Path: "/alerts"},
	{Method: mGet, Path: "/alerts"},
	{Method: mGet, Path: "/alerts/events"},
	{Method: mPatch, Path: "/alerts/{id}"},
	{Method: mDelete, Path: "/alerts/{id}"},
	{Method: mPost, Path: "/telegram/link-code"},
	{Method: mDelete, Path: "/telegram/link"},
	{Method: mPost, Path: "/telegram/test"},
	{Method: mPost, Path: "/telegram/webhook", Public: true, NoCSRF: true},

	// Imports and owner-entered data (section 14)
	{Method: mPost, Path: "/imports/{kind}/validate", Body: ImportBodyLimit},
	{Method: mPost, Path: "/imports/{kind}/commit"},
	{Method: mGet, Path: "/imports/batches"},
	{Method: mPost, Path: "/imports/batches/{id}/undo"},
	{Method: mGet, Path: "/imports/templates/{kind}"},
	{Method: mGet, Path: "/settings/prices-adjustment"},
	{Method: mPut, Path: "/settings/prices-adjustment"},
	{Method: mPost, Path: "/imports/prices/adjustment-check"},
	{Method: mPost, Path: "/instruments"},
	{Method: mPost, Path: "/stocks/{symbol}/results"},
	{Method: mDelete, Path: "/stocks/{symbol}/results"},
	{Method: mPost, Path: "/stocks/{symbol}/shareholding"},
	{Method: mPost, Path: "/stocks/{symbol}/actions"},
	{Method: mPatch, Path: "/stocks/{symbol}/actions/{id}"},

	// Broker (section 14a): only /broker/status is built; the rest answer 422 BROKER_DISABLED.
	{Method: mGet, Path: "/broker/status"},
	{Method: mGet, Path: "/broker/login", Kind: kindBrokerDisabled},
	{Method: mGet, Path: "/broker/callback", Public: true, Kind: kindBrokerDisabled},
	{Method: mDelete, Path: "/broker/session", Kind: kindBrokerDisabled},
}
