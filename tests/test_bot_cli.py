import builtins
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from bot.cli import main
from bot.settings import DEFAULTS
from config import Config
from bot.generation import GenerationResult

CHANNEL = "b" * 32
ROOT = Path(__file__).resolve().parent.parent


@pytest.fixture
def cli_config(tmp_path, monkeypatch):
    old = {key: getattr(Config, key) for key in DEFAULTS}
    old_errors = Config._errors
    old_path = Config._env_path
    original_load = Config.load
    env = tmp_path / ".env"
    monkeypatch.setattr(Config, "load", lambda **kwargs: original_load(env_path=env, environ={}, **kwargs))
    yield env
    for key, value in old.items():
        setattr(Config, key, value)
    Config._errors, Config._env_path = old_errors, old_path


def test_help_does_not_import_runtime_even_without_site_packages():
    script = "import sys; from bot.cli import main;\ntry: main(['--help'])\nexcept SystemExit as e: assert e.code == 0\nassert not any(m in sys.modules for m in ['torch','numpy','soundcard','chzzkpy','config','bot.runtime'])"
    result = subprocess.run([sys.executable, "-S", "-c", script], cwd=ROOT, capture_output=True)
    assert result.returncode == 0, result.stderr
    assert b"--doctor" in result.stdout and b"--demo" in result.stdout


def test_invalid_config_rejected_before_runtime_import(cli_config, capsys):
    cli_config.write_text("RESPONSE_CHANCE=nan\nRESPONSE_COOLDOWN=wrong\n", encoding="utf-8")
    assert main(["--mock"]) == 2
    error = capsys.readouterr().err
    assert "RESPONSE_CHANCE" in error and "RESPONSE_COOLDOWN" in error
    assert "Traceback" not in error


def test_overrides_reach_runtime_without_persisting(cli_config, monkeypatch):
    cli_config.write_text("RESPONSE_MODE=mimic\n", encoding="utf-8")
    captured = {}
    class Runtime:
        def __init__(self, **kwargs):
            captured.update(kwargs)
        def start(self):
            return True
    monkeypatch.setitem(sys.modules, "bot.runtime", SimpleNamespace(ChzzkVoiceBot=Runtime))
    assert main(["--channel", f"https://chzzk.naver.com/live/{CHANNEL}", "--mode", "ai", "--speaker", "exact-id", "--mock", "--non-interactive"]) == 0
    assert captured == dict(use_mock=True, auto_send=False, channel_id=CHANNEL, speaker_id="exact-id", non_interactive=True, mode="ai")
    assert cli_config.read_text() == "RESPONSE_MODE=mimic\n"


def test_unattended_live_requires_explicit_auto(cli_config, capsys):
    assert main(["--channel", CHANNEL, "--non-interactive"]) == 2
    assert "--auto" in capsys.readouterr().err


def test_unattended_live_requires_stored_auth(cli_config, capsys):
    assert main(["--channel", CHANNEL, "--non-interactive", "--auto"]) == 2
    assert "쿠키" in capsys.readouterr().err


def test_unattended_requires_channel(cli_config, capsys):
    assert main(["--mock", "--non-interactive"]) == 2
    assert "CHZZK_CHANNEL_ID" in capsys.readouterr().err


def test_demo_ignores_broken_live_configuration(cli_config, monkeypatch):
    cli_config.write_text("RESPONSE_CHANCE=nan", encoding="utf-8")
    calls = []
    monkeypatch.setitem(sys.modules, "bot.replay", SimpleNamespace(run_replay=lambda *a, **k: calls.append((a, k)) or 0))
    assert main(["--demo", "--report", "report.json"]) == 0
    assert calls == [((None,), dict(generate=False, report_path="report.json"))]


@pytest.mark.parametrize("args", [["--generate"], ["--report", "x"], ["--setup", "--non-interactive"], ["--menu", "--non-interactive"], ["--doctor", "--demo"]])
def test_cli_rejects_invalid_action_combinations(args):
    with pytest.raises(SystemExit) as error:
        main(args)
    assert error.value.code == 2


def test_runtime_exception_does_not_print_credentials(cli_config, monkeypatch, capsys):
    class Runtime:
        def __init__(self, **_):
            raise RuntimeError("secret-cookie-value")
    monkeypatch.setitem(sys.modules, "bot.runtime", SimpleNamespace(ChzzkVoiceBot=Runtime))
    assert main(["--mock"]) == 1
    output = capsys.readouterr().err
    assert "secret-cookie-value" not in output and "--doctor" in output


def test_saved_settings_work_without_any_questions(cli_config, monkeypatch):
    cli_config.write_text(f"CHZZK_CHANNEL_ID={CHANNEL}\nAUDIO_SPEAKER_ID=saved-id\n", encoding="utf-8")
    monkeypatch.setattr(builtins, "input", lambda *_: (_ for _ in ()).throw(AssertionError("prompt")))
    captured = {}
    class Runtime:
        def __init__(self, **kwargs):
            captured.update(kwargs)
        def start(self):
            return True
    monkeypatch.setitem(sys.modules, "bot.runtime", SimpleNamespace(ChzzkVoiceBot=Runtime))
    assert main(["--mock", "--non-interactive"]) == 0
    assert captured["channel_id"] == CHANNEL and captured["speaker_id"] == "saved-id"


