import copy
import json
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace

import pytest

from bot.evaluation import collect_model_metadata, evaluate_cases, load_suite, run_evaluation
from bot.reports import write_report


def case(**changes):
    return {"id": "short-question", "title": "짧은 질문", "category": "question", "speech": "쉴까?",
            "prior_speech": ["두 시간째 같은 게임 중이야"], "chat": "잠깐 쉬자",
            "sent_history": [], "expected_action": "respond", "review_rubric": ["앞말을 이해했는가"],
            **changes}


def suite(*cases):
    return {"version": 1, "title": "시험 상황", "cases": list(cases) or [case()]}


def save_suite(tmp_path, value=None):
    path = tmp_path / "suite.json"
    path.write_text(json.dumps(value or suite(), ensure_ascii=False), encoding="utf-8")
    return path


def result(status="generated", response="잠깐 쉬어도 되겠네", **changes):
    return SimpleNamespace(status=status, response=response if status == "generated" else None,
                           raw_text=response if status == "generated" else "[SKIP]",
                           reason="generated" if status == "generated" else status,
                           latency_seconds=0.2, **changes)


def test_evaluation_import_does_not_load_live_services_or_model_packages():
    script = ("import sys; import bot.evaluation; "
              "assert not any(m in sys.modules for m in "
              "['llm_handler','requests','torch','numpy','soundcard','chzzkpy','config','bot.runtime','chat_sender'])")
    process = subprocess.run([sys.executable, "-S", "-c", script], capture_output=True,
                             cwd=Path(__file__).resolve().parents[1])
    assert process.returncode == 0, process.stderr


@pytest.mark.parametrize("change", [
    {"id": "bad id"}, {"id": None}, {"speech": ""}, {"chat": []}, {"expected_action": []},
    {"expected_action": "sent"}, {"prior_speech": "이전"}, {"prior_speech": ["가"] * 6},
    {"prior_speech": [""]}, {"review_rubric": []}, {"review_rubric": [1]}, {"unexpected": True},
    {"sent_history": [{"speech": "", "response": "응응", "age_seconds": True}]},
    {"sent_history": [{"speech": "", "response": "응응", "age_seconds": float("nan")}]},
    {"sent_history": [{"speech": "", "response": "응응", "age_seconds": -1}]},
    {"sent_history": [{"speech": "", "response": "응응", "age_seconds": 4000}]},
    {"sent_history": [{"speech": "", "response": "", "age_seconds": 1}]},
    {"sent_history": [{"speech": "", "response": "응응", "age_seconds": 1},
                      {"speech": "", "response": "오호", "age_seconds": 2}]},
])
def test_invalid_case_is_rejected_before_model_access(tmp_path, change):
    with pytest.raises(ValueError):
        load_suite(save_suite(tmp_path, suite(case(**change))))


@pytest.mark.parametrize("value", [suite(), {"version": True, "title": "a", "cases": [case()]},
                                   suite(case(), case()), suite(*[case(id=f"c{i}") for i in range(101)])])
def test_suite_structure_and_unique_ids(tmp_path, value):
    if value == suite():
        value = {**value, "cases": []}
    with pytest.raises(ValueError):
        load_suite(save_suite(tmp_path, value))


def test_suite_size_is_bounded(tmp_path):
    path = tmp_path / "large.json"
    path.write_bytes(b" " * (1024 * 1024 + 1))
    with pytest.raises(ValueError):
        load_suite(path)


def test_context_and_success_history_are_isolated_per_case_and_never_include_rubrics():
    handlers, seen = [], []
    class Handler:
        def __init__(self, clock):
            self.clock, self.history = clock, []
        def record_sent_response(self, speech, response):
            self.history.append((speech, response, self.clock()))
        def generate_result(self, speech, chat, *, speech_context):
            seen.append((speech, chat, speech_context, copy.deepcopy(self.history), self.clock()))
            return result()
    def factory(clock):
        handler = Handler(clock)
        handlers.append(handler)
        return handler
    history = [{"speech": "앞 얘기", "response": "수고했어", "age_seconds": 25}]
    first = case(sent_history=history)
    second = case(id="fresh", speech="다른 이야기", prior_speech=[], chat="")
    report = evaluate_cases(suite(first, second), handler_factory=factory, output=lambda _: None)
    assert len(handlers) == 2
    assert seen == [("쉴까?", "잠깐 쉬자", ("두 시간째 같은 게임 중이야",), [("앞 얘기", "수고했어", 3575)], 3600),
                    ("다른 이야기", "", (), [], 3600)]
    assert handlers[0].history == [("앞 얘기", "수고했어", 3575)], "Draft output must not become sent history"
    assert report["actual_messages_sent"] == 0 and report["expectations_passed"]
    assert report["cases"][0]["review_rubric"] == first["review_rubric"]
    assert report["actual_model_measured"] and report["evaluated_count"] == 2


