import json
import os
import tempfile
import threading
from datetime import datetime


def validate_fact_texts(values, max_facts=5):
    """Validate the entire reply before selecting bounded, non-empty facts."""
    if not isinstance(values, list) or len(values) > 100:
        raise ValueError("Memory facts must be a bounded string array")
    if any(not isinstance(value, str) or not value.strip() or len(value) > 200 for value in values):
        raise ValueError("Memory facts must contain non-empty strings of at most 200 characters")
    return list(dict.fromkeys(value.strip() for value in values))[:max_facts]


class MemoryStore:
    """JSON 파일 기반 메모리 저장소"""

    def __init__(self, file_path, max_facts=5):
        if isinstance(max_facts, bool) or not isinstance(max_facts, int) or not 1 <= max_facts <= 100:
            raise ValueError("max_facts must be between 1 and 100")
        self.file_path = file_path
        self.max_facts = max_facts
        self._lock = threading.RLock()
        self.data = self._load()

    def _load(self):
        """JSON 파일에서 메모리 로드"""
        if os.path.exists(self.file_path):
            try:
                with open(self.file_path, 'r', encoding='utf-8') as f:
                    text = f.read(65537)
                    if len(text) > 65536:
                        raise ValueError("Memory file is too large")
                    data = json.loads(text)
                if not isinstance(data, dict) or not isinstance(data.get("facts"), list):
                    raise ValueError("Invalid memory document")
                facts = data["facts"]
                if any(not isinstance(fact, dict) for fact in facts):
                    raise ValueError("Invalid memory fact")
                texts = validate_fact_texts([fact.get("text") for fact in facts], self.max_facts)
                by_text = {fact["text"].strip(): fact for fact in reversed(facts)}
                return {"version": 1, "updated_at": data.get("updated_at"),
                        "facts": [{**by_text[value],
                                   "id": index + 1, "text": value} for index, value in enumerate(texts)]}
            except (ValueError, IOError):
                pass
        return {"version": 1, "updated_at": None, "facts": []}

    def _write(self, data):
        """Publish a complete file beside the old one; never truncate the old file."""
        target = os.path.abspath(self.file_path)
        directory = os.path.dirname(target)
        os.makedirs(directory, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory,
                                             prefix=f".{os.path.basename(target)}.", suffix=".tmp", delete=False) as handle:
                temporary = handle.name
                json.dump(data, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)

    def save(self):
        """JSON 파일에 메모리 저장 (쓰기 실패 시 기존 데이터 유지)"""
        with self._lock:
            updated = {**self.data, "updated_at": datetime.now().isoformat()}
            self._write(updated)
            self.data = updated

    def get_facts(self):
        """모든 fact 텍스트 리스트 반환"""
        with self._lock:
            return [f["text"] for f in self.data["facts"]]

    def get_facts_as_prompt(self):
        """프롬프트에 삽입할 형식으로 반환"""
        facts = self.get_facts()
        if not facts:
            return ""
        return "\n".join(f"- {fact}" for fact in facts)

    def replace_all_facts(self, new_facts_texts):
        """전체 fact 목록을 교체"""
        texts = validate_fact_texts(new_facts_texts, self.max_facts)
        now = datetime.now().isoformat()
        updated = {"version": 1, "updated_at": now, "facts": [
            {"id": i + 1, "text": text, "created_at": now, "updated_at": now}
            for i, text in enumerate(texts)
        ]}
        with self._lock:
            self._write(updated)
            self.data = updated

    def is_empty(self):
        with self._lock:
            return len(self.data["facts"]) == 0
