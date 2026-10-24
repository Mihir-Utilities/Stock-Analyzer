"""D04 adapters on recorded fixtures: MF-01/02/03/15/16/17/19/20 and the >10,000 row check."""

from __future__ import annotations

import json
from datetime import date
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx  # noqa: TID251 - tests build mock transports
import pytest
from conftest import FakeClock, MemoryHealthStore

from worker import egress
from worker.adapters.amfi import AmfiClient, parse_navall
from worker.adapters.base import (
    NotFound,
    SchemaError,
    SourceGuard,
    parse_date_dmon,
    parse_date_dmy,
    parse_nav,
)
from worker.adapters.mfapi import ATTRIBUTION, MfapiClient, parse_history, parse_list, parse_search
from worker.adapters.mfnames import classify_plan_option
from worker.breaker import CircuitBreaker
from worker.errors import RetryableError, SourceDisabled
from worker.fixtures import load_json, load_text
from worker.limiter import RateLimiter

pytestmark = pytest.mark.anyio

AMFI_FIXTURE = Path(__file__).resolve().parents[3] / "fixtures" / "amfi" / "NAVAll_sample.txt"


def amfi_text() -> str:
    return AMFI_FIXTURE.read_text(encoding="utf-8")


def test_attribution_constant() -> None:
    assert ATTRIBUTION == "NAV data: AMFI via mfapi.in"


# --------------------------------------------------------------------------- MF-02 / MF-03
def test_mf02_non_numeric_nav_skipped() -> None:
    for bad in ["N.A.", "-", "", "abc", "0", "0.0", "-5", "1,234", None, "nan", "inf", True]:
        assert parse_nav(bad) is None
    assert parse_nav("88.92580") == Decimal("88.92580")
    assert parse_nav(" 12 ") == Decimal("12")


def test_mf02_history_skips_bad_rows_and_counts() -> None:
    payload = {
        "meta": {"scheme_code": 1},
        "status": "SUCCESS",
        "data": [
            {"date": "03-01-2026", "nav": "10.5"},
            {"date": "02-01-2026", "nav": "N.A."},
            {"date": "31-02-2026", "nav": "10"},
            {"date": "01-01-2026", "nav": "0"},
            "garbage",
        ],
    }
    h = parse_history(payload)
    assert [(p.nav_date, p.nav) for p in h.points] == [(date(2026, 1, 3), Decimal("10.5"))]
    assert h.rejected == 4 and h.reasons == {"nav": 2, "date": 1, "row_shape": 1}


def test_mf03_both_date_formats() -> None:
    assert parse_date_dmy("31-03-2024") == date(2024, 3, 31)
    assert parse_date_dmy("2024-03-31") is None and parse_date_dmy("31-13-2024") is None
    assert parse_date_dmon("09-Oct-2026") == date(2026, 10, 9)
    assert parse_date_dmon("09-oct-2026") == date(2026, 10, 9)
    assert parse_date_dmon("09-Xyz-2026") is None and parse_date_dmon("30-Feb-2026") is None


# --------------------------------------------------------------------------- MF-15 / MF-16
def test_mf15_descending_data_sorted_ascending() -> None:
    h = parse_history(load_json("mfapi", "history_122639_range_2026-09-01_2026-10-09.json"))
    dates = [p.nav_date for p in h.points]
    assert dates == sorted(dates) and len(dates) == 27 and dates[-1] == date(2026, 10, 9)
    assert h.meta.code == 122639 and h.meta.isin_growth == "INF879O01027"
    # ascending input stays ascending too
    asc = {
        "status": "SUCCESS",
        "data": [{"date": "01-01-2026", "nav": "1"}, {"date": "02-01-2026", "nav": "2"}],
    }
    assert [p.nav for p in parse_history(asc).points] == [Decimal(1), Decimal(2)]


def test_mf16_weekend_nav_kept() -> None:
    payload = load_json("mfapi", "history_122639_weekend_row_context.json")
    payload["status"] = "SUCCESS"
    h = parse_history(payload)
    assert date(2024, 3, 31) in {p.nav_date for p in h.points}  # a Sunday
    assert date(2024, 3, 31).weekday() == 6 and h.rejected == 0


