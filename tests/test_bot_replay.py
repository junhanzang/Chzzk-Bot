import json
from types import SimpleNamespace

import pytest

from bot.replay import DEMO_PATH, load_scenario, replay_events, run_replay
from bot.generation import GenerationResult


def write_scenario(tmp_path, events):
    path = tmp_path / "scenario.json"
    path.write_text(json.dumps({"version": 1, "events": events}, ensure_ascii=False), encoding="utf-8")
    return path


def test_demo_covers_context_approval_edit_cooldown_duplicates_and_expiry():
    report = replay_events(load_scenario(DEMO_PATH))
    assert report["expectations_passed"]
    assert report["actual_messages_sent"] == 0
    assert report["events"][1]["prior_speech"] == ["첫 번째 상자는 이미 열었어"]
    assert report["counts"] == {"accepted": 2, "cooldown": 1, "expired": 1, "filtered": 1, "skipped": 2, "error": 0}
    assert report["events"][-1]["response"] == "잠깐 쉬었다 해도 좋겠다"


@pytest.mark.parametrize("change", [
    {"at": float("nan")}, {"at": True}, {"at": -1}, {"delay": float("inf")},
    {"delay": -1}, {"speech": None}, {"speech": ""}, {"draft": []},
    {"action": "execute"}, {"action": "edit"}, {"expected": "sent"}, {"expected": []},
    {"expected": {}}, {"secret": "unused"},
])
def test_invalid_scenarios_are_rejected_before_inference(tmp_path, change):
    path = write_scenario(tmp_path, [{"at": 0, "speech": "안녕", **change}])
    with pytest.raises(ValueError):
        load_scenario(path)


def test_unordered_and_oversized_scenarios_rejected(tmp_path):
    path = write_scenario(tmp_path, [{"at": 2, "speech": "안녕"}, {"at": 1, "speech": "안녕"}])
    with pytest.raises(ValueError):
        load_scenario(path)
    path.write_bytes(b" " * (1024 * 1024 + 1))
    with pytest.raises(ValueError):
        load_scenario(path)


def test_slow_model_expiry_skips_obsolete_queued_speech_without_recording_it():
    ticks = iter([0, 21, 21, 22])
    calls, records = [], []
    handler = SimpleNamespace(
        generate_result=lambda speech, chat, **kw: calls.append(speech) or GenerationResult("generated", "수고했네", "수고했네", "reply"),
        validate_response=lambda text: text,
        record_sent_response=lambda *args: records.append(args),
    )
    report = replay_events([
        {"at": 0, "speech": "첫 발언"},
        {"at": 0.5, "speech": "밀린 발언"},
        {"at": 30, "speech": "다음 발언", "expected": "filtered"},
    ], handler_factory=lambda clock: handler, elapsed_clock=lambda: next(ticks))
    assert calls == ["첫 발언", "다음 발언"]
    assert records == [("다음 발언", "수고했네")]
    assert [row["status"] for row in report["events"]] == ["expired", "expired", "accepted"]
    assert [row["generation_status"] for row in report["events"]] == ["generated", "not_run", "generated"]
    assert report["events"][0]["raw_text"] == "수고했네", "Keep inference outcome even when transport expires"
    assert "expected" not in report["events"][-1], "Prepared drafts must not grade a real model"


def test_replay_report_does_not_overwrite_input(tmp_path):
    path = write_scenario(tmp_path, [{"at": 0, "speech": "안녕", "draft": "안녕"}])
    original = path.read_bytes()
    assert run_replay(path, report_path=path) == 2
    assert path.read_bytes() == original


def test_invalid_report_path_fails_before_model_loading(tmp_path, monkeypatch):
    import sys
    monkeypatch.setitem(sys.modules, "llm_handler", None)
    assert run_replay(generate=True, report_path=tmp_path / "report.txt") == 2


def test_report_is_reviewable_and_expectation_failure_exits_nonzero(tmp_path):
    path = write_scenario(tmp_path, [{"at": 0, "speech": "안녕", "draft": "[SKIP]", "expected": "accepted"}])
    report_path = tmp_path / "reports" / "report.json"
    assert run_replay(path, report_path=report_path) == 1
    report = json.loads(report_path.read_text(encoding="utf-8"))
    assert not report["expectations_passed"] and report["actual_messages_sent"] == 0
    assert report["events"][0]["response"] is None
    assert list(report_path.parent.glob("*.tmp")) == []


