import io
import json
import threading
import time
from types import SimpleNamespace

import pytest

from bot.control import BotControl, MAX_LINE, run_control
from bot.generation import GenerationResult
from response_pipeline import ResponseCandidate, ResponsePipeline


class Settings:
    LLM_PROVIDER = "ollama"
    OLLAMA_HOST = "http://localhost:11434"
    OLLAMA_MODEL = "local-test"
    LLM_BASE_URL = "https://example.invalid/v1"
    LLM_MODEL = "remote-test"
    LLM_API_KEY = ""
    NID_AUT = "fake-auth"
    NID_SES = "fake-session"
    RESPONSE_MAX_AGE_SECONDS = 20

    def __init__(self):
        self.original = {key: getattr(self, key) for key in dir(self) if key.isupper()}

    def load(self, *, overrides):
        self.__dict__.update(self.original)
        self.__dict__.update(overrides)

    def validate(self, **_):
        if self.LLM_BASE_URL == "invalid":
            raise ValueError("SECRET")


def wait_done(control):
    thread = control._thread
    if thread:
        thread.join(2)
        assert not thread.is_alive()


def make_control(**kwargs):
    return BotControl(config=Settings(), **kwargs)


def test_configure_redacts_credentials_and_rolls_back_invalid_configuration():
    emitted = []
    control = make_control(emit=emitted.append)
    state = control.configure({"provider": "openai_compatible", "baseUrl": "https://example.invalid/v1",
                               "model": "remote-test", "apiKey": "SECRET"})
    assert state["config"] == {"provider": "openai_compatible", "baseUrl": "https://example.invalid/v1",
                                "model": "remote-test", "apiKeySet": True}
    assert "SECRET" not in json.dumps(emitted)
    with pytest.raises(ValueError, match="AI 설정"):
        control.configure({"baseUrl": "invalid", "apiKey": "DIFFERENT-SECRET"})
    assert control.snapshot()["config"] == state["config"]
    assert control.config.LLM_API_KEY == "SECRET"


@pytest.mark.parametrize("change", [
    {"baseUrl": "https://another.invalid/v1"},
    {"provider": "ollama"},
])
def test_changing_credential_destination_clears_old_key_unless_replaced(change):
    control = make_control()
    control.configure({"provider": "openai_compatible", "apiKey": "OLD-SECRET"})
    control.configure(change)
    assert not control.snapshot()["config"]["apiKeySet"]
    assert control.config.LLM_API_KEY == ""
    control.configure({"provider": "openai_compatible", "baseUrl": "https://new.invalid/v1", "apiKey": "NEW-SECRET"})
    assert control.snapshot()["config"]["apiKeySet"]
    assert control.config.LLM_API_KEY == "NEW-SECRET"


def test_changing_only_model_preserves_credential_for_same_destination():
    control = make_control()
    control.configure({"provider": "openai_compatible", "apiKey": "SECRET"})
    control.configure({"model": "another-model"})
    assert control.config.LLM_API_KEY == "SECRET"


def test_private_authenticate_never_exposes_credentials_and_configure_retains_them():
    emitted = []
    control = make_control(emit=emitted.append)
    state = control.dispatch("authenticate", {"nidAut": "PRIVATE-AUTH", "nidSes": "PRIVATE-SESSION"})
    assert "PRIVATE-" not in json.dumps(state) + json.dumps(emitted)
    assert control.config.NID_AUT == "PRIVATE-AUTH" and control.config.NID_SES == "PRIVATE-SESSION"
    control.configure({"provider": "openai_compatible", "model": "test", "apiKey": "TEST-API-KEY"})
    assert control.config.NID_AUT == "PRIVATE-AUTH" and control.config.NID_SES == "PRIVATE-SESSION"
    assert "PRIVATE-" not in json.dumps(control.snapshot()) + json.dumps(emitted)


@pytest.mark.parametrize("arg", [
    {}, {"nidAut": "one"}, {"nidAut": "", "nidSes": "two"},
    {"nidAut": "cookie\r\nInjected:value", "nidSes": "two"},
    {"nidAut": "cookie;other=value", "nidSes": "two"},
    {"nidAut": "한글", "nidSes": "two"}, {"nidAut": "x" * 8193, "nidSes": "two"},
    {"nidAut": "one", "nidSes": "two", "extra": "value"},
])
def test_private_authentication_rejects_invalid_or_partial_credentials(arg):
    control = make_control()
    original = (control.config.NID_AUT, control.config.NID_SES)
    with pytest.raises(ValueError):
        control.authenticate(arg)
    assert (control.config.NID_AUT, control.config.NID_SES) == original