def test_history_duplicates_and_code_mismatch() -> None:
    dup = {
        "status": "SUCCESS",
        "data": [{"date": "01-01-2026", "nav": "1"}, {"date": "01-01-2026", "nav": "2"}],
    }
    h = parse_history(dup)
    assert len(h.points) == 1 and h.duplicates == 1 and h.points[0].nav == 2
    with pytest.raises(SchemaError):
        parse_history(
            {"status": "SUCCESS", "meta": {"scheme_code": 5}, "data": []}, expected_code=6
        )
    with pytest.raises(SchemaError):
        parse_history({"status": "ERROR", "data": []})
    with pytest.raises(SchemaError):
        parse_history([1, 2])


def test_fixture_history_and_latest_and_search_and_list() -> None:
    old = parse_history(load_json("mfapi", "history_111972_trimmed.json"))
    assert old.points[0].nav_date == date(2009, 6, 15) and old.meta.isin_growth is None
    latest = parse_history(load_json("mfapi", "latest_122639.json"), expected_code=122639)
    assert len(latest.points) == 1 and latest.points[0].nav == Decimal("88.92580")
    assert [h.code for h in parse_search(load_json("mfapi", "search_hdfc_flexi_cap.json"))][:2] == [
        101762,
        101763,
    ]
    assert parse_search(load_json("mfapi", "search_no_result.json")) == []
    lst = parse_list(load_json("mfapi", "list_first_5.json"))
    assert len(lst.items) == 5 and lst.rejected == 0 and lst.items[0].isin_growth is None
    assert lst.items[1].option_type == "idcw"


# MF-81
def test_list_rejects_bad_items() -> None:
    lst = parse_list(
        [
            {"schemeCode": "x", "schemeName": "A"},
            {"schemeCode": 5, "schemeName": " "},
            {"schemeCode": 7, "schemeName": "B Direct Growth", "isinGrowth": "-"},
        ]
    )
    assert [i.code for i in lst.items] == [7] and lst.rejected == 2
    assert (lst.items[0].plan, lst.items[0].option_type, lst.items[0].isin_growth) == (
        "direct",
        "growth",
        None,
    )


@pytest.mark.parametrize(
    ("name", "plan", "option"),
    [
        ("Parag Parikh Flexi Cap Fund - Direct Plan - Growth", "direct", "growth"),
        ("HDFC Flexi Cap Fund - Regular Plan - IDCW Option", "regular", "idcw"),
        ("X Fund - Direct - Dividend Payout", "direct", "idcw"),
        ("Grindlays Super Saver Income Fund-GSSIF-Growth", "unknown", "growth"),
        ("Something Direct Regular Growth Dividend", "unknown", "unknown"),
        ("Directors Fund", "unknown", "unknown"),
        ("", "unknown", "unknown"),
    ],
)
def test_mf01_plan_option_from_name(name: str, plan: str, option: str) -> None:
    assert classify_plan_option(name) == (plan, option)


# --------------------------------------------------------------------------- AMFI
def test_amfi_fixture_parse_crlf_and_lf() -> None:
    # the real file is CRLF; a checkout may normalise it to LF, so test both explicitly
    text = AMFI_FIXTURE.read_bytes().decode("utf-8").replace("\r\n", "\n")
    crlf = parse_navall(text.replace("\n", "\r\n"))
    lf = parse_navall(text)
    assert crlf.rows == lf.rows and crlf.rejected == 0 and len(crlf.rows) == 9
    row = crlf.by_code()[135762]
    assert (row.fund_house, row.scheme_type) == ("Axis Mutual Fund", "Open Ended Schemes")
    assert row.category == "Children’s Fund - Childrens' Fund"
    assert (row.plan, row.option_type) == ("direct", "growth")
    assert row.isin_div_reinvest is None and row.nav == Decimal("29.0745")
    # MF-17: value date after the file date (10 Oct) is kept with its own date
    liquid = crlf.by_code()[119369]
    assert liquid.nav_date == date(2026, 10, 11) and liquid.category == "Debt Scheme - Liquid Fund"
    # older schemes with empty Plan/Option columns are kept, classified by name -> unknown
    old = crlf.by_code()[130947]
    assert old.plan == "unknown" and old.nav_date == date(2020, 4, 24)