@pytest.mark.parametrize("status,expected,matched", [
    ("generated", "respond", True), ("generated", "skip", False), ("generated", "either", True),
    ("skipped", "skip", True), ("skipped", "respond", False), ("skipped", "either", True),
    ("filtered", "skip", False), ("filtered", "either", False), ("error", "skip", False),
    ("error", "either", False),
])
def test_response_choice_is_distinct_from_filtered_or_broken_model(status, expected, matched):
    handler = SimpleNamespace(generate_result=lambda *_, **__: result(status))
    report = evaluate_cases(suite(case(expected_action=expected)), handler_factory=lambda _: handler,
                            output=lambda _: None)
    assert report["cases"][0]["matches_expected"] is matched
    assert report["expectations_passed"] is matched
    assert report["counts"][status] == 1


def test_runtime_errors_are_failures_and_do_not_leak_exception_contents():
    def failure(*args, **kwargs):
        raise RuntimeError("SECRET-CREDENTIAL")
    report = evaluate_cases(suite(case(expected_action="skip")), handler_factory=failure, output=lambda _: None)
    assert report["cases"][0]["reason"] == "exception:RuntimeError"
    assert report["counts"]["error"] == 1 and not report["expectations_passed"]
    assert "SECRET-CREDENTIAL" not in json.dumps(report)
    assert not report["actual_model_measured"] and report["evaluated_count"] == 0
    assert report["action_match_rate"] is None


@pytest.mark.parametrize("change", [{"latency_seconds": float("nan")}, {"status": "unknown"},
                                    {"raw_text": None}, {"response": ""}, {"reason": None}])
def test_malformed_model_result_is_not_scored_as_success(change):
    malformed = result()
    for key, value in change.items():
        setattr(malformed, key, value)
    report = evaluate_cases(suite(), handler_factory=lambda _: SimpleNamespace(generate_result=lambda *_, **__: malformed),
                            output=lambda _: None)
    assert report["cases"][0]["status"] == "error"
    assert not report["expectations_passed"]


def test_interrupt_preserves_partial_report_without_fake_skips(tmp_path):
    calls = []
    def generate(*args, **kwargs):
        calls.append(True)
        if len(calls) == 2:
            raise KeyboardInterrupt
        return result()
    path = tmp_path / "progress.json"
    report = evaluate_cases(suite(case(), case(id="two"), case(id="three")),
                            handler_factory=lambda _: SimpleNamespace(generate_result=generate),
                            checkpoint=lambda current: write_report(path, current), output=lambda _: None)
    assert report["interrupted"] and not report["completed"]
    assert report["completed_cases"] == 1 and report["not_run_cases"] == 2
    assert report["counts"]["skipped"] == 0 and not report["expectations_passed"]
    assert json.loads(path.read_text(encoding="utf-8")) == report
    assert not list(tmp_path.glob("*.tmp"))


def test_metadata_records_exact_prompt_options_version_and_digest():
    handler = SimpleNamespace(model_name="test-model", host="http://localhost:11434", system_prompt="시험 지침",
                              generation_options={"seed": 0, "temperature": 0.9})
    def fetch(url):
        return {"version": "1.2.3"} if url.endswith("/version") else {"models": [
            {"name": "test-model:other", "digest": "wrong"}, {"name": "test-model:latest", "digest": "correct"}]}
    metadata = collect_model_metadata(handler, fetch_json=fetch)
    assert metadata["ollama_version"] == "1.2.3" and metadata["model_digest"] == "correct"
    assert metadata["generation_options"] == handler.generation_options
    assert len(metadata["system_prompt_sha256"]) == 64
    assert metadata["metadata_warnings"] == [] and "host" not in metadata


