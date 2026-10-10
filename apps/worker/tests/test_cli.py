import pytest

from worker.__main__ import main


def test_hello_returns_zero(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["hello"]) == 0
    assert "hello" in capsys.readouterr().out


def test_unknown_command_returns_usage_error(capsys: pytest.CaptureFixture[str]) -> None:
    assert main(["bogus"]) == 2
    assert "usage" in capsys.readouterr().err