def _row(code: int, nav: str = "10.0000", day: str = "09-Oct-2026") -> str:
    return f"{code};INF000A01{code % 1000:03d};-;Fund {code};Direct Plan;Growth Option;{nav};{day}"


HEADER8 = "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date"


def test_amfi_more_than_10000_rows_synthetic() -> None:
    """The recorded sample is small; a 12,000 row file in the same layout exercises scale."""
    lines = [HEADER8, "", "Open Ended Schemes(Equity Scheme - Large Cap Fund)", ""]
    for amc in range(12):
        lines += [f"AMC {amc} Mutual Fund", ""]
        lines += [_row(100000 + amc * 1000 + i) for i in range(1000)]
        lines.append(" ")
    for eol in ("\r\n", "\n"):
        parsed = parse_navall(eol.join(lines))
        assert len(parsed.rows) == 12000 > 10000 and parsed.rejected == 0
        assert parsed.by_code()[101005].fund_house == "AMC 1 Mutual Fund"


# MF-19
def test_mf19_header_by_name_reordered_extra_and_six_field() -> None:
    reordered = (
        "Date;Extra Col;Net Asset Value;Scheme Name;ISIN Div Reinvestment;"
        "ISIN Div Payout/ ISIN Growth;Scheme Code\n\nOpen Ended Schemes(X - Y)\n\nAMC\n\n"
        "09-Oct-2026;zzz;12.5000;Some Fund Regular Growth;-;INF111A01AA1;555\n"
    )
    r = parse_navall(reordered).rows[0]
    assert (r.code, r.nav, r.isin_growth, r.plan, r.option_type) == (
        555,
        Decimal("12.5"),
        "INF111A01AA1",
        "regular",
        "growth",
    )
    six = (
        "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date\n"
        "Open Ended Schemes(A - B)\nAMC\n7;-;-;F Direct Growth;1.5;01-Jan-2026\n"
    )
    assert parse_navall(six).rows[0].plan == "direct"
    for bad in (
        HEADER8.replace("Net Asset Value", "NAV")
        + "\nOpen Ended Schemes(A)\nAMC\n1;-;-;n;;;1;01-Jan-2026",
        "Open Ended Schemes(A)\nAMC\n1;-;-;n;;;1;01-Jan-2026",
        "",
    ):
        with pytest.raises(SchemaError):
            parse_navall(bad)


# MF-20
def test_mf20_type_line_vs_amc_line_and_missing_section() -> None:
    text = "\n".join(
        [
            HEADER8,
            "",
            _row(1),  # no AMC/type yet -> rejected, never attached to a missing section
            "",
            "Close Ended Schemes(Debt - Fixed Term)",
            "",
            "Some AMC",
            " ",
            _row(2),
            "",
            "Interval Fund Schemes(Income)",
            "",
            "Open Ended Fund Management Ltd",
            "",
            _row(3),
        ]
    )
    p = parse_navall(text)
    assert p.reasons == {"no_section": 1}
    by = p.by_code()
    assert (by[2].scheme_type, by[2].category, by[2].fund_house) == (
        "Close Ended Schemes",
        "Debt - Fixed Term",
        "Some AMC",
    )
    # "Open Ended Fund Management Ltd" does not start with "Open Ended Schemes": it is an AMC line
    assert (by[3].scheme_type, by[3].fund_house) == (
        "Interval Fund Schemes",
        "Open Ended Fund Management Ltd",
    )


def test_amfi_reject_reasons() -> None:
    text = "\n".join(
        [
            HEADER8,
            "Open Ended Schemes(A)",
            "AMC",
            _row(1, "N.A."),
            _row(2, "-"),
            _row(3, day="31-Feb-2026"),
            "abc;x;y",
            "9;-;-;ok;;;5;01-Jan-2026",
        ]
    )
    p = parse_navall(text)
    assert p.reasons == {"nav": 2, "date": 1, "short_row": 1} and p.duplicates == 0
    assert [r.code for r in p.rows] == [9]