def test_private_authenticate_is_blocked_while_operation_is_active():
    entered, finish = threading.Event(), threading.Event()
    def generate(*_, **__):
        entered.set()
        assert finish.wait(2)
        return GenerationResult("skipped", reason="model_skip")
    control = make_control(handler_factory=lambda: SimpleNamespace(generate_result=generate))
    control.preview({"speech": "안녕"})
    assert entered.wait(1)
    with pytest.raises(ValueError):
        control.authenticate({"nidAut": "PRIVATE-AUTH", "nidSes": "PRIVATE-SESSION"})
    finish.set()
    wait_done(control)
    assert control.config.NID_AUT == "fake-auth"


@pytest.mark.parametrize("status", ["generated", "skipped", "filtered", "error"])
def test_text_preview_has_actual_outcome_and_never_records_sent_history(status):
    calls = []
    response = "축하해" if status == "generated" else None
    def generate(*args, **kwargs):
        calls.append((args, kwargs))
        return GenerationResult(status, response=response, reason="test_reason")
    control = make_control(handler_factory=lambda: SimpleNamespace(generate_result=generate))
    control.preview({"speech": "기록 넘겼어", "chat": "와", "priorSpeech": ["열 번 시도했어"]})
    wait_done(control)
    events = control.snapshot()["events"]
    assert [event["type"] for event in events] == ["heard", status]
    assert events[-1]["reason"] == "test_reason"
    assert calls[0] == (("기록 넘겼어", "와"), {"speech_context": ("열 번 시도했어",)})
    assert control.snapshot()["sendMode"] == "preview"
    assert control.snapshot()["status"] == ("error" if status == "error" else "idle")


def test_missing_model_client_is_distinct_from_model_request_failure():
    def missing_client():
        raise ImportError("SECRET private import path")
    control = make_control(handler_factory=missing_client)
    control.preview({"speech": "안녕"})
    wait_done(control)
    state = control.snapshot()
    assert state["status"] == "error"
    assert state["events"][-1]["reason"] == "dependencies_missing"
    assert "SECRET" not in json.dumps(state)


def test_cancel_during_bot_construction_never_starts_session():
    entered, release = threading.Event(), threading.Event()
    operations = []
    class Bot:
        def __init__(self, **_):
            entered.set()
            assert release.wait(2)
        def start(self):
            operations.append("start")
        def request_stop(self):
            operations.append("invalidate")
        def stop(self):
            operations.append("cleanup")
    control = make_control(bot_factory=Bot)
    control.start({"channelId": "a" * 32})
    assert entered.wait(1)
    control.stop()
    release.set()
    wait_done(control)
    assert operations == ["invalidate", "cleanup"]


def test_stop_invalidates_inflight_preview_and_configuration_waits_for_cleanup():
    entered, finish = threading.Event(), threading.Event()
    def generate(*_, **__):
        entered.set()
        assert finish.wait(2)
        return GenerationResult("generated", response="이미 늦은 답")
    control = make_control(handler_factory=lambda: SimpleNamespace(generate_result=generate))
    control.preview({"speech": "기다리는 중"})
    assert entered.wait(1)
    assert control.stop()["status"] == "stopping"
    with pytest.raises(ValueError):
        control.configure({"model": "changed"})
    finish.set()
    wait_done(control)
    assert control.snapshot()["status"] == "idle"
    assert [e["type"] for e in control.snapshot()["events"]] == ["heard"]


def test_events_are_bounded_copied_and_late_operations_are_discarded():
    control = make_control()
    for index in range(70):
        control._event({"type": "heard", "speech": str(index)}, 0)
    state = control.snapshot()
    assert len(state["events"]) == 50 and state["events"][0]["speech"] == "20"
    state["events"][0]["speech"] = "changed"
    assert control.snapshot()["events"][0]["speech"] == "20"
    control._event({"type": "error", "reason": "late"}, -1)
    assert control.snapshot()["events"][-1]["type"] == "heard"


def wait_pending(control):
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        pending = control.snapshot()["pending"]
        if pending:
            return pending
        time.sleep(.002)
    pytest.fail("No pending approval")


def test_gui_approval_requires_current_id_and_preserves_edited_text():
    control = make_control(clock=lambda: 100, wall_clock=lambda: 200)
    replies = []
    candidate = ResponseCandidate("발화", "초안", "", 99, 0)
    worker = threading.Thread(target=lambda: replies.append(control._approval(candidate)))
    worker.start()
    pending = wait_pending(control)
    assert pending["expiresAt"] == 219000
    with pytest.raises(ValueError):
        control.approve({"id": "wrong", "action": "send"})
    control.approve({"id": pending["id"], "action": "send", "text": "수정한 답변"})
    worker.join(1)
    assert replies == [{"action": "edit", "text": "수정한 답변"}]
    with pytest.raises(ValueError):
        control.approve({"id": pending["id"], "action": "send"})
    assert control.snapshot()["pending"] is None


