"""SAF-01 and SAF-02: the deny-list fails on forbidden libraries, hosts and order methods."""

from __future__ import annotations

import base64
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
        ("apps/worker/requirements.txt", "stocksymbol==1.0\n", "nse-library"),
        ("apps/worker/uv.lock", 'name = "stocksymbol"\n', "nse-library"),
        ("apps/api/go.sum", "github.com/x/gnews v1.0.0 h1:abc\n", "news-rss"),
    ],
)
def test_forbidden_items_are_detected(tmp_path: Path, rel: str, text: str, rule: str) -> None:
    write(tmp_path, rel, text)
    found = dl.scan(tmp_path)
    assert [v.rule for v in found] == [rule], found
    assert found[0].path == rel


@pytest.mark.parametrize(
    ("rel", "text"),
    [
        ("apps/web/src/a.ts", "export const isStockSymbol = (s: string) => true;\n"),
        ("apps/web/src/b.ts", "const stockSymbol = 'TCS';\n"),
        ("apps/worker/worker/c.py", "def stocksymbol_ok(): ...\n"),
        ("apps/worker/pyproject.toml", 'dependencies = ["isStockSymbol-helper"]\n'),
    ],
)
def test_stock_symbol_identifiers_pass(tmp_path: Path, rel: str, text: str) -> None:
    write(tmp_path, rel, text)
    assert dl.scan(tmp_path) == []


def test_exemptions(tmp_path: Path) -> None:
    # research links are plain hyperlinks (T00): exempt. Specs and notes are Markdown prose.
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


# ---- bypass attempts found in the T00 review: every one must now be caught ---------------------
@pytest.mark.parametrize(
    "rel",
    [
        "apps/worker/worker/tasks/a.py",  # directories named tasks/docs/build/dist/vendor/coverage
        "apps/web/src/app/docs/a.py",
        "apps/api/build/a.py",
        "apps/api/vendor/x/a.py",
        "apps/worker/dist/a.py",
        "apps/web/coverage/a.py",
        "docs/field-map.json",  # only Markdown is skipped, not code-like files under docs/
        "scripts/tests/other_test.py",  # only test_deny_list.py itself is exempt
        "apps/api/Dockerfile.api",
        "apps/api/api.Dockerfile",
        "apps/api/Containerfile",
        ".env.example",
        ".env",
        "scripts/x.ps1",
        "apps/web/src/a.mts",
        "apps/web/public/a.html",
        "fixtures/a.csv",
        "apps/worker/requirements.in",
        "apps/worker/Pipfile",
        "go.work",
        ".github/workflows/x.yml",
    ],
)
def test_location_and_file_type_bypasses(tmp_path: Path, rel: str) -> None:
    write(tmp_path, rel, "pip install yfinance\n")
    assert [v.rule for v in dl.scan(tmp_path)] == ["yahoo-finance"], rel


def test_utf16_files_are_decoded(tmp_path: Path) -> None:
    target = tmp_path / "apps/worker/requirements.txt"
    target.parent.mkdir(parents=True)
    target.write_bytes("yfinance==0.2.40\n".encode("utf-16"))  # BOM, as PowerShell writes it
    assert [v.rule for v in dl.scan(tmp_path)] == ["yahoo-finance"]
    target.write_bytes("import yfinance\n".encode("utf-16-le"))  # no BOM
    assert [v.rule for v in dl.scan(tmp_path)] == ["yahoo-finance"]


def test_real_binary_files_are_skipped(tmp_path: Path) -> None:
    target = tmp_path / "apps/web/public/blob.bin"
    target.parent.mkdir(parents=True)
    target.write_bytes(bytes(range(256)) * 20)
    assert dl.scan(tmp_path) == []


@pytest.mark.parametrize(
    ("rel", "text"),
    [
        ("apps/web/package.json", '{"dependencies": {"yahoo-finance2": "^2"}}\n'),
        ("apps/worker/requirements.txt", "yahoo_fin\n"),
        ("apps/worker/requirements.txt", "yahooquery\n"),
        ("apps/worker/requirements.txt", "yfinance2\n"),
        ("apps/worker/requirements.txt", "pandas-datareader\n"),
        ("apps/worker/requirements.txt", "investpy\nnselib\n"),
        ("apps/worker/requirements.txt", "beautifulsoup4\n"),
        ("apps/worker/worker/a.py", "import my_yfinance\n"),
        ("apps/web/src/a.ts", 'fetch("https://nsearchives.nseindia.com/x")\n'),
        ("apps/web/src/a.ts", 'fetch("https://WWW.NSEINDIA.COM./x")\n'),
        ("apps/web/src/a.ts", 'fetch("https://www.moneycontrol.com/x")\n'),
        ("apps/api/internal/k.go", "func placeOrderRegular() {}\n"),
        ("apps/api/internal/k.go", "func placeGttOrder() {}\n"),
        ("apps/api/internal/k.go", "func SquareOff() {}\n"),
        ("apps/api/internal/k.go", 'const p = "/v2/order/place"\n'),
        ("apps/api/internal/k.go", 'const p = "/orders/regular"\n'),
        ("apps/api/internal/k.go", 'const p = "/v2/orders"\n'),
    ],
)
def test_pattern_gaps_are_closed(tmp_path: Path, rel: str, text: str) -> None:
    write(tmp_path, rel, text)
    assert dl.scan(tmp_path) != [], text


_B64_HOST = base64.b64encode(b"https://www.nseindia.com/api").decode()


@pytest.mark.parametrize(
    ("text", "view"),
    [
        ('m = import_module("yfin" + "ance")\n', "split"),
        ("H = ('https://query1.finance.'\n     'yahoo.com')\n", "split"),
        ('x := "nse" +\n "india.com"\n', "split"),
        ('fetch("https://query1.finance%2Eyahoo%2Ecom/v8")\n', "escaped"),
        ('fetch("https://www.\\u006eseindia.com")\n', "escaped"),
        ('H = "\\x79finance"\n', "escaped"),
        (f"H = base64.b64decode('{_B64_HOST}')\n", "base64"),
    ],
)
def test_simple_obfuscation_is_caught(tmp_path: Path, text: str, view: str) -> None:
    write(tmp_path, "apps/worker/worker/a.py", text)
    found = dl.scan(tmp_path)
    assert found, text
    assert found[0].rule.endswith(f":{view}"), (text, found)


def test_prose_does_not_false_positive(tmp_path: Path) -> None:
    write(tmp_path, "apps/web/src/a.ts", 'const s = "my finance";\nconst r = replaceOrder();\n')
    write(
        tmp_path,
        "apps/web/src/b.ts",
        "import { x } from './screener.index';\nscreener.input.focus();\n",
    )
    write(tmp_path, "apps/web/src/c.ts", 'const t = "Sort order of columns";\n')
    assert dl.scan(tmp_path) == []


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