@pytest.mark.parametrize("status,reason", [("skipped", "model_skip"), ("filtered", "invalid_format"), ("error", "timeout")])
def test_generated_replay_keeps_skip_filter_and_failure_separate(status, reason):
    records = []
    handler = SimpleNamespace(generate_result=lambda *_, **__: GenerationResult(status, raw_text="raw output", reason=reason),
                              record_sent_response=lambda *args: records.append(args))
    report = replay_events([{"at": 0, "speech": "오늘 어떤가"}], handler_factory=lambda _: handler,
                           elapsed_clock=lambda: 0)
    row = report["events"][0]
    assert row["status"] == row["generation_status"] == status
    assert row["generation_reason"] == reason and row["raw_text"] == "raw output"
    assert not records and report["actual_messages_sent"] == 0
    assert report["generation_errors"] == int(status == "error")
    assert report["expectations_passed"] is (status != "error")


def test_expired_request_retains_error_and_cannot_report_success():
    ticks = iter([0, 21])
    handler = SimpleNamespace(generate_result=lambda *_, **__: GenerationResult("error", reason="timeout"))
    report = replay_events([{"at": 0, "speech": "오늘 어떤가"}], handler_factory=lambda _: handler,
                           elapsed_clock=lambda: next(ticks))
    row = report["events"][0]
    assert row["status"] == "expired" and row["generation_status"] == "error"
    assert row["generation_reason"] == "timeout" and report["generation_errors"] == 1
    assert not report["expectations_passed"]


@pytest.mark.parametrize("max_age, first_latency, expected_timeouts", [
    (20, 19, [20, 1]),
    (60, 35, [30, 25]),
])
def test_generated_replay_request_budget_tracks_original_capture_age(max_age, first_latency, expected_timeouts):
    ticks = iter([0, first_latency, first_latency, first_latency])
    timeouts = []
    def generate(*args, **kwargs):
        timeouts.append(kwargs["timeout_seconds"])
        return GenerationResult("skipped", raw_text="[SKIP]", reason="model_skip")
    report = replay_events([
        {"at": 0, "speech": "첫 발화"}, {"at": 0, "speech": "처리를 기다린 발화"},
    ], handler_factory=lambda _: SimpleNamespace(generate_result=generate),
        elapsed_clock=lambda: next(ticks), max_age_seconds=max_age)
    assert timeouts == expected_timeouts
    assert [row["generation_status"] for row in report["events"]] == ["skipped", "skipped"]


@pytest.mark.parametrize("first_latency", [20, 21])
def test_generated_replay_never_requests_when_no_capture_budget_remains(first_latency):
    ticks = iter([0, first_latency])
    calls = []
    def generate(speech, *args, **kwargs):
        calls.append(speech)
        return GenerationResult("skipped", raw_text="[SKIP]", reason="model_skip")
    report = replay_events([
        {"at": 0, "speech": "첫 발화"}, {"at": 0, "speech": "늦어진 발화"},
    ], handler_factory=lambda _: SimpleNamespace(generate_result=generate),
        elapsed_clock=lambda: next(ticks), max_age_seconds=20)
    assert calls == ["첫 발화"]
    row = report["events"][1]
    assert row["status"] == "expired" and row["generation_status"] == "not_run"
    assert row["generation_reason"] == "expired_before_generation"


def test_prepared_replay_keeps_existing_deadline_boundary_without_model_request():
    report = replay_events([
        {"at": 0, "speech": "첫 발화", "draft": None, "delay": 20},
        {"at": 0, "speech": "같은 시점 발화", "draft": "쉬어도 되겠다"},
    ], max_age_seconds=20)
    assert [row["status"] for row in report["events"]] == ["skipped", "accepted"]
    assert report["source"] == "prepared_drafts" and report["actual_messages_sent"] == 0


def test_generated_replay_adapter_exception_is_error_without_secret_output():
    def fail(*args, **kwargs):
        raise RuntimeError("SECRET-URL")
    report = replay_events([{"at": 0, "speech": "오늘 어떤가"}],
                           handler_factory=lambda _: SimpleNamespace(generate_result=fail), elapsed_clock=lambda: 0)
    assert report["events"][0]["status"] == "error"
    assert report["events"][0]["generation_reason"] == "exception:RuntimeError"
    assert "SECRET-URL" not in json.dumps(report)


def test_generated_replay_model_error_exits_nonzero_with_saved_report(tmp_path, monkeypatch):
    import sys
    from config import Config
    class Model:
        def __init__(self, **_):
            pass
        def check_connection(self):
            return True
        def generate_result(self, *_, **__):
            return GenerationResult("error", reason="connection")
    monkeypatch.setattr(Config, "validate", lambda **_: True)
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(LLMHandler=Model))
    source = write_scenario(tmp_path, [{"at": 0, "speech": "오늘 어떤가"}])
    destination = tmp_path / "report.json"
    assert run_replay(source, generate=True, report_path=destination) == 1
    report = json.loads(destination.read_text(encoding="utf-8"))
    assert report["counts"]["error"] == 1 and report["generation_errors"] == 1
