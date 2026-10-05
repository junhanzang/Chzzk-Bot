"""Independent text-only model cases; never imports audio or chat transports.

Expected actions measure response/abstention only. Naturalness and factual
grounding require human review using each case's rubric and raw model output.
"""

from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import sys
from urllib.request import Request, urlopen

from bot.reports import write_report


SUITE_PATH = Path(__file__).resolve().parents[1] / "examples" / "bot-quality.json"
DEFAULT_REPORT_PATH = Path("outputs") / "bot-quality-report.json"
STATUSES = ("generated", "skipped", "filtered", "error")
NOTE = ("응답/생략 선택만 자동 비교합니다. 자연스러움·사실성·끼어들 타이밍은 "
        "각 상황의 review_rubric으로 별도 검토하세요. 실제 채팅은 전송하지 않았습니다.")


def _text(value, name, limit, *, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f"{name}: {limit}자 이하의 {'문자열' if empty else '비어 있지 않은 문자열'}이 필요합니다.")


def load_suite(path):
    """Load and validate a bounded suite before any model access."""
    with Path(path).open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("평가 파일은 1 MiB 이하로 준비하세요.")
    data = json.loads(raw.decode("utf-8-sig"))
    if (not isinstance(data, dict) or set(data) != {"version", "title", "cases"}
            or type(data.get("version")) is not int or data["version"] != 1):
        raise ValueError("평가 파일에는 version: 1, title, cases가 필요합니다.")
    _text(data["title"], "title", 200)
    cases = data["cases"]
    if not isinstance(cases, list) or not 1 <= len(cases) <= 100:
        raise ValueError("cases에는 1~100개의 독립 상황을 넣으세요.")
    keys = {"id", "title", "category", "speech", "prior_speech", "chat",
            "sent_history", "expected_action", "review_rubric"}
    ids = set()
    for index, case in enumerate(cases, 1):
        prefix = f"cases[{index}]"
        if not isinstance(case, dict) or set(case) != keys:
            raise ValueError(f"{prefix}: 필수 항목이 없거나 지원하지 않는 항목이 있습니다.")
        for key, limit in (("id", 80), ("title", 200), ("category", 80), ("speech", 2000), ("chat", 4000)):
            _text(case[key], f"{prefix}.{key}", limit, empty=key == "chat")
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", case["id"]) or case["id"] in ids:
            raise ValueError(f"{prefix}.id: 영문·숫자·밑줄·하이픈으로 고유한 ID를 지정하세요.")
        ids.add(case["id"])
        if not isinstance(case["expected_action"], str) or case["expected_action"] not in ("respond", "skip", "either"):
            raise ValueError(f"{prefix}.expected_action: respond, skip, either 중 하나입니다.")
        for key, count, limit in (("prior_speech", 5, 300), ("review_rubric", 10, 500)):
            values = case[key]
            if not isinstance(values, list) or len(values) > count or (key == "review_rubric" and not values):
                raise ValueError(f"{prefix}.{key}: {'1~' if key == 'review_rubric' else '0~'}{count}개의 문자열을 넣으세요.")
            for value in values:
                _text(value, f"{prefix}.{key}", limit)
        history = case["sent_history"]
        if not isinstance(history, list) or len(history) > 10:
            raise ValueError(f"{prefix}.sent_history: 이전 전송은 최대 10개입니다.")
        previous_age = math.inf
        for item in history:
            if not isinstance(item, dict) or set(item) != {"speech", "response", "age_seconds"}:
                raise ValueError(f"{prefix}.sent_history: speech, response, age_seconds가 필요합니다.")
            _text(item["speech"], f"{prefix}.sent_history.speech", 2000, empty=True)
            _text(item["response"], f"{prefix}.sent_history.response", 100)
            age = item["age_seconds"]
            if (isinstance(age, bool) or not isinstance(age, (int, float)) or not math.isfinite(age)
                    or not 0 <= age <= 3600 or age > previous_age):
                raise ValueError(f"{prefix}.sent_history: age_seconds는 0~3600, 오래된 전송부터 지정하세요.")
            previous_age = age
    return data


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _refresh_summary(report):
    rows = report["cases"]
    matched = sum(row["matches_expected"] for row in rows)
    report["counts"] = {status: sum(row["status"] == status for row in rows) for status in STATUSES}
    report["completed_cases"] = len(rows)
    report["not_run_cases"] = report["total_cases"] - len(rows)
    report["action_matches"] = matched
    report["evaluated_count"] = sum(row["status"] != "error" for row in rows)
    report["actual_model_measured"] = report["evaluated_count"] > 0
    report["action_match_rate"] = (round(matched / report["total_cases"], 4)
                                   if report["actual_model_measured"] else None)
    report["expectations_passed"] = report["completed"] and matched == report["total_cases"]


