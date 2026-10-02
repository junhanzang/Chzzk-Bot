from pathlib import Path

import pytest

from bot.settings import normalize_channel_id, parse_settings, read_env_values
from bot.setup import run_setup, write_env_values
from config import Config

CHANNEL = "a" * 32


@pytest.mark.parametrize("value", [CHANNEL, CHANNEL.upper(), f"https://chzzk.naver.com/live/{CHANNEL}?x=1",
                                    f"https://chzzk.naver.com/{CHANNEL}/", f"https://m.chzzk.naver.com/live/{CHANNEL}"])
def test_channel_accepts_only_real_channel_shapes(value):
    assert normalize_channel_id(value) == CHANNEL


@pytest.mark.parametrize("value", ["", "abc123", "../profile", "https://evil.test/" + CHANNEL,
                                    "https://chzzk.naver.com.evil.test/live/" + CHANNEL,
                                    "https://u:p@chzzk.naver.com/live/" + CHANNEL,
                                    "https://chzzk.naver.com/video/" + CHANNEL,
                                    "https://chzzk.naver.com:wrong/live/" + CHANNEL])
def test_channel_rejects_untrusted_hosts_paths_and_credentials(value):
    with pytest.raises(ValueError, match="채널"):
        normalize_channel_id(value)


def test_all_invalid_numbers_reported_without_import_error_or_values():
    values, errors = parse_settings({"RESPONSE_COOLDOWN": "secret-invalid", "RESPONSE_CHANCE": "nan",
                                     "RESPONSE_MAX_AGE_SECONDS": "inf", "AUDIO_CHUNK_DURATION": "0",
                                     "LLM_MAX_TOKENS": "1.5", "SMART_RESPONSE": "maybe"})
    assert len(errors) == 6
    assert "secret-invalid" not in " ".join(errors)
    assert values["RESPONSE_COOLDOWN"] == 10
    assert values["RESPONSE_CHANCE"] == 1


def test_banned_words_preserve_newline_and_case_insensitive_deduplication():
    values, errors = parse_settings({"BANNED_WORDS": "one, TWO\none, two\n셋"})
    assert not errors
    assert values["BANNED_WORDS"] == ("one", "TWO", "셋")


@pytest.mark.parametrize("key,value", [("RESPONSE_CHANCE", "-1"), ("RESPONSE_CHANCE", "1.1"),
                                      ("AUDIO_SAMPLE_RATE", "1"), ("RESPONSE_MODE", "unknown"),
                                      ("OLLAMA_HOST", "http://user:secret@localhost"),
                                      ("OLLAMA_HOST", "http://localhost:invalid"),
                                      ("OLLAMA_HOST", "file:///tmp"), ("ASR_MODEL", ""),
                                      ("OLLAMA_HOST", "http://local\nhost:11434"),
                                      ("LLM_MAX_TOKENS", True), ("LLM_MAX_TOKENS", 1.5)])
def test_config_rejects_bad_ranges_and_hosts(key, value):
    _, errors = parse_settings({key: value})
    assert any(error.startswith(key + ":") for error in errors)
    assert "secret" not in " ".join(errors)


def test_configuration_precedence_and_reload(tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"CHZZK_CHANNEL_ID={CHANNEL}\nRESPONSE_COOLDOWN=25\nRESPONSE_MODE=ai\n", encoding="utf-8")
    class Local(Config):
        pass
    Local.load(env_path=env, environ={"RESPONSE_COOLDOWN": "30"}, overrides={"RESPONSE_COOLDOWN": 35})
    assert Local.validate()
    assert Local.RESPONSE_COOLDOWN == 35
    Local.load(env_path=env, environ={})
    assert Local.RESPONSE_COOLDOWN == 25


def test_config_default_env_is_not_working_directory(tmp_path, monkeypatch):
    import config
    project = tmp_path / "project.env"
    project.write_text(f"CHZZK_CHANNEL_ID={CHANNEL}", encoding="utf-8")
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / ".env").write_text("CHZZK_CHANNEL_ID=invalid", encoding="utf-8")
    monkeypatch.setattr(config, "ENV_PATH", project)
    monkeypatch.chdir(elsewhere)
    class Local(Config):
        pass
    assert Local.load(environ={}).validate()


