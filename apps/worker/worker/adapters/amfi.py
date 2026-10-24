"""AMFI ``NAVAll.txt`` adapter (docs/01 section 5; spike S7).

* Columns are read by header name, never by position (MF-19); a missing required header rejects the
  whole file (``SchemaError``, the caller keeps the old data). Extra columns are ignored; the
  6-field layout without ``Plan``/``Option`` also parses.
* State machine (MF-20): a line without ``;`` is a scheme-type line if it starts with
  ``Open Ended Schemes``, ``Close Ended Schemes`` or ``Interval Fund Schemes``, otherwise an AMC
  line; blank lines (possibly a single space) are skipped. A data row seen before both an AMC and a
  type are known is rejected, never attached to a missing one.
* CRLF and LF are both accepted. NAV ``N.A.``/``-``/non-numeric rows are skipped (MF-02); dates are
  ``DD-Mon-YYYY`` (MF-03); a value date after the file date is kept with its own date (MF-17).
* Duplicate scheme codes: the LAST row in file order wins (deterministic); ``AmfiFile.duplicates``
  counts them and the job summary records the count.
* Codes and dates accept ASCII digits only; NAVs above ``MAX_NAV`` and lines over
  ``MAX_LINE_CHARS`` are rejected as rows (the parse continues).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from worker.adapters.base import (
    SchemaError,
    SourceGuard,
    clean_isin,
    guarded_get,
    parse_date_dmon,
    parse_nav,
    parse_scheme_code,
)
from worker.adapters.mfnames import classify_plan_option
from worker.egress import HttpClient

SOURCE = "amfi"
NAVALL_URL = "https://www.amfiindia.com/spages/NAVAll.txt"
DEFAULT_MIN_INTERVAL_S = 1.0  # one download per run; the value is only a floor
SCHEME_TYPE_PREFIXES = ("Open Ended Schemes", "Close Ended Schemes", "Interval Fund Schemes")

_H_CODE = "scheme code"
_H_ISIN_G = "isin div payout/ isin growth"
_H_ISIN_R = "isin div reinvestment"
_H_NAME = "scheme name"
_H_PLAN = "plan"
_H_OPTION = "option"
_H_NAV = "net asset value"
_H_DATE = "date"
_REQUIRED = (_H_CODE, _H_ISIN_G, _H_ISIN_R, _H_NAME, _H_NAV, _H_DATE)
MAX_LINE_CHARS = 2000
MAX_BYTES = 10 * 1024 * 1024  # NAVAll.txt is ~4 MB; refuse anything above 10 MB
_LINE_SPLIT = re.compile(r"\r\n|\n|\r")
_SECTION_RE = re.compile(r"^(.*?)\s*\((.*)\)\s*$")


@dataclass(frozen=True)
class AmfiRow:
    code: int
    name: str
    isin_growth: str | None
    isin_div_reinvest: str | None
    plan_text: str | None
    option_text: str | None
    nav: Decimal
    nav_date: date
    fund_house: str
    scheme_type: str
    category: str | None
    plan: str
    option_type: str


@dataclass
class AmfiFile:
    rows: list[AmfiRow] = field(default_factory=list)
    rejected: int = 0
    reasons: dict[str, int] = field(default_factory=dict)
    duplicates: int = 0

    def by_code(self) -> dict[int, AmfiRow]:
        return {r.code: r for r in self.rows}


def _norm(header: str) -> str:
    return re.sub(r"\s+", " ", header.strip()).casefold()


def _split_section(line: str) -> tuple[str, str | None]:
    m = _SECTION_RE.match(line)
    if not m:
        return line.strip(), None
    return m.group(1).strip(), (m.group(2).strip() or None)


def parse_navall(text: str) -> AmfiFile:
    """Parse the whole file; raises ``SchemaError`` when the header is missing or incomplete."""
    out = AmfiFile()
    index: dict[str, int] | None = None
    fund_house: str | None = None
    scheme_type: str | None = None
    category: str | None = None
    by_code: dict[int, AmfiRow] = {}

    def reject(reason: str) -> None:
        out.rejected += 1
        out.reasons[reason] = out.reasons.get(reason, 0) + 1

    for raw_line in _LINE_SPLIT.split(text.lstrip("﻿")):
        line = raw_line.strip()
        if not line:
            continue
        if len(line) > MAX_LINE_CHARS:
            reject("line_too_long")  # D04R-3: hostile/garbled line, never parsed
            continue
        if ";" not in line:
            if line.startswith(SCHEME_TYPE_PREFIXES):
                scheme_type, category = _split_section(line)
            else:
                fund_house = line
            continue
        parts = [p.strip() for p in line.split(";")]
        names = {_norm(p): i for i, p in enumerate(parts)}
        if _H_CODE in names:  # header line: the column order is never assumed
            missing = [h for h in _REQUIRED if h not in names]
            if missing:
                raise SchemaError(f"AMFI header is missing required columns: {missing}")
            index = names
            continue
        if index is None:
            raise SchemaError("AMFI file has data rows before the header line")
        if len(parts) <= max(index[h] for h in _REQUIRED):
            reject("short_row")
            continue
        code = parse_scheme_code(parts[index[_H_CODE]])  # ASCII digits only; '²' is rejected
        if code is None:
            reject("code")
            continue
        if fund_house is None or scheme_type is None:
            reject("no_section")  # MF-20: never attach a row to a missing AMC or type
            continue
        nav = parse_nav(parts[index[_H_NAV]])
        if nav is None:
            reject("nav")  # MF-02
            continue
        nav_date = parse_date_dmon(parts[index[_H_DATE]])
        if nav_date is None:
            reject("date")  # MF-03
            continue
        name = parts[index[_H_NAME]]
        if not name:
            reject("name")
            continue

        def opt(col: str, parts: list[str] = parts, index: dict[str, int] = index) -> str | None:
            i = index.get(col)
            value = parts[i] if i is not None and i < len(parts) else ""
            return value or None

        plan_text, option_text = opt(_H_PLAN), opt(_H_OPTION)
        plan, option = classify_plan_option(name)
        if plan == "unknown" and plan_text:
            plan = classify_plan_option(plan_text)[0]
        if option == "unknown" and option_text:
            option = classify_plan_option(option_text)[1]
        if code in by_code:
            out.duplicates += 1
        by_code[code] = AmfiRow(
            code,
            name,
            clean_isin(parts[index[_H_ISIN_G]]),
            clean_isin(parts[index[_H_ISIN_R]]),
            plan_text,
            option_text,
            nav,
            nav_date,
            fund_house,
            scheme_type,
            category,
            plan,
            option,
        )
    if index is None:
        raise SchemaError("AMFI file has no header line")
    out.rows = list(by_code.values())
    return out


class AmfiClient:
    """One download per run; no historical report scraping (docs/01 section 5)."""

    def __init__(self, client: HttpClient, guard: SourceGuard, *, url: str = NAVALL_URL) -> None:
        self._client = client
        self._guard = guard
        self._url = url

    async def latest_navs(self) -> AmfiFile:
        response = await guarded_get(self._client, self._url, self._guard, max_bytes=MAX_BYTES)
        try:
            text = response.content.decode("utf-8-sig")
        except UnicodeDecodeError as exc:
            raise SchemaError("AMFI file is not valid UTF-8") from exc
        return parse_navall(text)
