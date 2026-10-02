"""Memory tests use temporary JSON files and fake LLM replies only."""
import copy
import json
import threading

import pytest

import memory.memory_manager as manager_module
import memory.memory_store as store_module
from memory.memory_manager import MemoryManager
from memory.memory_store import MemoryStore


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        raise AssertionError("This test must provide a fake LLM response")
    monkeypatch.setattr(manager_module.requests, "post", forbidden)


def stores(tmp_path):
    result = [MemoryStore(tmp_path / f"{name}.json", max_facts=4) for name in ("streamer", "chat", "bot")]
    for store in result:
        store.replace_all_facts(["기존 기억"])
    return result


class Reply:
    status_code = 200

    def __init__(self, text):
        self.text = text

    def json(self):
        return {"response": self.text}


def record(manager, index):
    manager.record_interaction(f"speech-{index}", f"response-{index}", f"chat-{index}")


def test_updates_are_single_flight_coalesced_and_use_one_snapshot_for_all_three_stores(tmp_path, monkeypatch):
    memories = stores(tmp_path)
    manager = MemoryManager(*memories)
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    prompts = []
    active = peak = 0
    guard = threading.Lock()

    def fake_post(_url, json, timeout):
        nonlocal active, peak
        with guard:
            active += 1
            peak = max(peak, active)
            prompts.append(json["prompt"])
            first = len(prompts) == 1
        try:
            if first:
                entered.set()
                assert release.wait(3), "Test did not release the first summary"
            return Reply('["최신 기억"]' if "-15" in json["prompt"] else '["이전 기억"]')
        finally:
            with guard:
                active -= 1

    monkeypatch.setattr(manager_module.requests, "post", fake_post)
    for index in range(1, 6):
        record(manager, index)
    assert entered.wait(3)
    for index in range(6, 16):
        record(manager, index)
    waiter = threading.Thread(target=lambda: (manager.force_update(), completed.set()))
    waiter.start()
    try:
        assert not completed.wait(0.02), "force_update must wait for the current and queued latest snapshot"
        assert len(prompts) == 1
    finally:
        release.set()
        waiter.join(timeout=3)
    assert not waiter.is_alive()
    assert completed.is_set()
    assert peak == 1
    assert len(prompts) == 6, "Requests for interaction 10 and 15 collapse into one latest update"
    assert all("-15" not in prompt and "-5" in prompt for prompt in prompts[:3])
    assert all("-15" in prompt for prompt in prompts[3:])
    assert all(store.get_facts() == ["최신 기억"] for store in memories)
    assert len(manager.interaction_buffer) == 10
    assert len(manager.chat_context_buffer) == 5
    manager.force_update()
    assert len(prompts) == 6, "Already completed generations must not produce duplicate summaries"


def test_force_update_flushes_less_than_five_interactions_without_a_second_worker(tmp_path, monkeypatch):
    memories = stores(tmp_path)
    manager = MemoryManager(*memories)
    prompts = []
    def fake_post(_url, json, timeout):
        prompts.append(json["prompt"])
        return Reply('["짧은 세션 기억"]')
    monkeypatch.setattr(manager_module.requests, "post", fake_post)
    record(manager, 1)
    assert prompts == []
    manager.force_update()
    manager.save_all()
    assert len(prompts) == 3
    assert all(MemoryStore(store.file_path).get_facts() == ["짧은 세션 기억"] for store in memories)


@pytest.mark.parametrize("reply", [
    '["정상처럼 보임", null]', '["정상처럼 보임", 123]', '[{"text":"잘못된 구조"}]',
    '[" "]', '[]', '{"facts":["다른 구조"]}', 'not JSON', '["미완성"',
])
def test_malformed_or_empty_llm_replies_leave_all_existing_memories_intact(tmp_path, monkeypatch, reply):
    memories = stores(tmp_path)
    before = [store.file_path.read_bytes() for store in memories]
    manager = MemoryManager(*memories)
    monkeypatch.setattr(manager_module.requests, "post", lambda *_args, **_kwargs: Reply(reply))
    record(manager, 1)
    manager.force_update()
    assert all(store.get_facts() == ["기존 기억"] for store in memories)
    assert [store.file_path.read_bytes() for store in memories] == before


