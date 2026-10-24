"""SAF-13: runtime egress allow-list (decision D-N). Sockets are disabled for every test."""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
from pathlib import Path

import httpx  # noqa: TID251 - tests build mock transports
import pytest

from worker import egress
from worker.errors import EgressDenied, RetryableError

REPO = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.anyio


class Recorder(httpx.AsyncBaseTransport):
    """Inner transport that records hops; a real socket is never involved."""

    def __init__(self, routes: dict[str, httpx.Response] | None = None) -> None:
        self.seen: list[str] = []
        self.routes = routes or {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.seen.append(str(request.url))
        return self.routes.get(str(request.url), httpx.Response(200, json={"ok": True}))


async def _get(url: str, inner: Recorder | None = None) -> Recorder:
    rec = inner or Recorder()
    async with egress.make_client(inner=rec) as client:
        await client.get(url)
    return rec


def test_allow_list_file_matches_docs() -> None:
    hosts = json.loads((REPO / "config" / "allowed_hosts.json").read_text())["hosts"]
    assert sorted(hosts) == ["api.mfapi.in", "api.telegram.org", "mfapi.in", "www.amfiindia.com"]
    assert egress.load_allowed_hosts() == frozenset(hosts)


@pytest.mark.parametrize(
    "url",
    [
        "https://mfapi.in/mf",
        "https://MFAPI.IN/mf",
        "https://www.amfiindia.com/spages/NAVAll.txt",
        "https://api.telegram.org/botX/getMe",
        "https://mfapi.in:443/mf",
    ],
)
# MF-80
async def test_allowed_hosts_pass(url: str) -> None:
    rec = await _get(url)
    assert len(rec.seen) == 1


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com/",  # not listed
        "https://mfapi.in.example.com/",  # suffix trick
        "https://evilmfapi.in/",
        "https://amfiindia.com/",  # only the www host is listed
        "https://mfapi.in@example.com/",  # user info trick
        "https://user:pw@mfapi.in/",
        "https://mfapi.in./",  # trailing dot is not an exact match
        "http://mfapi.in/mf",  # not https
        "ftp://mfapi.in/mf",
        "https://mfapi.in:8443/mf",  # unusual port
        "https://93.184.216.34/",  # IP literals
        "https://127.0.0.1/",
        "https://[::1]/",
        "https://2130706433/",  # decimal IPv4
        "https://0x7f.1/",  # hex/short IPv4
        "https://localhost/",
    ],
)
# SAF-14 / MF-80
async def test_hosts_outside_allow_list_raise_before_any_socket(url: str) -> None:
    rec = Recorder()
    with pytest.raises(EgressDenied):
        await _get(url, rec)
    assert rec.seen == []  # inner transport never reached


async def test_host_read_from_environment_variable_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOME_SOURCE_HOST", "example.org")
    rec = Recorder()
    with pytest.raises(EgressDenied):
        await _get(f"https://{os.environ['SOME_SOURCE_HOST']}/data", rec)
    assert rec.seen == []


# SAF-14
async def test_redirect_to_unlisted_host_is_refused_on_the_hop() -> None:
    rec = Recorder(
        {"https://mfapi.in/mf": httpx.Response(302, headers={"Location": "https://example.com/x"})}
    )
    with pytest.raises(EgressDenied):
        await _get("https://mfapi.in/mf", rec)
    assert rec.seen == ["https://mfapi.in/mf"]  # first hop only


@pytest.mark.parametrize("target", ["http://mfapi.in/mf", "https://127.0.0.1/mf"])
# SAF-14
async def test_redirect_downgrade_or_ip_is_refused(target: str) -> None:
    rec = Recorder({"https://mfapi.in/mf": httpx.Response(301, headers={"Location": target})})
    with pytest.raises(EgressDenied):
        await _get("https://mfapi.in/mf", rec)
    assert rec.seen == ["https://mfapi.in/mf"]


