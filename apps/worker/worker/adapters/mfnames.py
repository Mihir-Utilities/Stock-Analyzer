"""Plan / option derivation from a scheme name (docs/01 section 4; MF-01)."""

from __future__ import annotations

import re

_DIRECT = re.compile(r"\bdirect\b", re.IGNORECASE)
_REGULAR = re.compile(r"\bregular\b", re.IGNORECASE)
_GROWTH = re.compile(r"\bgrowth\b", re.IGNORECASE)
_IDCW = re.compile(r"\b(idcw|dividend|div|payout|reinvestment)\b", re.IGNORECASE)


def classify_plan_option(text: str | None) -> tuple[str, str]:
    """Return (``direct|regular|unknown``, ``growth|idcw|unknown``).

    Both Direct and Regular present (or neither) -> unknown; both Growth and IDCW words present
    -> unknown (ambiguous names are never guessed).
    """
    if not text:
        return "unknown", "unknown"
    direct, regular = bool(_DIRECT.search(text)), bool(_REGULAR.search(text))
    if direct and not regular:
        plan = "direct"
    elif regular and not direct:
        plan = "regular"
    else:
        plan = "unknown"
    growth, idcw = bool(_GROWTH.search(text)), bool(_IDCW.search(text))
    if growth and not idcw:
        option = "growth"
    elif idcw and not growth:
        option = "idcw"
    else:
        option = "unknown"
    return plan, option
