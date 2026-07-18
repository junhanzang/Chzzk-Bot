import sys

import pytest

from core_logic import approval_action, build_llm_messages, extract_channel_id, postprocess_llm_response


@pytest.mark.parametrize("value, expected", [
    ("https://chzzk.naver.com/live/abc123", "abc123"),
    ("https://chzzk.naver.com/abc123/", "abc123"),
    (" https://chzzk.naver.com/live/abc123?foo=bar ", "abc123"),
    ("abc123", "abc123"), ("", ""),
])
def test_extract_channel_id(value, expected):
    assert extract_channel_id(value) == expected


def test_build_messages_contains_all_context_in_order():
    messages = build_llm_messages(
        "system", "오늘 뭐 하지?",
        history=[{"role": "streamer", "text": "안녕"}, {"role": "bot", "text": "하이"}],
        chat_context="시청자: 게임해요", streamer_memory="게임을 좋아함",
        chat_memory="활기참", my_chat_memory="짧게 말함",
    )
    assert messages[0] == {"role": "system", "content": "system"}
    content = messages[1]["content"]
    parts = ["[참고 정보]", "스트리머 특징:\n게임을 좋아함", "채팅 분위기:\n활기참",
             "내 응답 패턴:\n짧게 말함", "현재 채팅창 분위기:", "시청자: 게임해요",
             "스트리머: 안녕", "나: 하이", '스트리머가 방금 한 말: "오늘 뭐 하지?"']
    assert all(part in content for part in parts)
    assert [content.index(part) for part in parts] == sorted(content.index(part) for part in parts)


@pytest.mark.parametrize("raw, expected", [
    ("<think>고민</think>진짜 재밌겠다\n둘째 줄", "진짜 재밌겠다"),
    ('Response: "오늘도 재밌네"', "오늘도 재밌네"),
    ("prefix 오늘 좋다 trailing", "오늘 좋다"),
    ("English only", None), ("ㅋ", None), (None, None),
])
def test_postprocess(raw, expected):
    assert postprocess_llm_response(raw) == expected


def test_postprocess_truncates_to_chat_limit():
    assert len(postprocess_llm_response("가" * 60)) == 50


@pytest.mark.parametrize("choice, expected", [
    ("", "send"), ("anything", "send"), (" S ", "skip"), ("e", "edit"), ("M", "mode"),
])
def test_approval_action(choice, expected):
    assert approval_action(choice) == expected


def test_core_module_does_not_load_heavy_dependencies():
    forbidden = ("soundcard", "chzzkpy", "ollama", "torch")
    assert not any(name == item or name.startswith(item + ".")
                   for name in sys.modules for item in forbidden)
