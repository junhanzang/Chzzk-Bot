"""Chat context tests use in-memory events: no chzzkpy client or account is loaded."""
import importlib.util
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


@pytest.fixture
def chat_module(monkeypatch):
    chat = types.ModuleType("chzzkpy.unofficial.chat")
    chat.ChatClient = object
    chat.ChatMessage = types.SimpleNamespace
    chat.DonationMessage = types.SimpleNamespace
    for name in ("chzzkpy", "chzzkpy.unofficial"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "chzzkpy.unofficial.chat", chat)
    spec = importlib.util.spec_from_file_location("desk_chat_context_test", Path(__file__).parents[1] / "chat_reader.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "time", types.SimpleNamespace(time=lambda: 1000.0))
    return module


def message(text, timestamp=999.0):
    return {"nickname": "시청자", "content": text, "time": timestamp}


def test_recent_messages_expire_before_counting_and_preserve_default_behavior(chat_module):
    reader = chat_module.ChatReader("channel")
    reader.messages.extend([message("오래된 내용", 100), message("현재 내용", 995), message("미래 시각", 1001)])
    assert [item["content"] for item in reader.get_recent_messages(2)] == ["현재 내용", "미래 시각"]
    assert [item["content"] for item in reader.get_recent_messages(2, max_age_seconds=30)] == ["현재 내용"]
    assert reader.get_recent_messages(0, max_age_seconds=30) == []
    assert "오래된 내용" in reader.get_chat_context()
    assert reader.get_chat_context(max_age_seconds=30) == "시청자: 현재 내용"


def test_freshness_accepts_boundary_but_excludes_unknown_nonfinite_and_future_timestamps(chat_module):
    reader = chat_module.ChatReader("channel", max_messages=30)
    invalid = [None, "999", float("nan"), float("inf"), -float("inf"), True, 1000.01, 969.99]
    reader.messages.extend(message(f"invalid-{index}", stamp) for index, stamp in enumerate(invalid))
    reader.messages.extend([{"nickname": "missing", "content": "시각 없음"}, message("경계", 970), message("방금", 1000)])
    assert [item["content"] for item in reader.get_recent_messages(30, max_age_seconds=30)] == ["경계", "방금"]
    assert reader.get_chat_rate(30) == 4


def test_context_filters_all_fresh_reactions_before_applying_the_count(chat_module):
    reader = chat_module.ChatReader("channel", max_messages=30)
    reader.messages.append(message("오래된 문장", 900))
    reader.messages.extend([message("첫 이야기", 980), message("두 번째 이야기", 981)])
    reader.messages.extend(message("ㅋㅋㅋ", 990 + index) for index in range(8))
    assert reader.get_chat_context(2, True, max_age_seconds=30) == "시청자: 첫 이야기\n시청자: 두 번째 이야기"
    assert reader.get_chat_context(0, True, max_age_seconds=30) == "(채팅 없음)"
    assert reader.get_chat_context(2, True, max_age_seconds=1) == "(채팅 없음)"


def test_donations_use_the_same_optional_age_limit(chat_module):
    reader = chat_module.ChatReader("channel")
    reader.donations.extend([message("이전 도네이션", 970), message("새 도네이션", 990),
                             {"nickname": "legacy", "content": "시각 없는 이전 기록"}])
    assert len(reader.get_recent_donations()) == 3
    assert reader.get_recent_donations(10, max_age_seconds=20) == [message("새 도네이션", 990)]
    assert reader.get_recent_donations(0, max_age_seconds=20) == []


@pytest.mark.parametrize("age", [-1, float("nan"), float("inf"), "30", True])
def test_age_limits_must_be_explicit_finite_seconds(chat_module, age):
    reader = chat_module.ChatReader("channel")
    with pytest.raises(ValueError):
        reader.get_recent_messages(max_age_seconds=age)


def test_event_timestamps_use_chzzkpy_datetime_seconds_for_chat_and_donation(chat_module):
    reader = chat_module.ChatReader("channel")
    source_time = datetime.fromtimestamp(950, tz=timezone(timedelta(hours=9)))
    profile = types.SimpleNamespace(nickname="viewer")
    chat_event = types.SimpleNamespace(profile=profile, content="늦게 도착한 채팅", time=source_time)
    donation_event = types.SimpleNamespace(profile=profile, content="최근 도네이션", time=datetime.fromtimestamp(990, timezone.utc))

    class FakeClient:
        def __init__(self):
            self.callbacks = {}

        def event(self, callback):
            self.callbacks[callback.__name__] = callback
            return callback

        async def start(self):
            await self.callbacks["on_chat"](chat_event)
            await self.callbacks["on_donation"](donation_event)
            reader._running = False

    client = FakeClient()
    reader._create_client = lambda: client
    reader._close_client = lambda *_args: None
    reader._running = True
    reader._run_client()
    assert reader.messages[0]["time"] == 950
    assert reader.donations[0]["time"] == 990
    assert reader.get_chat_context(max_age_seconds=30) == "(채팅 없음)"
    assert len(reader.get_recent_donations(max_age_seconds=20)) == 1


def test_only_missing_message_time_falls_back_to_receipt_time(chat_module):
    assert chat_module.ChatReader._message_time(types.SimpleNamespace()) == 1000
    for value in (None, "999", 999000, datetime(2026, 1, 1)):
        assert chat_module.ChatReader._message_time(types.SimpleNamespace(time=value)) is None
