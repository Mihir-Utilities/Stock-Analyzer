"""A tiny YAML reader for the repository's GitHub workflow files (no PyYAML dependency).

Supports what those files use: nested mappings, block lists (also ``- key: value`` items), plain and
quoted scalars, ``#`` comments and ``|`` block scalars. Anything else raises ``ValueError`` so a
construct the reader does not understand cannot silently pass a structural test.
"""

from __future__ import annotations

import re
from typing import Any

_KEY = re.compile(r"^([\w.\-/${}\[\] ]+?|'[^']*'|\"[^\"]*\"):(?: +(.*))?$")


def _scalar(value: str) -> Any:
    value = value.strip()
    if value[:1] in ("'", '"'):
        end = value.rfind(value[0])
        if end <= 0:
            raise ValueError(f"unterminated quote: {value}")
        return value[1:end]
    value = re.split(r"\s#", value, maxsplit=1)[0].strip()
    if value in ("true", "false"):
        return value == "true"
    if re.fullmatch(r"-?\d+", value):
        return int(value)
    if value.startswith(("[", "{")):
        if value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            return [_scalar(p) for p in inner.split(",")] if inner else []
        raise ValueError(f"unsupported flow value: {value}")
    return value


class _Parser:
    def __init__(self, text: str) -> None:
        self.lines = text.replace("\r\n", "\n").split("\n")
        self.i = 0

    def peek(self) -> tuple[int, str] | None:
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if not raw.strip() or raw.lstrip().startswith("#"):
                self.i += 1
                continue
            return len(raw) - len(raw.lstrip()), raw.strip()
        return None

    def block(self, indent: int) -> Any:
        head = self.peek()
        assert head is not None
        return self.seq(head[0]) if head[1].startswith("- ") else self.map(head[0])

    def seq(self, indent: int) -> list[Any]:
        out: list[Any] = []
        while True:
            head = self.peek()
            if head is None or head[0] != indent or not head[1].startswith("- "):
                return out
            content = head[1][2:]
            if _KEY.match(content) and not content.startswith(("'", '"')):
                self.lines[self.i] = " " * (indent + 2) + content
                out.append(self.map(indent + 2))
            else:
                out.append(_scalar(content))
                self.i += 1

    def map(self, indent: int) -> dict[str, Any]:
        out: dict[str, Any] = {}
        while True:
            head = self.peek()
            if head is None or head[0] != indent or head[1].startswith("- "):
                return out
            match = _KEY.match(head[1])
            if match is None:
                raise ValueError(f"cannot read line: {head[1]!r}")
            key = _scalar(match.group(1)) if match.group(1)[:1] in "'\"" else match.group(1)
            value = (match.group(2) or "").strip()
            self.i += 1
            if value and not value.startswith("#"):
                if value[0] in "|>":
                    out[key] = self.block_scalar(indent)
                else:
                    out[key] = _scalar(value)
                continue
            nxt = self.peek()
            if nxt is not None and (
                nxt[0] > indent or (nxt[0] == indent and nxt[1].startswith("- "))
            ):
                out[key] = self.block(nxt[0])
            else:
                out[key] = None

    def block_scalar(self, indent: int) -> str:
        body: list[str] = []
        while self.i < len(self.lines):
            raw = self.lines[self.i]
            if raw.strip() and len(raw) - len(raw.lstrip()) <= indent:
                break
            body.append(raw)
            self.i += 1
        pad = min((len(r) - len(r.lstrip()) for r in body if r.strip()), default=0)
        return "\n".join(r[pad:] for r in body).rstrip("\n") + "\n"


def load(text: str) -> dict[str, Any]:
    parser = _Parser(text)
    head = parser.peek()
    if head is None:
        return {}
    result = parser.block(head[0])
    if parser.peek() is not None:
        raise ValueError(f"trailing content at line {parser.i + 1}")
    if not isinstance(result, dict):
        raise ValueError("a workflow must be a mapping")
    return result
