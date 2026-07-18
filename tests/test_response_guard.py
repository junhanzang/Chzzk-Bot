import pytest

from core_logic import (
    CHZZK_CHAT_MAX_LENGTH,
    clean_chat_message,
    contains_banned_word,
    guard_chat_message,
    is_repetitive_message,
    parse_banned_words,
)


# ---------------------------------------------------------------------------
# 순수 함수 (core_logic)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("raw, expected", [
    ("바보,멍청이", ("바보", "멍청이")),
    (" 바보 , 멍청이 \n 바보 ", ("바보", "멍청이")),  # 공백 제거 + 중복 제거
    ("Spam,spam", ("Spam",)),  # 대소문자 무시 중복 제거
    ("", ()), (None, ()), (" , ,\n", ()),
])
def test_parse_banned_words(raw, expected):
    assert parse_banned_words(raw) == expected


@pytest.mark.parametrize("raw, expected", [
    ('  "좋은 방송이네요"  ', "좋은 방송이네요"),
    ("“오늘도 재밌다”", "오늘도 재밌다"),
    ("' 안녕하세요 '", "안녕하세요"),
    ("`백틱도 제거`", "백틱도 제거"),
    ("따옴표 없음", "따옴표 없음"),
    ('중간의 "따옴표"는 유지', '중간의 "따옴표"는 유지'),
    ("", ""), (None, ""), ('  "" ', ""),
])
def test_clean_chat_message(raw, expected):
    assert clean_chat_message(raw) == expected


@pytest.mark.parametrize("text, words, expected", [
    ("스트리머 바보네", ("바보",), True),
    ("Spam 채팅", ("spam",), True),  # 대소문자 무시
    ("멀쩡한 채팅", ("바보",), False),
    ("금칙어 없음", (), False),
    ("", ("바보",), False),
    ("공백 금칙어 무시", (" ",), False),
])
def test_contains_banned_word(text, words, expected):
    assert contains_banned_word(text, words) == expected


@pytest.mark.parametrize("text, recent, expected", [
    ("오늘도 재밌네", ["오늘도 재밌네"], True),  # 완전 동일
    ("오늘도  재밌네 ", ["오늘도 재밌네"], True),  # 공백만 다름
    ("진짜 재밌다ㅋㅋㅋㅋ", ["진짜 재밌다ㅋㅋ"], True),  # 반복 문자만 다름
    ("오늘도 재밌네", ["어제는 재밌었지", "오늘도 재밌네"], True),  # 최근 목록 중 하나와 일치
    ("왼쪽으로 가요", ["오른쪽 위를 보세요"], False),
    ("오늘도 재밌네", [], False),
    ("", ["오늘도 재밌네"], False),
])
def test_is_repetitive_message(text, recent, expected):
    assert is_repetitive_message(text, recent) == expected


def test_is_repetitive_message_threshold():
    text, recent = "진짜 재밌다", ["진짜 재밌네"]
    assert is_repetitive_message(text, recent, similarity_threshold=0.7)
    assert not is_repetitive_message(text, recent, similarity_threshold=0.95)


def test_guard_passes_clean_message():
    assert guard_chat_message('  "좋은 방송이네요"  ') == "좋은 방송이네요"


def test_guard_truncates_to_chzzk_limit():
    guarded = guard_chat_message("가" * 150)
    assert len(guarded) == CHZZK_CHAT_MAX_LENGTH


def test_guard_blocks_banned_word():
    assert guard_chat_message("스트리머 바보네", banned_words=("바보",)) is None


def test_guard_blocks_repetition():
    assert guard_chat_message("오늘도 재밌네", recent_messages=["오늘도 재밌네"]) is None


@pytest.mark.parametrize("raw", ["", None, "   ", '" "'])
def test_guard_blocks_empty_after_cleaning(raw):
    assert guard_chat_message(raw) is None


def test_guard_checks_banned_word_after_cleaning():
    # 따옴표를 벗겨낸 뒤의 실제 전송 텍스트를 기준으로 검사한다
    assert guard_chat_message('"바보"', banned_words=("바보",)) is None


# ---------------------------------------------------------------------------
# LLMHandler 통합 (ollama HTTP는 mock)
# ---------------------------------------------------------------------------

import llm_handler
from llm_handler import LLMHandler


class FakeResponse:
    def __init__(self, content, status_code=200):
        self.status_code = status_code
        self._content = content

    def json(self):
        return {"message": {"content": self._content}}


def make_handler(monkeypatch, replies, **kwargs):
    """미리 정한 응답을 순서대로 돌려주는 mock Ollama를 붙인 핸들러 생성"""
    replies_iter = iter(replies)

    def fake_post(url, json=None, timeout=None):
        assert url.startswith("http://mock-ollama")
        return FakeResponse(next(replies_iter))

    monkeypatch.setattr(llm_handler.requests, "post", fake_post)
    kwargs.setdefault("banned_words", ())
    return LLMHandler(model_name="test-model", host="http://mock-ollama", **kwargs)


def test_generate_response_passes_clean_reply(monkeypatch):
    handler = make_handler(monkeypatch, ['"오늘도 재밌네요"'])
    assert handler.generate_response("오늘 방송 어때?") == "오늘도 재밌네요"


def test_generate_response_blocks_duplicate(monkeypatch):
    handler = make_handler(monkeypatch, ["오늘도 재밌네요", "오늘도 재밌네요"])
    assert handler.generate_response("첫 번째 발화") == "오늘도 재밌네요"
    assert handler.generate_response("두 번째 발화") is None


def test_generate_response_blocks_near_duplicate(monkeypatch):
    handler = make_handler(monkeypatch, ["진짜 재밌다", "진짜  재밌다"])
    assert handler.generate_response("첫 번째 발화") == "진짜 재밌다"
    assert handler.generate_response("두 번째 발화") is None


def test_generate_response_allows_different_replies(monkeypatch):
    handler = make_handler(monkeypatch, ["왼쪽으로 가보세요", "오른쪽 위를 보세요"])
    assert handler.generate_response("첫 번째 발화") == "왼쪽으로 가보세요"
    assert handler.generate_response("두 번째 발화") == "오른쪽 위를 보세요"


def test_generate_response_blocks_banned_word(monkeypatch):
    handler = make_handler(monkeypatch, ["스트리머 바보네"], banned_words=("바보",))
    assert handler.generate_response("아무 발화") is None


def test_blocked_response_not_added_to_context(monkeypatch):
    handler = make_handler(monkeypatch, ["스트리머 바보네"], banned_words=("바보",))
    handler.generate_response("아무 발화")
    assert len(handler.context) == 0


def test_generate_response_skips_empty_speech_without_network(monkeypatch):
    def explode(*args, **kwargs):
        raise AssertionError("네트워크 호출이 없어야 함")

    monkeypatch.setattr(llm_handler.requests, "post", explode)
    handler = LLMHandler(model_name="test-model", host="http://mock-ollama")
    assert handler.generate_response("") is None
    assert handler.generate_response("   ") is None
