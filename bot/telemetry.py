"""Thread-safe session counters, without retaining chat text or credentials."""

from collections import Counter
import re
import threading


class SessionMetrics:
    LABELS = {
        "observed": "인식", "proposed": "제안", "sent": "전송",
        "skipped": "생략", "fresh_expired": "만료", "cooldown": "간격 대기",
        "invalid_response": "응답 필터", "generation_failed": "생성 생략/실패",
        "send_failed": "전송 실패", "asr_error": "음성 오류",
        "llm_error": "AI 오류", "mimic_error": "반응 오류",
        "response_error": "처리 오류",
    }

    def __init__(self):
        self._counts = Counter()
        self._lock = threading.Lock()

    def increment(self, name, amount=1):
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,47}", name):
            raise ValueError("Metric names must be short identifiers, not message text")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount < 0:
            raise ValueError("Metric increments must be non-negative integers")
        with self._lock:
            self._counts[name] += amount

    def snapshot(self):
        with self._lock:
            return dict(self._counts)

    def summary(self):
        counts = self.snapshot()
        return " · ".join(f"{self.LABELS.get(name, name)} {value}" for name, value in counts.items()) or "아직 처리한 반응 없음"
