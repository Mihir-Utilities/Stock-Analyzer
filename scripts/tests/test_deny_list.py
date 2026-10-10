"""SAF-01 and SAF-02: the deny-list fails on forbidden libraries, hosts and order methods."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import deny_list_check as dl  # noqa: E402

SCRIPT = Path(dl.__file__)
REPO = SCRIPT.parent.parent


def write(root: Path, rel: str, text: str) -> None:
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")


def test_clean_tree_passes(tmp_path: Path) -> None:
    write(tmp_path, "apps/worker/pyproject.toml", 'dependencies = ["httpx"]\n')
    write(tmp_path, "apps/api/main.go", "package main\n")
    assert dl.scan(tmp_path) == []


@pytest.mark.parametrize(
    ("rel", "text", "rule"),
    [
        ("apps/worker/requirements.txt", "yfinance==0.2.0\n", "yahoo-finance"),
        ("apps/worker/pyproject.toml", 'dependencies = ["nsepython"]\n', "nse-library"),
        ("apps/worker/uv.lock", 'name = "jugaad-data"\n', "nse-library"),
        (
            "apps/worker/worker/adapters/x.py",
            'URL = "https://www.nseindia.com/api"\n',
            "nse-bse-host",
        ),
        (
            "apps/worker/worker/adapters/y.py",
            'URL = "https://api.bseindia.com/x"\n',
            "nse-bse-host",
        ),
        ("apps/web/package-lock.json", '"node_modules/feedparser": {}\n', "news-rss"),
        ("apps/web/src/a.ts", "fetch('https://www.screener.in/company/TCS/')\n", "screener-host"),
        (
            "apps/worker/worker/adapters/z.py",
            "https://finance.yahoo.com/quote/TCS\n",
            "yahoo-finance",
        ),
        ("apps/api/internal/b.go", "func PlaceOrder() {}\n", "order-method"),
        ("apps/worker/worker/adapters/b.py", "def cancel_order(): ...\n", "order-method"),
        ("apps/api/go.sum", "github.com/x/gnews v1.0.0 h1:abc\n", "news-rss"),
    ],
)
def test_forbidden_items_are_detected(tmp_path: Path, rel: str, text: str, rule: str) -> None:
    write(tmp_path, rel, text)
    found = dl.scan(tmp_path)
    assert [v.rule for v in found] == [rule], found
    assert found[0].path == rel


def test_exemptions(tmp_path: Path) -> None:
    # research links are plain hyperlinks (T00): exempt. Specs and tasks are not code.
    write(
        tmp_path,
        "config/research_links.json",
        '{"url": "https://www.screener.in/company/{symbol}/"}\n',
    )
    write(tmp_path, "docs/00-legal.md", "yfinance is forbidden\n")
    write(tmp_path, "tasks/x.md", "nsepython is forbidden\n")
    write(tmp_path, "apps/web/node_modules/p/index.js", "yfinance\n")
    assert dl.scan(tmp_path) == []


def test_other_config_files_are_not_exempt(tmp_path: Path) -> None:
    write(tmp_path, "config/other.json", '{"url": "https://www.nseindia.com"}\n')
    assert [v.rule for v in dl.scan(tmp_path)] == ["nse-bse-host"]


def test_cli_exit_codes(tmp_path: Path) -> None:
    write(tmp_path, "apps/worker/requirements.txt", "yfinance\n")
    bad = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path)], capture_output=True, text=True
    )
    assert bad.returncode == 1
    assert "yahoo-finance" in bad.stderr
    (tmp_path / "apps/worker/requirements.txt").write_text("httpx\n", encoding="utf-8")
    good = subprocess.run(
        [sys.executable, str(SCRIPT), str(tmp_path)], capture_output=True, text=True
    )
    assert good.returncode == 0


def test_real_repository_is_clean() -> None:
    assert dl.scan(REPO) == []
