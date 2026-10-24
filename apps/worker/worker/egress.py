"""The single outbound HTTP client factory (decision D-N, SAF-13; docs/00 s1, docs/01 s1).

This is the ONLY module allowed to import ``httpx`` (ruff ``banned-api``). Every request, and every
redirect hop, is checked against ``config/allowed_hosts.json`` before the inner transport can open a
socket: https only, port 443, exact host name match, no IP literals, no user info, no proxies from
the environment. Hosts are never read from environment variables.
"""

from __future__ import annotations

import ipaddress
import json
from collections.abc import Iterable
from functools import lru_cache
from pathlib import Path

import httpx

from worker.errors import EgressDenied, RetryableError

USER_AGENT = "IndiaAnalyzerPersonal/1.0"  # docs/01 section 1 rule 2
CONNECT_TIMEOUT_S = 10.0
READ_TIMEOUT_S = 30.0
TOTAL_TIMEOUT_S = 60.0  # enforce with asyncio.timeout(TOTAL_TIMEOUT_S) around a whole call
MAX_REDIRECTS = 3

NETWORK_ERRORS: tuple[type[Exception], ...] = (httpx.TransportError,)

# Type aliases so adapters can annotate without importing httpx themselves (ruff banned-api).
HttpClient = httpx.AsyncClient
HttpResponse = httpx.Response

_DEFAULT_FILE = Path(__file__).resolve().parents[3] / "config" / "allowed_hosts.json"


def _is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        pass
    else:
        return True
    # Legacy numeric forms (2130706433, 0x7f.1, 0177.0.0.1) are IP literals to a resolver too.
    try:
        return all(int(part, 0) >= 0 for part in host.split("."))
    except ValueError:
        return False


def load_allowed_hosts(path: Path | None = None) -> frozenset[str]:
    data = json.loads((path or _DEFAULT_FILE).read_text(encoding="utf-8"))
    hosts = frozenset(str(h).strip().lower() for h in data["hosts"])
    if not hosts or any(not h or _is_ip_literal(h) for h in hosts):
        raise ValueError("allowed_hosts.json must list non-empty host names (no IP literals)")
    return hosts


@lru_cache(maxsize=1)
def _default_hosts() -> frozenset[str]:
    return load_allowed_hosts()


def check_url(url: httpx.URL, allowed: Iterable[str]) -> None:
    """Raise ``EgressDenied`` unless ``url`` is https://<allowed host>[:443]/..."""
    if url.scheme != "https":
        raise EgressDenied(f"egress denied: scheme {url.scheme!r} is not https")
    if url.userinfo:
        raise EgressDenied("egress denied: user info in URL")
    host = url.host
    if not host or _is_ip_literal(host):
        raise EgressDenied("egress denied: IP literal or empty host")
    if url.port not in (None, 443):
        raise EgressDenied(f"egress denied: port {url.port}")
    if host.lower() not in set(allowed):
        raise EgressDenied(f"egress denied: host {host!r} is not on the allow-list")


class EgressTransport(httpx.AsyncBaseTransport):
    """Checks the allow-list, then delegates. httpx calls this once per redirect hop."""

    def __init__(
        self,
        inner: httpx.AsyncBaseTransport | None = None,
        allowed: Iterable[str] | None = None,
    ) -> None:
        self._allowed = frozenset(allowed) if allowed is not None else _default_hosts()
        self._inner = inner if inner is not None else httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        check_url(request.url, self._allowed)
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()


def make_client(
    *,
    inner: httpx.AsyncBaseTransport | None = None,
    allowed: Iterable[str] | None = None,
) -> httpx.AsyncClient:
    """The one way to get an HTTP client. ``inner`` is for tests (a mock transport)."""
    return httpx.AsyncClient(
        transport=EgressTransport(inner, allowed),
        timeout=httpx.Timeout(READ_TIMEOUT_S, connect=CONNECT_TIMEOUT_S),
        headers={"User-Agent": USER_AGENT},
        follow_redirects=True,
        max_redirects=MAX_REDIRECTS,
        trust_env=False,  # no HTTP(S)_PROXY / ALL_PROXY / netrc from the environment
        verify=True,
    )


class ResponseTooLarge(Exception):  # noqa: N818 - plain name, mirrors EgressDenied
    """The response body exceeded the per-call byte cap (not retried, not a source failure)."""


async def get_capped(
    client: httpx.AsyncClient,
    url: str,
    *,
    max_bytes: int,
    params: dict[str, str | int] | None = None,
) -> httpx.Response:
    """GET that streams the body and aborts as soon as it exceeds ``max_bytes`` (decoded size).

    Returns an ordinary ``Response`` holding the (already decoded) body, so callers still use
    ``.content`` / ``.json()`` and never need httpx themselves.
    """
    async with client.stream("GET", url, params=params) as response:
        declared = response.headers.get("Content-Length")
        if declared is not None and declared.isdigit() and int(declared) > max_bytes:
            raise ResponseTooLarge(f"declared {declared} bytes > cap {max_bytes}")
        if response.status_code >= 400:  # error bodies are never needed; keep them tiny
            body = b""
        else:
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ResponseTooLarge(f"body exceeds cap {max_bytes} bytes")
                chunks.append(chunk)
            body = b"".join(chunks)
        headers = [
            (k, v)
            for k, v in response.headers.multi_items()
            if k.lower() not in ("content-encoding", "content-length", "transfer-encoding")
        ]
        return httpx.Response(
            response.status_code, headers=headers, content=body, request=response.request
        )


def raise_if_retryable(response: httpx.Response) -> None:
    """429 and 5xx become ``RetryableError`` (honouring Retry-After in seconds)."""
    if response.status_code == 429 or response.status_code >= 500:
        retry_after: float | None = None
        raw = response.headers.get("Retry-After")
        if raw is not None:
            try:
                retry_after = max(0.0, float(raw))
            except ValueError:
                retry_after = None
        raise RetryableError(f"HTTP {response.status_code}", retry_after)