def test_parser_accepts_a_bounded_string_array_and_json_code_fence(tmp_path):
    manager = MemoryManager(*stores(tmp_path))
    assert manager._parse_json_array('```json\n[" 기억 ", "기억", "다른 기억"]\n```') == ["기억", "다른 기억"]
    assert manager._parse_json_array(json.dumps([str(index) for index in range(8)])) == [str(index) for index in range(5)]
    assert manager._parse_json_array(json.dumps(["a" * 201])) is None
    assert manager._parse_json_array(json.dumps(["a"] * 101)) is None
    assert manager._parse_json_array("x" * 8193) is None


@pytest.mark.parametrize("values", [None, "one", {}, ["keep", None], ["keep", 1], [" "], ["a" * 201], ["a"] * 101])
def test_store_validates_the_entire_array_before_replacing_any_fact(tmp_path, values):
    store = MemoryStore(tmp_path / "memory.json")
    store.replace_all_facts(["남아야 하는 기억"])
    previous = copy.deepcopy(store.data)
    data = store.file_path.read_bytes()
    with pytest.raises(ValueError):
        store.replace_all_facts(values)
    assert store.data == previous
    assert store.file_path.read_bytes() == data


@pytest.mark.parametrize("stage", ["write", "replace"])
def test_atomic_write_failure_preserves_memory_and_disk_and_removes_temporary_files(tmp_path, monkeypatch, stage):
    store = MemoryStore(tmp_path / "memory.json")
    store.replace_all_facts(["보존할 기억"])
    previous = copy.deepcopy(store.data)
    data = store.file_path.read_bytes()
    def fail(*_args, **_kwargs):
        raise OSError("disk full")
    if stage == "write":
        monkeypatch.setattr(store_module.json, "dump", fail)
    else:
        monkeypatch.setattr(store_module.os, "replace", fail)
    with pytest.raises(OSError, match="disk full"):
        store.replace_all_facts(["저장 실패한 기억"])
    assert store.data == previous
    assert store.file_path.read_bytes() == data
    assert list(tmp_path.iterdir()) == [store.file_path]
    with pytest.raises(OSError, match="disk full"):
        store.save()
    assert store.data == previous


def test_one_failed_store_does_not_strand_force_update_or_prevent_next_generation(tmp_path, monkeypatch):
    memories = stores(tmp_path)
    manager = MemoryManager(*memories)
    monkeypatch.setattr(manager_module.requests, "post", lambda *_args, **_kwargs: Reply('["새 기억"]'))
    original_write = memories[0]._write
    def fail(_data):
        raise OSError("disk full")
    monkeypatch.setattr(memories[0], "_write", fail)
    record(manager, 1)
    manager.force_update()
    assert memories[0].get_facts() == ["기존 기억"]
    assert memories[1].get_facts() == memories[2].get_facts() == ["새 기억"]
    monkeypatch.setattr(memories[0], "_write", original_write)
    record(manager, 2)
    manager.force_update()
    assert all(store.get_facts() == ["새 기억"] for store in memories)


@pytest.mark.parametrize("data", [None, [], {"facts": "wrong"}, {"facts": [None]}, {"facts": [{"text": None}]}])
def test_invalid_persisted_schema_is_not_loaded_as_memory(tmp_path, data):
    file = tmp_path / "memory.json"
    file.write_text(json.dumps(data), encoding="utf-8")
    assert MemoryStore(file).get_facts() == []


def test_relative_file_path_and_valid_loaded_metadata_remain_supported(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    store = MemoryStore("memory.json", max_facts=2)
    store.replace_all_facts(["첫 기억", "두 번째 기억", "세 번째 기억"])
    loaded = MemoryStore("memory.json", max_facts=2)
    assert loaded.get_facts() == ["첫 기억", "두 번째 기억"]
    assert loaded.data == store.data
