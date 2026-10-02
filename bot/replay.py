"""Replay text observations through response rules; this module cannot send chat.

The default demo uses prepared drafts. --generate explicitly opts into Ollama.
Neither path loads audio, browsers, a chat client, or a persistent memory store.
"""

from collections import deque
import json
import math
import os
from pathlib import Path
import tempfile
import time

from core_logic import guard_chat_message, postprocess_llm_response
from response_pipeline import ResponseCandidate, ResponsePipeline, SpeechContext, SpeechObservation


DEMO_PATH = Path(__file__).resolve().parents[1] / "examples" / "bot-demo.json"
STATUSES = {"accepted", "expired", "cooldown", "skipped", "filtered"}


def load_scenario(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("리플레이 파일은 1 MiB 이하로 준비하세요.")
    data = json.loads(raw.decode("utf-8-sig"))
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1:
        raise ValueError("리플레이 version은 1이어야 합니다.")
    events = data.get("events")
    if not isinstance(events, list) or not 1 <= len(events) <= 1000:
        raise ValueError("events에는 1~1000개의 발화를 넣으세요.")
    last_at = -1
    allowed = {"at", "speech", "draft", "delay", "chat", "action", "edit", "expected"}
    for index, event in enumerate(events, 1):
        prefix = f"events[{index}]"
        if not isinstance(event, dict) or set(event) - allowed:
            raise ValueError(f"{prefix}: 지원하지 않는 항목이 있습니다.")
        for key in ("at", "delay"):
            value = event.get(key, 0)
            limit = 604800 if key == "at" else 300
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not 0 <= value <= limit:
                raise ValueError(f"{prefix}: {key} 값의 범위가 잘못되었습니다.")
        if "at" not in event or event["at"] < last_at:
            raise ValueError(f"{prefix}: at은 발생 순서대로 지정하세요.")
        last_at = event["at"]
        for key, limit in (("speech", 2000), ("draft", 1000), ("chat", 4000), ("edit", 1000)):
            value = event.get(key, "")
            if key == "draft" and value is None:
                continue
            if not isinstance(value, str) or len(value) > limit:
                raise ValueError(f"{prefix}: {key}는 {limit}자 이하의 문자열이어야 합니다.")
        if not event.get("speech", "").strip():
            raise ValueError(f"{prefix}: speech가 비어 있습니다.")
        action = event.get("action", "send")
        if action not in ("send", "skip", "edit"):
            raise ValueError(f"{prefix}: action은 send, skip, edit 중 하나입니다.")
        if action == "edit" and not event.get("edit", "").strip():
            raise ValueError(f"{prefix}: 수정할 edit 문장이 필요합니다.")
        if "expected" in event and (not isinstance(event["expected"], str) or event["expected"] not in STATUSES):
            raise ValueError(f"{prefix}: expected 결과가 올바르지 않습니다.")
    return events


class _PreparedResponses:
    """Same pure text guards and 60-second repetition window, no model imports."""

    def __init__(self, clock):
        self._clock = clock
        self._sent = deque(maxlen=10)

    def validate_response(self, text):
        if not isinstance(text, str) or "[SKIP]" in text.upper():
            return None
        recent = [text for at, text in self._sent if self._clock() - at < 60]
        return guard_chat_message(text, recent_messages=recent)

    def record_sent_response(self, speech, text):
        self._sent.append((self._clock(), text))


def replay_events(events, *, handler_factory=None, max_age_seconds=20, cooldown_seconds=10,
                  context_age_seconds=45, elapsed_clock=time.monotonic):
    """Return a reviewable report. 'accepted' means simulated, never transmitted.

    Source times are relative seconds; serial inference delay carries into later
    events. Explicit delay simulates inference/approval waits without sleeping.
    Actual model latency is added only when a handler factory is supplied.
    """
    now = [0.0]
    clock = lambda: now[0]
    pipeline = ResponsePipeline(mode="ai", max_age_seconds=max_age_seconds,
                                cooldown_seconds=cooldown_seconds, clock=clock)
    context = SpeechContext(max_age_seconds=context_age_seconds, clock=clock)
    handler = handler_factory(clock) if handler_factory is not None else None
    responder = handler or _PreparedResponses(clock)
    rows = []
    for index, event in enumerate(events, 1):
        now[0] = max(now[0], float(event["at"]))
        observation = SpeechObservation(event["speech"], float(event["at"]), 0)
        context.observe(observation)
        prior = context.recent(observation)
        candidate = ResponseCandidate(observation.text, "", event.get("chat", ""), observation.observed_at, 0)
        row = {"index": index, "at": event["at"], "speech": observation.text,
               "prior_speech": list(prior), "response": None, "latency_seconds": 0.0}
        if not pipeline.is_current(candidate):
            status = "expired"
        elif not pipeline.can_send(candidate):
            status = "cooldown"
        else:
            started = elapsed_clock()
            draft = (handler.generate_response(observation.text, event.get("chat", ""), speech_context=prior)
                     if handler is not None else event.get("draft"))
            latency = max(0.0, elapsed_clock() - started) if handler is not None else 0.0
            now[0] += latency + event.get("delay", 0)
            row["latency_seconds"] = round(latency, 3)
            response = postprocess_llm_response(draft)
            if not pipeline.is_current(candidate):
                status = "expired"
            elif event.get("action") == "skip" or response is None:
                status = "skipped"
            else:
                response = responder.validate_response(event.get("edit") if event.get("action") == "edit" else response)
                if response is None:
                    status = "filtered"
                else:
                    status = "accepted"
                    row["response"] = response
                    pipeline.record_sent(candidate)
                    responder.record_sent_response(observation.text, response)
        row["status"] = status
        # Prepared-draft expectations do not grade unpredictable model output.
        if handler is None and "expected" in event:
            row["expected"] = event["expected"]
            row["matches_expected"] = status == event["expected"]
        rows.append(row)
    pipeline.close()
    counts = {status: sum(row["status"] == status for row in rows) for status in sorted(STATUSES)}
    return {"version": 1, "source": "ollama" if handler is not None else "prepared_drafts",
            "actual_messages_sent": 0, "counts": counts, "events": rows,
            "expectations_passed": all(row.get("matches_expected", True) for row in rows),
            "note": "반응 규칙과 전달 문맥을 확인하는 리플레이입니다. 자연스러움·사실성은 사람이 별도로 평가하세요."}


def _write_report(path, report):
    path = Path(path)
    if path.suffix.lower() != ".json":
        raise ValueError("보고서 경로는 .json으로 지정하세요.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def run_replay(path=None, *, generate=False, report_path=None):
    try:
        source = Path(path) if path is not None else DEMO_PATH
        if report_path and Path(report_path).suffix.lower() != ".json":
            raise ValueError("보고서 경로는 .json으로 지정하세요.")
        if report_path and Path(report_path).resolve() == source.resolve():
            raise ValueError("보고서는 입력 파일과 다른 경로에 저장하세요.")
        events = load_scenario(source)
        factory = None
        options = {}
        if generate:
            from config import Config
            from llm_handler import LLMHandler
            Config.validate(require_channel=False)
            def factory(clock):
                handler = LLMHandler(clock=clock)
                if not handler.check_connection():
                    raise ValueError("Ollama 연결/모델을 확인하세요: python main.py --doctor")
                return handler
            options = {"max_age_seconds": Config.RESPONSE_MAX_AGE_SECONDS,
                       "cooldown_seconds": Config.RESPONSE_COOLDOWN,
                       "context_age_seconds": Config.SPEECH_CONTEXT_MAX_AGE_SECONDS}
        report = replay_events(events, handler_factory=factory, **options)
        print("\n문장 리플레이 - 실제 채팅 전송 없음")
        print("Ollama로 답변을 생성합니다." if generate else "준비된 예시 답변으로 동작을 확인합니다 (AI 품질 평가 아님).")
        labels = {"accepted": "전송 가능", "expired": "만료", "cooldown": "간격 대기", "skipped": "생략", "filtered": "응답 필터"}
        for row in report["events"]:
            print(f"  {row['index']:02d}. [{labels[row['status']]}] {row['speech']}")
            if row["response"]:
                print(f"      → {row['response']}")
        if report_path:
            _write_report(report_path, report)
            print(f"보고서: {Path(report_path).resolve()}")
        print(report["note"])
        return 0 if report["expectations_passed"] else 1
    except (OSError, ValueError, ImportError) as error:
        print(f"리플레이를 실행하지 못했습니다: {error}")
        return 2
