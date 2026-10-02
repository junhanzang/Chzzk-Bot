from types import SimpleNamespace

import pytest

from bot.diagnostics import collect_diagnostics, model_is_available, run_doctor


def settings(**changes):
    values = dict(CHZZK_CHANNEL_ID="a" * 32, NID_AUT="secret-aut", NID_SES="secret-ses",
                  RESPONSE_MODE="hybrid", OLLAMA_HOST="http://localhost:11434", OLLAMA_MODEL="foo",
                  validation_errors=lambda **_: [])
    values.update(changes)
    return SimpleNamespace(**values)


@pytest.mark.parametrize("wanted,models,expected", [
    ("foo", [{"name": "foo:latest"}], True), ("foo:latest", [{"name": "foo"}], True),
    ("foo", [{"name": "foobar:latest"}], False), ("foo:4b", [{"name": "foo:8b"}], False),
    ("foo", [{"model": "foo:latest"}], True), ("host:8000/org/foo", [{"name": "host:8000/org/foo:latest"}], True),
    ("foo", [None, "foo"], False),
    ("foo", [{"name": None}, {"model": []}], False),
    ("foo", {"name": "foo"}, False),
    (None, [{"name": "foo"}], False),
])
def test_model_aliases_are_exact(wanted, models, expected):
    assert model_is_available(wanted, models) is expected


def test_doctor_no_imports_accounts_audio_or_secret_output():
    found = []
    calls = []
    def fetch(host, **kwargs):
        calls.append((host, kwargs))
        return [{"name": "foo:latest"}]
    output = []
    result = run_doctor(settings(), output=output.append,
                        find_spec=lambda name: found.append(name) or object(), fetch_models=fetch)
    assert result == 0
    assert "qwen_asr" in found and "soundcard" in found
    assert calls == [("http://localhost:11434", {"timeout": 3})]
    assert "secret-aut" not in " ".join(output) and "secret-ses" not in " ".join(output)


def test_mimic_doctor_skips_audio_models_and_network():
    def unexpected(*_, **__):
        raise AssertionError("unexpected network")
    modules = []
    checks = collect_diagnostics(settings(RESPONSE_MODE="mimic"),
                                 find_spec=lambda name: modules.append(name) or object(), fetch_models=unexpected)
    assert modules == ["chzzkpy", "requests"]
    assert not any(check.status == "error" for check in checks)


def test_bad_host_configuration_never_connects():
    def unexpected(*_, **__):
        raise AssertionError("unexpected network")
    config = settings(validation_errors=lambda **_: ["OLLAMA_HOST: invalid"])
    assert run_doctor(config, output=lambda _: None, find_spec=lambda _: object(), fetch_models=unexpected) == 1


def test_missing_packages_and_timeout_are_actionable_and_redacted():
    def broken(*_, **__):
        raise TimeoutError("request contained secret-aut")
    output = []
    assert run_doctor(settings(), output=output.append, find_spec=lambda _: None, fetch_models=broken) == 1
    text = " ".join(output)
    assert "pip install" in text and "Ollama" in text
    assert "secret-aut" not in text