def test_missing_channel_optional_for_doctor_and_interactive(tmp_path):
    class Local(Config):
        pass
    Local.load(env_path=tmp_path / "missing", environ={})
    assert Local.validate(require_channel=False)
    with pytest.raises(ValueError, match="CHZZK_CHANNEL_ID"):
        Local.validate()


def test_env_update_keeps_credentials_unknown_lines_and_comments(tmp_path):
    env = tmp_path / ".env"
    env.write_bytes(b"# keep this\r\nNID_AUT=secret-original\r\nUNKNOWN=untouched\r\nRESPONSE_MODE=ai\r\nRESPONSE_MODE=mimic\r\n")
    write_env_values(env, {"RESPONSE_MODE": "hybrid", "AUDIO_SPEAKER_ID": 'device\\path "quotes" $HOME # fine'})
    text = env.read_bytes().decode()
    assert "NID_AUT=secret-original\r\nUNKNOWN=untouched" in text
    assert text.count("RESPONSE_MODE=") == 1
    assert text.startswith("# keep this\r\n")
    parsed = read_env_values(env)
    assert parsed["AUDIO_SPEAKER_ID"] == 'device\\path "quotes" $HOME # fine'
    assert parsed["RESPONSE_MODE"] == "hybrid"


def test_env_update_can_append_missing_login_keys(tmp_path):
    env = tmp_path / ".env"
    write_env_values(env, {"NID_AUT": "first", "NID_SES": "second"})
    assert read_env_values(env) == {"NID_AUT": "first", "NID_SES": "second"}


def test_env_replace_failure_preserves_original_and_cleans_temporary(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("NID_AUT=existing\n", encoding="utf-8")
    monkeypatch.setattr("bot.setup.os.replace", lambda *_: (_ for _ in ()).throw(OSError("locked")))
    with pytest.raises(OSError):
        write_env_values(env, {"NID_AUT": "new"})
    assert env.read_text() == "NID_AUT=existing\n"
    assert list(tmp_path.iterdir()) == [env]


def test_setup_preserves_secrets_and_advanced_values(tmp_path):
    env = tmp_path / ".env"
    env.write_text("NID_AUT=never-print-this\nRESPONSE_CHANCE=0.3\nCUSTOM=keep\n", encoding="utf-8")
    answers = iter([f"https://chzzk.naver.com/live/{CHANNEL}", "", "", "", "", ""])
    output = []
    assert run_setup(env, input_fn=lambda _: next(answers), output=output.append) == 0
    values = read_env_values(env)
    assert values["CHZZK_CHANNEL_ID"] == CHANNEL
    assert values["NID_AUT"] == "never-print-this"
    assert values["CUSTOM"] == "keep" and values["RESPONSE_CHANCE"] == "0.3"
    assert "never-print-this" not in " ".join(output)


def test_setup_cancel_does_not_create_file(tmp_path):
    env = tmp_path / ".env"
    def interrupted(_):
        raise KeyboardInterrupt
    assert run_setup(env, input_fn=interrupted, output=lambda _: None) == 130
    assert not env.exists()


def test_setup_can_clear_previous_audio_device(tmp_path):
    env = tmp_path / ".env"
    env.write_text(f"CHZZK_CHANNEL_ID={CHANNEL}\nAUDIO_SPEAKER_ID=old-device\n", encoding="utf-8")
    answers = iter(["", "", "", "", "-", ""])
    assert run_setup(env, input_fn=lambda _: next(answers), output=lambda _: None) == 0
    assert read_env_values(env)["AUDIO_SPEAKER_ID"] == ""


def test_env_read_quotes_comments_and_export(tmp_path):
    env = tmp_path / ".env"
    env.write_text("export MODE='hello # literal' # comment\nVALUE=abc # comment\nCOOKIE=abc#literal\n", encoding="utf-8")
    assert read_env_values(env) == {"MODE": "hello # literal", "VALUE": "abc", "COOKIE": "abc#literal"}
