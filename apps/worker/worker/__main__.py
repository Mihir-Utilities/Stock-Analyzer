"""CLI entry point: ``python -m worker run <job>`` (jobs arrive in D01+)."""

import sys


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if args[:1] == ["hello"]:
        print("india-analyzer worker: hello")
        return 0
    print("usage: python -m worker hello  (jobs are added in task D01)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