def _new_report(suite, metadata):
    report = {"version": 1, "type": "quality_evaluation", "title": suite["title"],
              "source": "ollama", "actual_messages_sent": 0,
              "started_at": datetime.now(timezone.utc).isoformat(),
              "metadata": dict(metadata or {}), "total_cases": len(suite["cases"]),
              "evaluation_status": "running", "completed": False, "interrupted": False,
              "cases": [], "note": NOTE}
    _refresh_summary(report)
    return report


def evaluate_cases(suite, *, handler_factory, metadata=None, checkpoint=None, output=print):
    """Run independent cases, preserving partial progress on Ctrl+C.

    handler_factory(clock) must return a fresh LLM handler for each case. Only
    explicitly supplied fixture history is seeded; generated drafts never become
    sent history, and expectations/rubrics are never passed into the model.
    """
    report = _new_report(suite, metadata)
    if checkpoint:
        checkpoint(report)
    try:
        for index, case in enumerate(suite["cases"], 1):
            row = {**case, "index": index, "response": None, "raw_text": "",
                   "latency_seconds": 0.0, "status": "error", "reason": "", "matches_expected": False}
            try:
                now = [3600.0]
                handler = handler_factory(lambda: now[0])
                for previous in case["sent_history"]:
                    now[0] = 3600.0 - previous["age_seconds"]
                    handler.record_sent_response(previous["speech"], previous["response"])
                now[0] = 3600.0
                result = handler.generate_result(case["speech"], case["chat"],
                                                 speech_context=tuple(case["prior_speech"]))
                if (result.status not in STATUSES or not isinstance(result.raw_text, str)
                        or not isinstance(result.reason, str)
                        or isinstance(result.latency_seconds, bool)
                        or not isinstance(result.latency_seconds, (int, float))
                        or not math.isfinite(result.latency_seconds) or result.latency_seconds < 0
                        or (result.status == "generated" and (not isinstance(result.response, str) or not result.response.strip()))
                        or (result.status != "generated" and result.response is not None)):
                    raise ValueError("invalid_generation_result")
                row.update(status=result.status, response=result.response, raw_text=result.raw_text,
                           reason=result.reason, latency_seconds=round(result.latency_seconds, 3))
            except Exception as error:
                # Exceptions may include URLs/tokens. Record only their class.
                row["reason"] = f"exception:{type(error).__name__}"
            action = {"generated": "respond", "skipped": "skip"}.get(row["status"])
            row["actual_action"] = action
            row["matches_expected"] = action is not None and case["expected_action"] in (action, "either")
            report["cases"].append(row)
            _refresh_summary(report)
            if checkpoint:
                checkpoint(report)
            output(f"  {index:02d}/{report['total_cases']} [{row['status']}] {case['title']} "
                   f"({row['latency_seconds']:.2f}s) {'선택 일치' if row['matches_expected'] else '검토 필요'}")
            if row["response"]:
                output(f"      → {row['response']}")
    except KeyboardInterrupt:
        report["interrupted"] = True
    report["completed"] = not report["interrupted"] and len(report["cases"]) == report["total_cases"]
    report["evaluation_status"] = "interrupted" if report["interrupted"] else "completed"
    report["finished_at"] = datetime.now(timezone.utc).isoformat()
    _refresh_summary(report)
    if checkpoint:
        checkpoint(report)
    return report


def _get_json(url):
    with urlopen(Request(url, headers={"Accept": "application/json"}), timeout=3) as response:
        raw = response.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("metadata_too_large")
    result = json.loads(raw)
    if not isinstance(result, dict):
        raise ValueError("invalid_metadata")
    return result