# --------------------------------------------------------------------------- HTTP client path
class Routes(httpx.AsyncBaseTransport):
    def __init__(self, handler: Any) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.handler(request)  # type: ignore[no-any-return]


def make_guard(
    clock: FakeClock, store: MemoryHealthStore | None = None, source: str = "mfapi"
) -> SourceGuard:
    return SourceGuard(
        source,
        RateLimiter(0.0, clock=clock, sleep=clock.sleep),
        CircuitBreaker(source, store or MemoryHealthStore()),
    )


def mf_client(handler: Any, clock: FakeClock) -> tuple[MfapiClient, Routes, httpx.AsyncClient]:
    routes = Routes(handler)
    client = egress.make_client(inner=routes)
    return MfapiClient(client, make_guard(clock), sleep=clock.sleep), routes, client


# MF-81
async def test_list_pagination_until_empty_page(clock: FakeClock) -> None:
    pages = {
        "0": [{"schemeCode": 1, "schemeName": "A"}, {"schemeCode": 2, "schemeName": "B"}],
        "2": [{"schemeCode": 2, "schemeName": "B"}, {"schemeCode": 3, "schemeName": "C"}],
        "4": [],
    }

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "api.mfapi.in" and request.url.params["limit"] == "2"
        return httpx.Response(200, json=pages[request.url.params["offset"]])

    mf, routes, client = mf_client(handler, clock)
    async with client:
        result = await mf.list_schemes(page_size=2)
    assert [i.code for i in result.items] == [1, 2, 3] and len(routes.requests) == 3


async def test_history_params_and_404(clock: FakeClock) -> None:
    body = load_json("mfapi", "history_122639_range_2026-09-01_2026-10-09.json")

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/mf/999":
            return httpx.Response(404, json={"status": "ERROR"})
        return httpx.Response(200, json=body)

    mf, routes, client = mf_client(handler, clock)
    async with client:
        h = await mf.nav_history(122639, date(2026, 9, 1), date(2026, 10, 9))
        assert len(h.points) == 27
        q = routes.requests[0].url.params
        assert (q["startDate"], q["endDate"]) == ("2026-09-01", "2026-10-09")
        assert routes.requests[0].headers["User-Agent"] == "IndiaAnalyzerPersonal/1.0"
        with pytest.raises(NotFound):
            await mf.nav_history(999)


async def test_retries_then_breaker_opens(clock: FakeClock) -> None:
    store = MemoryHealthStore()
    routes = Routes(lambda r: httpx.Response(503))
    client = egress.make_client(inner=routes)
    mf = MfapiClient(client, make_guard(clock, store), sleep=clock.sleep)
    async with client:
        for _ in range(5):
            with pytest.raises(RetryableError):
                await mf.latest(1)
        assert len(routes.requests) == 5 * 4  # 1 try + 3 retries per call
        with pytest.raises(SourceDisabled):
            await mf.latest(1)
        assert len(routes.requests) == 20  # open breaker: no request is made


# MF-80 (AMFI host passes the allow-list)
async def test_amfi_client_downloads_once_and_parses(clock: FakeClock) -> None:
    routes = Routes(lambda r: httpx.Response(200, content=AMFI_FIXTURE.read_bytes()))
    client = egress.make_client(inner=routes)
    amfi = AmfiClient(client, make_guard(clock, source="amfi"))
    async with client:
        f = await amfi.latest_navs()
    assert len(f.rows) == 9 and len(routes.requests) == 1
    assert str(routes.requests[0].url) == "https://www.amfiindia.com/spages/NAVAll.txt"


async def test_amfi_client_bad_file_raises(clock: FakeClock) -> None:
    routes = Routes(lambda r: httpx.Response(200, content=b"<html>maintenance</html>"))
    client = egress.make_client(inner=routes)
    async with client:
        with pytest.raises(SchemaError):
            await AmfiClient(client, make_guard(clock, source="amfi")).latest_navs()


def test_fixture_loader_json_roundtrip() -> None:
    assert json.loads(load_text("mfapi", "search_no_result.json")) == []
