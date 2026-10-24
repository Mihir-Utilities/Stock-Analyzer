"""mfapi.in adapter (docs/01 section 4; spike S6). The only module that knows mfapi's JSON shape.

* ``data`` order is newest first in practice (V, S6) but is always sorted ascending here (MF-15).
* Weekend-dated NAVs are valid and kept (MF-16); non-numeric or <= 0 NAVs are skipped (MF-02);
  dates are ``DD-MM-YYYY`` (MF-03).
* List items are camelCase, history ``meta`` is snake_case.
* Rows that fail validation are rejected and counted; a bad envelope raises ``SchemaError`` and
  nothing is written.
"""

from __future__ import annotations

import random
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Any, Protocol

from pydantic import BaseModel, ConfigDict, ValidationError

from worker.adapters.base import (
    SchemaError,
    SourceGuard,
    clean_isin,
    guarded_get,
    parse_date_dmy,
    parse_nav,
    parse_scheme_code,
)
from worker.adapters.mfnames import classify_plan_option
from worker.egress import HttpClient

SOURCE = "mfapi"
MFAPI_BASE = "https://api.mfapi.in"
ATTRIBUTION = "NAV data: AMFI via mfapi.in"  # docs/01 section 4; docs/00 section 1 rule 6
MAX_LIST_BYTES = 30 * 1024 * 1024  # one /mf page of 10000 schemes is ~1 MB
MAX_HISTORY_BYTES = 8 * 1024 * 1024  # a full scheme history is ~0.3 MB
LIST_PAGE_SIZE = 10000  # MF-18 / S6: limit=10000 is accepted
LIST_MAX_PAGES = 20  # safety stop; the list is about 38k schemes (4 pages)
DEFAULT_MIN_INTERVAL_S = 0.5  # MFAPI_MIN_INTERVAL_SEC


@dataclass(frozen=True)
class NavPoint:
    nav_date: date
    nav: Decimal


@dataclass(frozen=True)
class SchemeListItem:
    code: int
    name: str
    isin_growth: str | None
    isin_div_reinvest: str | None
    plan: str
    option_type: str


@dataclass(frozen=True)
class SearchHit:
    code: int
    name: str


@dataclass(frozen=True)
class SchemeMeta:
    code: int | None
    name: str | None
    fund_house: str | None
    scheme_type: str | None
    category: str | None
    isin_growth: str | None
    isin_div_reinvest: str | None


@dataclass
class NavHistory:
    meta: SchemeMeta
    points: list[NavPoint]  # ascending by date, one per date
    rejected: int = 0
    duplicates: int = 0
    reasons: dict[str, int] = field(default_factory=dict)


@dataclass
class SchemeList:
    items: list[SchemeListItem]
    rejected: int = 0