def collect_model_metadata(handler, *, fetch_json=None):
    """Best-effort version/digest metadata, never including service credentials."""
    from config import Config
    from bot.diagnostics import model_is_available
    fetch_json = fetch_json or _get_json
    metadata = {"model": handler.model_name, "ollama_version": None, "model_digest": None,
                "system_prompt_sha256": _sha(handler.system_prompt),
                "seed": 0, "think": False, "keep_alive": Config.OLLAMA_KEEP_ALIVE,
                "generation_options": dict(handler.generation_options),
                "metadata_warnings": []}
    for endpoint in ("version", "tags"):
        try:
            payload = fetch_json(handler.host.rstrip("/") + "/api/" + endpoint)
            if endpoint == "version":
                version = payload.get("version")
                if not isinstance(version, str) or not version.strip():
                    raise ValueError("version_missing")
                metadata["ollama_version"] = version[:200]
            else:
                models = payload.get("models")
                if not isinstance(models, list):
                    raise ValueError("models_missing")
                model = next((item for item in models if model_is_available(handler.model_name, [item])), None)
                digest = model.get("digest") if model else None
                if not isinstance(digest, str) or not digest.strip():
                    raise ValueError("digest_missing")
                metadata["model_digest"] = digest[:200]
        except Exception:
            metadata["metadata_warnings"].append(f"{endpoint}_unavailable")
    return metadata


def run_evaluation(path=None, *, report_path=None, model_name=None):
    """Explicit model execution entry point; output is checkpointed after each case."""
    initial_report = None
    try:
        source = Path(path) if path is not None else SUITE_PATH
        destination = Path(report_path) if report_path is not None else DEFAULT_REPORT_PATH
        if destination.suffix.lower() != ".json":
            raise ValueError("보고서 경로는 .json으로 지정하세요.")
        if source.resolve() == destination.resolve():
            raise ValueError("보고서는 입력 파일과 다른 경로에 저장하세요.")
        suite = load_suite(source)
        from config import Config
        Config.validate(require_channel=False)
        initial_metadata = {"model": model_name or Config.OLLAMA_MODEL,
                            "suite_sha256": _sha(json.dumps(suite, ensure_ascii=False, sort_keys=True))}
        initial_report = _new_report(suite, initial_metadata)
        # Check the report destination before doing potentially costly inference.
        write_report(destination, initial_report)
        try:
            from llm_handler import LLMHandler
        except ImportError:
            initial_report.update(evaluation_status="unavailable", reason="model_client_unavailable",
                                  finished_at=datetime.now(timezone.utc).isoformat())
            write_report(destination, initial_report)
            print("평가 미측정: 모델 연결 패키지가 없습니다. 채팅 전송 및 모델 자동 설치는 하지 않았습니다.")
            print(f"보고서: {destination.resolve()}")
            return 2
        def factory(clock):
            return LLMHandler(model_name=model_name, clock=clock, seed=0)
        probe = factory(lambda: 3600.0)
        if not probe.check_connection():
            initial_report.update(evaluation_status="unavailable", reason="model_unavailable",
                                  finished_at=datetime.now(timezone.utc).isoformat())
            write_report(destination, initial_report)
            print("평가 미측정: 설정한 Ollama 서버 또는 모델을 사용할 수 없습니다 (평가 0개).")
            print("모델을 준비한 뒤 다시 실행하세요. 모델 자동 설치·다운로드·채팅 전송은 하지 않았습니다.")
            print(f"보고서: {destination.resolve()}")
            return 2
        metadata = collect_model_metadata(probe)
        metadata.update(initial_metadata)
        print(f"\n실제 모델 품질 평가: {metadata['model']} / {len(suite['cases'])}개 독립 상황")
        print("음성·로그인·채팅 전송 없이 문장만 평가합니다. Ctrl+C로 중단해도 완료된 결과를 저장합니다.")
        report = evaluate_cases(suite, handler_factory=factory, metadata=metadata,
                                checkpoint=lambda current: write_report(destination, current))
        print(f"보고서: {destination.resolve()}")
        print(f"응답/생략 선택 일치: {report['action_matches']}/{report['total_cases']} "
              f"(오류 {report['counts']['error']}, 미실행 {report['not_run_cases']})")
        print(NOTE)
        if report["interrupted"]:
            return 130
        return 0 if report["expectations_passed"] else 1
    except KeyboardInterrupt:
        if initial_report is not None:
            initial_report.update(evaluation_status="interrupted", interrupted=True,
                                  finished_at=datetime.now(timezone.utc).isoformat())
            try:
                write_report(destination, initial_report)
            except OSError:
                print("중단 상태를 저장하지 못했습니다. 이전 보고서를 확인하세요.", file=sys.stderr)
        print("평가 준비를 중단했습니다. 모델 결과는 생성되지 않았습니다.")
        return 130
    except (OSError, ValueError, ImportError) as error:
        print(f"평가를 실행하지 못했습니다: {error}", file=sys.stderr)
        return 2
