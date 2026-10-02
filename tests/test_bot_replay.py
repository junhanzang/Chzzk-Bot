import json
from types import SimpleNamespace

import pytest

from bot.replay import DEMO_PATH, load_scenario, replay_events, run_replay


def write_scenario(tmp_path, events):
    path = tmp_path / "scenario.json"
    path.write_text(json.dumps({"version": 1, "events": events}, ensure_ascii=False), encoding="utf-8")
    return path


def test_demo_covers_context_approval_edit_cooldown_duplicates_and_expiry():
    report = replay_events(load_scenario(DEMO_PATH))
    assert report["expectations_passed"]
    assert report["actual_messages_sent"] == 0
    assert report["events"][1]["prior_speech"] == ["첫 번째 상자는 이미 열었어"]
    assert report["counts"] == {"accepted": 2, "cooldown": 1, "expired": 1, "filtered": 1, "skipped": 2}
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
        generate_response=lambda speech, chat, **kw: calls.append(speech) or "수고했네",
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
