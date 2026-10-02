from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import zipfile
from types import SimpleNamespace

import pytest

from bot.telemetry import SessionMetrics
import build_dist


def test_metrics_preserve_all_concurrent_counts_and_return_copies():
    metrics = SessionMetrics()
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(lambda _: metrics.increment("sent"), range(2000)))
    assert metrics.snapshot() == {"sent": 2000}
    snapshot = metrics.snapshot()
    snapshot["sent"] = 0
    assert metrics.snapshot()["sent"] == 2000
    assert "전송 2000" in metrics.summary()
    with pytest.raises(ValueError):
        metrics.increment("채팅 원문")


def test_launcher_commands_reload_settings_without_shell_or_live_side_effects(monkeypatch):
    from bot import launcher
    answers = iter(["invalid", "1", "2", "3", "0"])
    monkeypatch.setattr("builtins.input", lambda _: next(answers))
    calls = []
    monkeypatch.setattr(launcher.subprocess, "call", lambda args, **kw: calls.append((args, kw)) or 0)
    assert launcher.main() == 0
    assert [args[-1] for args, _ in calls] == ["--setup", "--doctor", "--demo"]
    assert all(args[0] == sys.executable and "shell" not in kw for args, kw in calls)


def test_distribution_includes_runtime_and_excludes_private_data(tmp_path):
    root = Path(__file__).resolve().parents[1]
    archive, checksum = build_dist.build_zip(tmp_path / "bot.zip")
    assert checksum.read_text().split()[0] == hashlib.sha256(archive.read_bytes()).hexdigest()
    first = archive.read_bytes()
    build_dist.build_zip(archive)
    assert archive.read_bytes() == first, "A source revision should have a reproducible ZIP"
    with zipfile.ZipFile(archive) as bundle:
        names = bundle.namelist()
        assert "main.py" in names and "start-bot.cmd" in names
        assert "examples/bot-demo.json" in names and "bot/replay.py" in names
        assert {p.relative_to(root).as_posix() for p in (root / "bot").glob("*.py")} <= set(names)
        assert not any(name == ".env" or name.startswith(("data/", "models/", ".git/")) or "__pycache__" in name for name in names)
        extracted = tmp_path / "unpacked"
        bundle.extractall(extracted)
    # No site-packages, account, GPU drivers or audio SDKs: test the shipped
    # entrypoint from another current directory, exactly as a first-time user.
    env = dict(os.environ, PYTHONUTF8="1", PYTHONDONTWRITEBYTECODE="1")
    result = subprocess.run([sys.executable, "-S", str(extracted / "main.py"), "--demo"],
                            cwd=tmp_path, env=env, capture_output=True, text=True, encoding="utf-8", timeout=15)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "실제 채팅 전송 없음" in result.stdout


def test_missing_source_aborts_without_replacing_existing_archive(tmp_path):
    archive = tmp_path / "bot.zip"
    archive.write_bytes(b"old artifact")
    with pytest.raises(ValueError):
        build_dist.build_zip(archive, source=tmp_path / "missing")
    assert archive.read_bytes() == b"old artifact"


@pytest.mark.parametrize("wanted,models,expected", [
    ("qwen3:4b", [{"name": "qwen3:4b-other"}], False),
    ("qwen3", [{"name": "qwen3:latest"}], True),
    ("qwen3:4b", [{"name": "qwen3:4b"}], True),
    ("qwen3:4b", [{"name": None}, {"model": []}], False),
    ("qwen3:4b", "unexpected response", False),
])
def test_runtime_and_doctor_use_the_same_exact_model_match(monkeypatch, wanted, models, expected):
    import llm_handler
    response = SimpleNamespace(status_code=200, json=lambda: {"models": models})
    monkeypatch.setattr(llm_handler.requests, "get", lambda *args, **kw: response)
    assert llm_handler.LLMHandler(model_name=wanted, host="http://unused").check_connection() is expected