def test_missing_metadata_is_marked_unknown_without_hiding_measurement():
    def fail(_):
        raise ValueError("SECRET")
    handler = SimpleNamespace(model_name="test", host="http://localhost:11434", system_prompt="prompt", generation_options={})
    metadata = collect_model_metadata(handler, fetch_json=fail)
    assert metadata["ollama_version"] is None and metadata["model_digest"] is None
    assert metadata["metadata_warnings"] == ["version_unavailable", "tags_unavailable"]
    assert "SECRET" not in json.dumps(metadata)


def test_invalid_destination_and_source_overwrite_rejected_before_model_import(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "llm_handler", None)
    path = save_suite(tmp_path)
    original = path.read_bytes()
    assert run_evaluation(path, report_path=path) == 2
    assert run_evaluation(path, report_path=tmp_path / "out.txt") == 2
    assert path.read_bytes() == original


def test_unavailable_model_saves_unmeasured_report_without_generation(tmp_path, monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(LLMHandler=lambda **_: SimpleNamespace(check_connection=lambda: False)))
    from config import Config
    monkeypatch.setattr(Config, "validate", lambda **_: True)
    path = tmp_path / "report.json"
    assert run_evaluation(save_suite(tmp_path), report_path=path) == 2
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["evaluation_status"] == "unavailable"
    assert report["evaluated_count"] == 0 and not report["actual_model_measured"]
    assert report["action_match_rate"] is None and not report["expectations_passed"]
    assert report["actual_messages_sent"] == 0 and report["cases"] == []
    assert "미측정" in capsys.readouterr().out


def test_missing_model_client_is_not_mistaken_for_intentional_skip(tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "llm_handler", None)
    from config import Config
    monkeypatch.setattr(Config, "validate", lambda **_: True)
    path = tmp_path / "report.json"
    assert run_evaluation(save_suite(tmp_path), report_path=path) == 2
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["reason"] == "model_client_unavailable" and report["counts"]["skipped"] == 0


def test_atomic_report_failure_preserves_previous_result(tmp_path, monkeypatch):
    path = tmp_path / "report.json"
    write_report(path, {"old": True})
    monkeypatch.setattr("bot.reports.os.replace", lambda *_: (_ for _ in ()).throw(OSError("disk full")))
    with pytest.raises(OSError):
        write_report(path, {"new": True})
    assert json.loads(path.read_text()) == {"old": True}
    assert not list(tmp_path.glob("*.tmp"))


def test_complete_evaluation_entry_point_checkpoints_real_results_and_metadata(tmp_path, monkeypatch):
    calls = []
    class Model:
        def __init__(self, **kwargs):
            calls.append(kwargs)
        def check_connection(self):
            return True
        def generate_result(self, speech, chat, **kwargs):
            return result()
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(LLMHandler=Model))
    monkeypatch.setattr("bot.evaluation.collect_model_metadata", lambda _: {"model": "fake:model", "system_prompt_sha256": "abc"})
    from config import Config
    monkeypatch.setattr(Config, "validate", lambda **_: True)
    path = tmp_path / "report.json"
    assert run_evaluation(save_suite(tmp_path), report_path=path, model_name="fake:model") == 0
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["evaluation_status"] == "completed" and report["expectations_passed"]
    assert report["metadata"]["model"] == "fake:model" and len(report["metadata"]["suite_sha256"]) == 64
    assert all(call["seed"] == 0 and call["model_name"] == "fake:model" for call in calls)
    assert len(calls) == 2, "Connection probe and independent case handlers are separate"


def test_interruption_during_prepare_records_no_measurements(tmp_path, monkeypatch):
    def interrupt():
        raise KeyboardInterrupt
    monkeypatch.setitem(sys.modules, "llm_handler", SimpleNamespace(LLMHandler=lambda **_: SimpleNamespace(check_connection=interrupt)))
    from config import Config
    monkeypatch.setattr(Config, "validate", lambda **_: True)
    path = tmp_path / "report.json"
    assert run_evaluation(save_suite(tmp_path), report_path=path) == 130
    report = json.loads(path.read_text(encoding="utf-8"))
    assert report["evaluation_status"] == "interrupted" and report["interrupted"]
    assert not report["actual_model_measured"] and report["evaluated_count"] == 0