async def test_redirect_between_allowed_hosts_is_followed() -> None:
    rec = Recorder(
        {
            "https://mfapi.in/a": httpx.Response(
                302, headers={"Location": "https://www.amfiindia.com/b"}
            )
        }
    )
    await _get("https://mfapi.in/a", rec)
    assert rec.seen == ["https://mfapi.in/a", "https://www.amfiindia.com/b"]


async def test_default_transport_denies_before_opening_a_socket(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """With the REAL inner transport, a denied host never reaches name resolution or connect."""
    calls: list[object] = []
    real = socket.socket.connect
    monkeypatch.setattr(socket.socket, "connect", lambda s, a: calls.append(a) or real(s, a))
    async with egress.make_client() as client:
        with pytest.raises(EgressDenied):
            await client.get("https://example.com/")
        with pytest.raises(EgressDenied):
            await client.get("https://10.0.0.5/")
    assert calls == []


async def test_allowed_host_with_real_transport_still_hits_the_socket_guard() -> None:
    """An allowed host passes the allow-list; the test socket guard then stops the connection."""
    async with egress.make_client() as client:
        with pytest.raises((OSError, httpx.TransportError)):
            await client.get("https://mfapi.in/mf")


# SAF-14
def test_environment_proxies_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    monkeypatch.setenv("ALL_PROXY", "http://proxy.invalid:3128")
    client = egress.make_client()
    assert client._trust_env is False  # noqa: SLF001
    assert client._mounts == {}  # noqa: SLF001


def test_client_defaults_follow_docs() -> None:
    client = egress.make_client()
    assert client.headers["User-Agent"] == "IndiaAnalyzerPersonal/1.0"
    assert client.timeout.connect == 10.0 and client.timeout.read == 30.0


def test_allow_list_file_rejects_ip_literals(tmp_path: Path) -> None:
    f = tmp_path / "h.json"
    f.write_text(json.dumps({"hosts": ["1.2.3.4"]}))
    with pytest.raises(ValueError):
        egress.load_allowed_hosts(f)


def test_retryable_status_mapping() -> None:
    egress.raise_if_retryable(httpx.Response(200))
    egress.raise_if_retryable(httpx.Response(404))
    with pytest.raises(RetryableError) as exc:
        egress.raise_if_retryable(httpx.Response(429, headers={"Retry-After": "7"}))
    assert exc.value.retry_after == 7.0
    with pytest.raises(RetryableError) as exc2:
        egress.raise_if_retryable(httpx.Response(503))
    assert exc2.value.retry_after is None


def _ruff() -> list[str]:
    exe = shutil.which("ruff", path=str(Path(sys.executable).parent))
    return [exe] if exe else [sys.executable, "-m", "ruff"]


@pytest.mark.parametrize(
    "snippet",
    [
        "import requests\n",
        "import urllib.request\n",
        "from urllib import request\n",
        "import urllib3\n",
        "import http.client\n",
        "import aiohttp\n",
        "import httpx\n",
        "from httpx import AsyncClient\n",
    ],
)
def test_direct_http_clients_fail_lint_outside_egress(snippet: str) -> None:
    proc = subprocess.run(  # noqa: S603
        [
            *_ruff(),
            "check",
            "--config",
            str(REPO / "apps/worker/pyproject.toml"),
            "--select",
            "TID251",
            "--stdin-filename",
            "worker/some_adapter.py",
            "-",
        ],
        input=snippet,
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO / "apps" / "worker",
    )
    assert proc.returncode != 0 and "TID251" in proc.stdout, proc.stdout + proc.stderr


def test_egress_module_itself_may_import_httpx() -> None:
    proc = subprocess.run(  # noqa: S603
        [
            *_ruff(),
            "check",
            "--config",
            str(REPO / "apps/worker/pyproject.toml"),
            "--select",
            "TID251",
            "worker/egress.py",
        ],
        capture_output=True,
        text=True,
        check=False,
        cwd=REPO / "apps" / "worker",
    )
    assert proc.returncode == 0, proc.stdout