@pytest.mark.parametrize("cancel", ["expiry", "stop"])
def test_pending_approval_cannot_send_after_expiry_or_stop(cancel):
    now = [100]
    control = make_control(clock=lambda: now[0])
    replies = []
    worker = threading.Thread(target=lambda: replies.append(control._approval(ResponseCandidate("발화", "답변", "", 99, 0))))
    worker.start()
    pending = wait_pending(control)
    if cancel == "stop":
        control.stop()
    else:
        now[0] = 120
        with control._condition:
            control._condition.notify_all()
    worker.join(1)
    assert replies == [{"action": "skip"}]
    with pytest.raises(ValueError):
        control.approve({"id": pending["id"], "action": "send"})


def test_start_is_noninteractive_and_stop_invalidates_without_waiting_for_device_cleanup():
    started, stopped, clean = threading.Event(), threading.Event(), threading.Event()
    seen = []
    class Bot:
        def __init__(self, **kwargs):
            seen.append(kwargs)
        def start(self):
            seen[0]["event_sink"]({"type": "status", "reason": "running"})
            started.set()
            assert stopped.wait(2)
            assert clean.wait(2)
            return True
        def request_stop(self):
            stopped.set()
        def stop(self):
            stopped.set()
    control = make_control(bot_factory=Bot)
    control.start({"channelId": "a" * 32, "sendMode": "approve", "responseMode": "hybrid"})
    assert started.wait(1)
    assert seen[0]["non_interactive"] is True and seen[0]["auto_send"] is False
    assert callable(seen[0]["approval_provider"])
    assert control.stop()["status"] == "stopping" and stopped.is_set()
    clean.set()
    wait_done(control)
    assert control.snapshot()["status"] == "idle"


def test_sending_requires_saved_login_and_preview_does_not():
    control = make_control()
    control.config.NID_AUT = ""
    with pytest.raises(ValueError, match="로그인"):
        control.start({"channelId": "a" * 32, "sendMode": "auto"})
    assert control.snapshot()["status"] == "idle"


def test_protocol_is_json_only_including_noisy_adapters_and_malformed_requests():
    output = io.StringIO()
    def factory(**kwargs):
        print("SECRET debug")
        return make_control(**kwargs)
    lines = [json.dumps({"id": 1, "method": "getState"}), "broken json",
             json.dumps({"id": True, "method": "getState"}), json.dumps({"id": 2, "method": "unknown"})]
    assert run_control(input_stream=io.StringIO("\n".join(lines)), output_stream=output, factory=factory) == 0
    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert rows[0]["id"] == 1 and rows[0]["ok"]
    assert all(not row["ok"] for row in rows[1:4])
    assert "SECRET" not in output.getvalue()
    assert rows[-1]["event"] == "state"


def test_oversized_protocol_input_stops_before_dispatch():
    output = io.StringIO()
    run_control(input_stream=io.StringIO("x" * (MAX_LINE + 1)), output_stream=output,
                factory=lambda **kwargs: make_control(**kwargs))
    rows = [json.loads(line) for line in output.getvalue().splitlines()]
    assert rows[0]["ok"] is False


def test_runtime_uses_gui_approval_then_rechecks_freshness_without_console_input(monkeypatch):
    from bot.runtime import ChzzkVoiceBot
    now = [100]
    events, sent = [], []
    def approval(_):
        now[0] = 121
        return {"action": "edit", "text": "수정 답변"}
    bot = ChzzkVoiceBot(non_interactive=True, auto_send=False, event_sink=events.append, approval_provider=approval)
    bot.pipeline = ResponsePipeline(mode="ai", clock=lambda: now[0])
    bot.llm_handler = SimpleNamespace(validate_response=lambda value: value)
    bot.chat_sender = SimpleNamespace(send_message=lambda *_, **__: sent.append(True))
    monkeypatch.setattr("builtins.input", lambda *_: pytest.fail("GUI must never read terminal input"))
    assert bot._process_candidate(ResponseCandidate("발화", "답변", "", 100, 0)) is False
    assert not sent
    assert any(event["reason"] == "expired_or_stopped" for event in events if "reason" in event)


def test_control_entrypoint_runs_without_optional_packages(tmp_path):
    import subprocess
    import sys
    from pathlib import Path
    result = subprocess.run([sys.executable, "-B", "-S", str(Path(__file__).resolve().parents[1] / "main.py"), "--control"],
                            input='{"id":1,"method":"getState"}\n', text=True, capture_output=True, timeout=8)
    assert result.returncode == 0, result.stderr
    rows = [json.loads(line) for line in result.stdout.splitlines()]
    assert rows[0]["ok"] and rows[0]["value"]["status"] == "idle"
    assert rows[0]["value"]["events"] == []
    assert not result.stderr