class _Envelope(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: str
    meta: dict[str, Any] | None = None
    data: list[Any] = []


def _text(value: Any) -> str | None:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def _code(value: Any) -> int | None:
    return parse_scheme_code(value)


def _envelope(payload: Any) -> _Envelope:
    try:
        env = _Envelope.model_validate(payload)
    except ValidationError as exc:
        raise SchemaError("mfapi: unexpected response shape") from exc
    if env.status.upper() != "SUCCESS":
        raise SchemaError(f"mfapi: status {env.status!r}")
    return env


def parse_list(payload: Any) -> SchemeList:
    """``GET /mf?limit=&offset=`` page (camelCase keys)."""
    if not isinstance(payload, list):
        raise SchemaError("mfapi: list response is not an array")
    out = SchemeList(items=[])
    for raw in payload:
        code = _code(raw.get("schemeCode")) if isinstance(raw, dict) else None
        name = _text(raw.get("schemeName")) if isinstance(raw, dict) else None
        if code is None or name is None:
            out.rejected += 1
            continue
        plan, option = classify_plan_option(name)
        out.items.append(
            SchemeListItem(
                code,
                name,
                clean_isin(raw.get("isinGrowth")),
                clean_isin(raw.get("isinDivReinvestment")),
                plan,
                option,
            )
        )
    return out


def parse_search(payload: Any) -> list[SearchHit]:
    """``GET /mf/search?q=``: only ``schemeCode`` and ``schemeName`` (S6); ``[]`` = no match."""
    if not isinstance(payload, list):
        raise SchemaError("mfapi: search response is not an array")
    hits: list[SearchHit] = []
    for raw in payload:
        if not isinstance(raw, dict):
            continue
        code, name = _code(raw.get("schemeCode")), _text(raw.get("schemeName"))
        if code is not None and name is not None:
            hits.append(SearchHit(code, name))
    return hits


def _meta(raw: dict[str, Any] | None) -> SchemeMeta:
    m = raw or {}
    return SchemeMeta(
        code=_code(m.get("scheme_code")),
        name=_text(m.get("scheme_name")),
        fund_house=_text(m.get("fund_house")),
        scheme_type=_text(m.get("scheme_type")),
        category=_text(m.get("scheme_category")),
        isin_growth=clean_isin(m.get("isin_growth")),
        isin_div_reinvest=clean_isin(m.get("isin_div_reinvestment")),
    )


def parse_history(payload: Any, *, expected_code: int | None = None) -> NavHistory:
    """History / latest response -> ascending, de-duplicated ``NavPoint`` list (MF-02/03/15/16)."""
    env = _envelope(payload)
    meta = _meta(env.meta)
    if expected_code is not None and meta.code is not None and meta.code != expected_code:
        raise SchemaError("mfapi: scheme_code in response does not match the request")
    by_date: dict[date, Decimal] = {}
    result = NavHistory(meta=meta, points=[])

    def reject(reason: str) -> None:
        result.rejected += 1
        result.reasons[reason] = result.reasons.get(reason, 0) + 1

    for raw in env.data:
        if not isinstance(raw, dict):
            reject("row_shape")
            continue
        nav_date = parse_date_dmy(raw.get("date"))
        if nav_date is None:
            reject("date")
            continue
        nav = parse_nav(raw.get("nav"))
        if nav is None:
            reject("nav")
            continue
        if nav_date in by_date:
            result.duplicates += 1
        by_date[nav_date] = nav
    result.points = [NavPoint(d, by_date[d]) for d in sorted(by_date)]
    return result


class MFSource(Protocol):
    """docs/01 section 10 interface (``latest_navs`` is served by the AMFI adapter)."""

    async def search(self, query: str) -> list[SearchHit]: ...

    async def nav_history(
        self, code: int, start: date | None = None, end: date | None = None
    ) -> NavHistory: ...


class MfapiClient:
    def __init__(
        self,
        client: HttpClient,
        guard: SourceGuard,
        *,
        base_url: str = MFAPI_BASE,
        sleep: Callable[[float], Awaitable[None]] | None = None,
        rng: random.Random | None = None,
    ) -> None:
        self._client = client
        self._guard = guard
        self._base = base_url.rstrip("/")
        self._kwargs: dict[str, Any] = {"rng": rng}
        if sleep is not None:
            self._kwargs["sleep"] = sleep

    async def _json(
        self,
        path: str,
        params: dict[str, str | int] | None = None,
        max_bytes: int = MAX_HISTORY_BYTES,
    ) -> Any:
        response = await guarded_get(
            self._client,
            f"{self._base}{path}",
            self._guard,
            params=params,
            max_bytes=max_bytes,
            **self._kwargs,
        )
        try:
            return response.json()
        except ValueError as exc:
            raise SchemaError("mfapi: response is not JSON") from exc

    async def list_schemes(self, *, page_size: int = LIST_PAGE_SIZE) -> SchemeList:
        """Paginate ``/mf`` until an empty page; codes are de-duplicated."""
        seen: dict[int, SchemeListItem] = {}
        rejected = 0
        for page in range(LIST_MAX_PAGES):
            parsed = parse_list(
                await self._json(
                    "/mf",
                    {"limit": page_size, "offset": page * page_size},
                    max_bytes=MAX_LIST_BYTES,
                )
            )
            rejected += parsed.rejected
            if not parsed.items and not parsed.rejected:
                break
            for item in parsed.items:
                seen[item.code] = item
        else:
            raise SchemaError("mfapi: scheme list did not end within the page limit")
        return SchemeList(items=list(seen.values()), rejected=rejected)

    async def search(self, query: str) -> list[SearchHit]:
        return parse_search(await self._json("/mf/search", {"q": query}))

    async def nav_history(
        self, code: int, start: date | None = None, end: date | None = None
    ) -> NavHistory:
        params: dict[str, str | int] = {}
        if start is not None:
            params["startDate"] = start.isoformat()
        if end is not None:
            params["endDate"] = end.isoformat()
        payload = await self._json(f"/mf/{int(code)}", params or None)
        return parse_history(payload, expected_code=code)

    async def latest(self, code: int) -> NavHistory:
        payload = await self._json(f"/mf/{int(code)}/latest")
        return parse_history(payload, expected_code=code)
