"""In-memory ``MfStore`` and fake sources for the D04 job tests."""

from __future__ import annotations

from datetime import date
from typing import Any

from worker.adapters.amfi import AmfiFile
from worker.adapters.base import NotFound
from worker.adapters.mfapi import NavHistory, NavPoint, SchemeList, SchemeListItem, SchemeMeta


class MemoryMfStore:
    def __init__(self) -> None:
        self.schemes: dict[int, dict[str, Any]] = {}
        self.navs: dict[int, dict[date, float]] = {}
        self.cache: dict[int, tuple[date, dict[str, Any]]] = {}
        self.risk_free = 0.065

    def add(
        self, code: int, *, tracked: bool = False, status: str = "active", last: date | None = None
    ) -> None:
        self.schemes[code] = {
            "name": f"S{code}",
            "is_tracked": tracked,
            "status": status,
            "last_nav_date": last,
        }

    async def upsert_list(self, items: list[SchemeListItem]) -> int:
        for i in items:
            s = self.schemes.setdefault(
                i.code, {"status": "active", "is_tracked": False, "last_nav_date": None}
            )
            s.update(name=i.name, plan=i.plan, option_type=i.option_type)
        return len(items)

    async def apply_amfi(self, amfi: AmfiFile) -> int:
        for r in amfi.rows:
            s = self.schemes.setdefault(
                r.code,
                {"status": "active", "is_tracked": False, "last_nav_date": None, "name": r.name},
            )
            s.update(fund_house=r.fund_house, scheme_type=r.scheme_type, category=r.category)
        return len(amfi.rows)

    async def scheme_state(self) -> dict[int, tuple[str, date | None]]:
        return {c: (s["status"], s["last_nav_date"]) for c, s in self.schemes.items()}

    async def set_status(self, changes: list[tuple[int, str]]) -> None:
        for c, st in changes:
            self.schemes[c]["status"] = st

    async def tracked_codes(self, limit: int, only: list[int] | None) -> list[int]:
        if only:
            return sorted(c for c in only if c in self.schemes)
        return sorted(c for c, s in self.schemes.items() if s["is_tracked"])[:limit]

    async def scheme_exists(self, code: int) -> bool:
        return code in self.schemes

    async def last_nav_date(self, code: int) -> date | None:
        return max(self.navs.get(code, {}), default=None)

    async def upsert_navs(self, code: int, points: list[NavPoint]) -> int:
        for p in points:
            self.navs.setdefault(code, {})[p.nav_date] = float(p.nav)
        return len(points)

    async def update_meta(self, code: int, meta: SchemeMeta, last_nav: date | None) -> None:
        self.schemes[code]["last_nav_date"] = last_nav or self.schemes[code]["last_nav_date"]
        self.schemes[code].setdefault("fund_house", meta.fund_house)

    async def load_series(self, code: int) -> tuple[list[date], list[float]]:
        s = self.navs.get(code, {})
        ds = sorted(s)
        return ds, [s[d] for d in ds]

    async def save_cache(self, code: int, as_of: date, metrics: dict[str, Any]) -> None:
        self.cache[code] = (as_of, metrics)

    async def risk_free_rate(self) -> float:
        return self.risk_free


class FakeMfapi:
    """History per code (ascending ``NavPoint`` lists); records calls; can fail on demand."""

    def __init__(
        self, history: dict[int, list[NavPoint]] | None = None, listing: SchemeList | None = None
    ) -> None:
        self.history = history or {}
        self.listing = listing
        self.calls: list[tuple[int, date | None, date | None]] = []
        self.fail: Exception | None = None

    async def list_schemes(self) -> SchemeList:
        if self.fail:
            raise self.fail
        assert self.listing is not None
        return self.listing

    async def nav_history(
        self, code: int, start: date | None = None, end: date | None = None
    ) -> NavHistory:
        self.calls.append((code, start, end))
        if self.fail:
            raise self.fail
        if code not in self.history:
            raise NotFound("404")
        pts = [p for p in self.history[code] if start is None or p.nav_date >= start]
        return NavHistory(
            meta=SchemeMeta(code, None, "House", "Open Ended Schemes", "Equity", None, None),
            points=pts,
        )


class FakeAmfi:
    def __init__(self, file: AmfiFile | None = None, error: Exception | None = None) -> None:
        self.file, self.error, self.downloads = file, error, 0

    async def latest_navs(self) -> AmfiFile:
        self.downloads += 1
        if self.error:
            raise self.error
        assert self.file is not None
        return self.file