def test_setup_output_can_be_reused_by_unattended_mock(cli_config, monkeypatch):
    from bot.setup import run_setup
    answers = iter([f"https://chzzk.naver.com/live/{CHANNEL}", "mimic", "", "", "device-42", "15"])
    assert run_setup(cli_config, input_fn=lambda _: next(answers), output=lambda _: None) == 0
    captured = {}
    class Runtime:
        def __init__(self, **kwargs):
            captured.update(kwargs)
        def start(self):
            assert Config.RESPONSE_COOLDOWN == 15
            return True
    monkeypatch.setitem(sys.modules, "bot.runtime", SimpleNamespace(ChzzkVoiceBot=Runtime))
    monkeypatch.setattr(builtins, "input", lambda *_: (_ for _ in ()).throw(AssertionError("unexpected question")))
    assert main(["--mock", "--non-interactive"]) == 0
    assert captured["mode"] == "mimic"
    assert captured["channel_id"] == CHANNEL and captured["speaker_id"] == "device-42"


def test_generated_replay_cli_uses_model_adapter_without_account_or_channel(cli_config, monkeypatch, tmp_path):
    scenario = tmp_path / "scenario.json"
    scenario.write_text(json.dumps({"version": 1, "events": [{"at": 0, "speech": "오늘은 좀 쉴까"}]}), encoding="utf-8")
    report = tmp_path / "report.json"
    calls = []
    class Model:
        def __init__(self, *, clock):
            calls.append("model")
        def check_connection(self):
            calls.append("check")
            return True
        def generate_result(self, speech, chat, **kwargs):
            calls.append((speech, kwargs["speech_context"]))
            return GenerationResult("generated", "쉬어도 좋겠네", "쉬어도 좋겠네", "reply")
        def validate_response(self, text):
            return text
        def record_sent_response(self, speech, text):
            calls.append("record-simulated")
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(LLMHandler=Model))
    # Any accidental runtime/account access must fail, not open a real service.
    monkeypatch.setitem(sys.modules, "bot.runtime", None)
    monkeypatch.setitem(sys.modules, "chat_sender", None)
    assert main(["--replay", str(scenario), "--generate", "--report", str(report)]) == 0
    result = json.loads(report.read_text(encoding="utf-8"))
    assert result["source"] == "ollama" and result["actual_messages_sent"] == 0
    assert result["events"][0]["response"] == "쉬어도 좋겠네"
    assert calls[0:2] == ["model", "check"] and calls[-1] == "record-simulated"


def test_generated_replay_bad_settings_never_construct_model(cli_config, monkeypatch):
    cli_config.write_text("RESPONSE_MAX_AGE_SECONDS=nan\n", encoding="utf-8")
    monkeypatch.setitem(sys.modules, "llm_handler", None)
    assert main(["--demo", "--generate"]) == 2


def test_generated_replay_missing_model_has_actionable_exit(cli_config, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(
        LLMHandler=lambda **_: SimpleNamespace(check_connection=lambda: False)))
    assert main(["--demo", "--generate"]) == 2
    assert "--doctor" in capsys.readouterr().out


def test_evaluation_cli_default_suite_and_model_override_are_text_only(cli_config, monkeypatch):
    calls = []
    monkeypatch.setitem(sys.modules, "bot.evaluation", SimpleNamespace(run_evaluation=lambda *a, **kw: calls.append((a, kw)) or 0))
    monkeypatch.setitem(sys.modules, "bot.runtime", None)
    monkeypatch.setitem(sys.modules, "chat_sender", None)
    assert main(["--evaluate", "--model", "test:small", "--non-interactive"]) == 0
    assert calls == [((None,), {"report_path": None, "model_name": "test:small"})]
    assert Config.OLLAMA_MODEL == "test:small"
    assert not cli_config.exists(), "Evaluation model selection must not rewrite saved settings"


def test_evaluation_cli_explicit_suite_and_report(cli_config, monkeypatch):
    calls = []
    monkeypatch.setitem(sys.modules, "bot.evaluation", SimpleNamespace(run_evaluation=lambda *a, **kw: calls.append((a, kw)) or 1))
    assert main(["--evaluate", "suite.json", "--report", "review.json"]) == 1
    assert calls == [(("suite.json",), {"report_path": "review.json", "model_name": None})]


@pytest.mark.parametrize("args", [["--model", "a"], ["--demo", "--model", "a"],
                                  ["--evaluate", "--generate"], ["--evaluate", "--demo"]])
def test_evaluation_cli_rejects_ambiguous_actions(args):
    with pytest.raises(SystemExit) as error:
        main(args)
    assert error.value.code == 2
