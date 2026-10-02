"""Lifecycle failures tested without devices, models, network or account access."""
import builtins
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from types import ModuleType
import sys
import time

import pytest

from bot.runtime import ChzzkVoiceBot
from bot.session import BotServices, SessionSetupError
from config import Config
from response_pipeline import ResponseCandidate


CHANNEL = "a" * 32


class FakeServices:
    def __init__(self, fail=None, exception=RuntimeError):
        self.calls = []
        self.fail = fail
        self.exception = exception
        self.audio = self.reader = self.sender = None

    def call(self, name, result=None):
        self.calls.append(name)
        if self.fail == name:
            raise self.exception("simulated " + name)
        return result

    def create_memories(self, channel_id, *, use_mock=False):
        self.call("memories")
        memory = SimpleNamespace(get_facts_as_prompt=lambda: "")
        manager = SimpleNamespace(force_update=lambda: self.call("memory_update"),
                                  save_all=lambda: self.call("memory_save"))
        return memory, memory, memory, manager, "unused.txt"

    def create_llm(self, chat_log_path):
        self.call("llm")
        return SimpleNamespace(check_connection=lambda: self.call("ollama", self.fail != "ollama_false"))

    def create_sender(self, use_mock):
        self.call("sender")
        def authenticate(channel, *, interactive):
            self.calls.append(("authenticate_interactive", interactive))
            return self.call("authenticate", self.fail != "authenticate_false")
        self.sender = SimpleNamespace(authenticate=authenticate,
                                      disconnect=lambda: self.call("sender_stop"))
        return self.sender

    def create_reader(self, channel_id):
        self.call("reader")
        self.reader = SimpleNamespace(start=lambda: self.call("reader_start"),
                                      stop=lambda: self.call("reader_stop"))
        return self.reader

    def create_recognizer(self):
        self.call("recognizer")
        return SimpleNamespace(load_model=lambda: self.call("load_model"))

    def create_audio(self, speaker_id, interactive):
        self.calls.append(("speaker", speaker_id, interactive))
        self.call("audio")
        self.audio = SimpleNamespace(start=lambda: self.call("audio_start"),
                                     stop=lambda: self.call("audio_stop"))
        return self.audio


def make_bot(services, **kwargs):
    options = dict(channel_id=CHANNEL, non_interactive=True, auto_send=True, mode="hybrid")
    options.update(kwargs)
    bot = ChzzkVoiceBot(services=services, **options)
    # No worker needs to run to exercise resource allocation and teardown order.
    bot._start_thread = lambda *args: services.call("thread_start")
    bot._response_handler = lambda: services.call("handler")
    return bot


def test_import_and_constructor_do_not_load_platform_adapters(monkeypatch):
    original = builtins.__import__
    prohibited = {"torch", "numpy", "soundcard", "chzzkpy", "audio_capture", "speech_recognition", "chat_reader", "chat_sender"}
    def guarded(name, *args, **kwargs):
        if name.split(".")[0] in prohibited:
            pytest.fail("Unexpected device or account import: " + name)
        return original(name, *args, **kwargs)
    monkeypatch.setattr(builtins, "__import__", guarded)
    spec = importlib.util.spec_from_file_location("bot_light_entry", Path(__file__).parents[1] / "main.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bot = module.ChzzkVoiceBot(mode="mimic", use_mock=True)
    assert bot.audio_capture is None and bot.chat_sender is None


@pytest.mark.parametrize("phase", ["memories", "llm", "sender", "authenticate", "authenticate_false",
    "reader", "reader_start", "ollama", "ollama_false", "recognizer", "load_model", "audio",
    "audio_start", "thread_start", "handler"])
def test_every_start_failure_cleans_all_acquired_resources_once(phase):
    services = FakeServices(fail=phase)
    bot = make_bot(services)
    assert not bot.start()
    assert bot._stop_event.is_set()
    for resource, stop in ((services.sender, "sender_stop"), (services.reader, "reader_stop"),
                           (services.audio, "audio_stop")):
        if resource is not None:
            assert services.calls.count(stop) == 1
    if bot.memory_manager is not None:
        assert services.calls.count("memory_update") == services.calls.count("memory_save") == 1
    bot.stop()
    for stop in ("sender_stop", "reader_stop", "audio_stop", "memory_update", "memory_save"):
        assert services.calls.count(stop) <= 1


def test_successful_run_cleans_before_return_and_preserves_noninteractive_options(monkeypatch):
    monkeypatch.setattr(builtins, "input", lambda *_: pytest.fail("No prompt allowed"))
    services = FakeServices()
    bot = make_bot(services, speaker_id="saved-device-id")
    assert bot.start()
    assert ("authenticate_interactive", False) in services.calls
    assert ("speaker", "saved-device-id", False) in services.calls
    assert services.calls.index("sender_stop") < services.calls.index("memory_update")
    assert bot._stopped
    with pytest.raises(RuntimeError, match="한 번"):
        bot.start()


@pytest.mark.parametrize("exception", [KeyboardInterrupt, SystemExit])
def test_interrupt_during_model_initialization_always_cleans(exception):
    services = FakeServices(fail="load_model", exception=exception)
    bot = make_bot(services)
    if exception is KeyboardInterrupt:
        assert bot.start()
    else:
        with pytest.raises(SystemExit):
            bot.start()
    assert services.calls.count("reader_stop") == services.calls.count("sender_stop") == 1
    assert services.calls.count("memory_save") == 1


@pytest.mark.parametrize("broken", ["audio_stop", "reader_stop", "sender_stop", "memory_update", "memory_save"])
def test_one_broken_cleanup_does_not_skip_other_resources(broken):
    services = FakeServices(fail=broken)
    bot = make_bot(services)
    assert bot.start()
    for operation in ("audio_stop", "reader_stop", "sender_stop", "memory_update", "memory_save"):
        assert services.calls.count(operation) == 1
    assert bot.metrics.snapshot()["cleanup_error"] == 1
    bot.stop()
    assert services.calls.count(broken) == 1


def test_initialize_called_directly_cleans_partial_authentication_failure():
    services = FakeServices(fail="authenticate_false")
    bot = make_bot(services)
    assert not bot.initialize()
    assert services.calls.count("sender_stop") == 1
    assert "reader" not in services.calls


@pytest.mark.parametrize("channel", ["../escape", "https://example.org/live/" + CHANNEL])
def test_invalid_channel_is_rejected_before_resources_are_created(channel):
    services = FakeServices()
    bot = make_bot(services, channel_id=channel)
    assert not bot.start()
    assert services.calls == []


def test_missing_channel_noninteractive_never_prompts(monkeypatch):
    monkeypatch.setattr(Config, "CHZZK_CHANNEL_ID", "")
    monkeypatch.setattr(builtins, "input", lambda *_: pytest.fail("No prompt allowed"))
    services = FakeServices()
    assert not make_bot(services, channel_id=None).start()
    assert not services.calls


def test_noninteractive_live_requires_explicit_auto_send():
    services = FakeServices()
    assert not make_bot(services, auto_send=False).start()
    assert not services.calls


def test_mimic_start_does_not_require_audio_model_or_ollama(monkeypatch):
    monkeypatch.setattr(builtins, "input", lambda *_: pytest.fail("No prompt allowed"))
    services = FakeServices()
    bot = make_bot(services, mode="mimic", use_mock=True, auto_send=False)
    assert bot.start()
    assert bot.auto_send  # Mock only prints; noninteractive mock never asks approval.
    assert not set(("ollama", "recognizer", "load_model", "audio", "audio_start")).intersection(services.calls)
    assert ("authenticate_interactive", False) in services.calls


def test_switching_from_mimic_prepares_speech_once_then_changes_generation():
    services = FakeServices()
    bot = make_bot(services, mode="mimic")
    assert bot.initialize()
    assert not bot.session.speech_ready
    bot._cycle_mode()
    assert bot.response_mode == "ai" and bot.session.speech_ready
    assert bot.pipeline.generation == 1
    bot._cycle_mode()
    assert bot.response_mode == "hybrid"
    assert services.calls.count("load_model") == 1
    bot.stop()


def test_failed_speech_mode_setup_keeps_working_mimic_mode():
    services = FakeServices(fail="ollama_false")
    bot = make_bot(services, mode="mimic")
    assert bot.initialize()
    bot._cycle_mode()
    assert bot.response_mode == "mimic" and bot.pipeline.generation == 0
    assert bot.metrics.snapshot()["mode_error"] == 1
    bot.stop()


def test_stopped_session_cannot_start_models_via_mode_switch():
    services = FakeServices()
    bot = make_bot(services, mode="mimic")
    bot.stop()
    bot._cycle_mode()
    assert bot.response_mode == "mimic" and not services.calls


def test_audio_start_failure_during_mode_change_releases_partial_device():
    services = FakeServices(fail="audio_start")
    bot = make_bot(services, mode="mimic")
    assert bot.initialize()
    bot._started = True
    bot._cycle_mode()
    assert bot.response_mode == "mimic" and not bot.session.speech_ready
    assert bot.audio_capture is None
    assert services.calls.count("audio_stop") == 1
    bot.stop()
    assert services.calls.count("audio_stop") == 1


def test_third_party_error_text_is_not_printed(capsys):
    services = FakeServices()
    def secret_error(*args, **kwargs):
        raise RuntimeError("NID_AUT=private-cookie")
    services.create_sender = secret_error
    bot = make_bot(services)
    assert not bot.start()
    output = capsys.readouterr().out
    assert "private-cookie" not in output and "RuntimeError" in output


def test_worker_start_failure_joins_already_started_workers(monkeypatch):
    services = FakeServices()
    bot = make_bot(services)
    bot._start_thread = ChzzkVoiceBot._start_thread.__get__(bot)
    threads = []
    class Thread:
        def __init__(self, **kwargs):
            self.name = kwargs["name"]
            self.alive = False
            threads.append(self)
        def start(self):
            if len(threads) == 2:
                raise RuntimeError("Thread start failed")
            self.alive = True
        def is_alive(self):
            return self.alive
        def join(self, timeout):
            services.calls.append("joined " + self.name)
            self.alive = False
    monkeypatch.setattr("bot.runtime.threading.Thread", Thread)
    assert not bot.start()
    assert "joined ASR-Worker" in services.calls
    assert not threads[0].alive


def test_default_speaker_uses_system_default_without_prompt_or_enumeration(monkeypatch):
    monkeypatch.setattr(builtins, "input", lambda *_: pytest.fail("No prompt allowed"))
    fake_audio = ModuleType("audio_capture")
    fake_audio.AudioCapture = lambda **kwargs: kwargs
    monkeypatch.setitem(sys.modules, "audio_capture", fake_audio)
    assert BotServices().create_audio("", interactive=True) == {"speaker": None}


def test_saved_speaker_uses_exact_device_id_and_does_not_silently_fallback(monkeypatch):
    speaker = SimpleNamespace(id="saved-device", name="Fake output")
    fake_audio = ModuleType("audio_capture")
    fake_audio.AudioCapture = lambda **kwargs: kwargs
    fake_soundcard = ModuleType("soundcard")
    fake_soundcard.all_speakers = lambda: [speaker]
    monkeypatch.setitem(sys.modules, "audio_capture", fake_audio)
    monkeypatch.setitem(sys.modules, "soundcard", fake_soundcard)
    assert BotServices().create_audio("saved-device", interactive=False) == {"speaker": speaker}
    with pytest.raises(SessionSetupError, match="--list-speakers"):
        BotServices().create_audio("unplugged", interactive=False)


def test_preview_memory_and_chat_log_are_separate_from_live_profile(monkeypatch):
    fake_store = ModuleType("memory.memory_store")
    fake_store.MemoryStore = lambda path, max_facts: SimpleNamespace(path=Path(path))
    fake_manager = ModuleType("memory.memory_manager")
    fake_manager.MemoryManager = lambda *stores: SimpleNamespace(stores=stores)
    monkeypatch.setitem(sys.modules, "memory.memory_store", fake_store)
    monkeypatch.setitem(sys.modules, "memory.memory_manager", fake_manager)
    services = BotServices()
    live = services.create_memories(CHANNEL)
    preview = services.create_memories(CHANNEL, use_mock=True)
    for normal, mock in zip(live[:3], preview[:3]):
        assert normal.path.parent.name == mock.path.parent.name == CHANNEL
        assert normal.path.parent.parent.name == "data"
        assert mock.path.parent.parent.name == "mock"
        assert mock.path.parent.parent.parent.name == "data"
    assert Path(preview[-1]).parent == preview[0].path.parent
    assert Path(preview[-1]) != Path(live[-1])


def test_status_snapshot_exposes_connection_and_counts_without_message_text(capsys):
    services = FakeServices()
    bot = make_bot(services)
    assert bot.initialize()
    services.reader.status = "reconnecting"
    services.sender.status = "auth_required"
    bot.metrics.increment("fresh_expired", 2)
    snapshot = bot.status_snapshot()
    assert snapshot["reader"] == "reconnecting"
    assert snapshot["sender"] == "auth_required"
    assert snapshot["counts"] == {"fresh_expired": 2}
    snapshot["counts"]["fresh_expired"] = 99
    assert bot.metrics.snapshot()["fresh_expired"] == 2
    bot.print_status()
    output = capsys.readouterr().out
    assert "재연결 중" in output and "로그인 필요" in output
    bot.stop()


def test_real_mock_sender_authenticates_and_processes_preview_without_network(monkeypatch, capsys):
    chat = ModuleType("chzzkpy.unofficial.chat")
    chat.ChatClient = lambda *args, **kwargs: pytest.fail("Preview must not create a network sender")
    for name in ("chzzkpy", "chzzkpy.unofficial"):
        monkeypatch.setitem(sys.modules, name, ModuleType(name))
    monkeypatch.setitem(sys.modules, "chzzkpy.unofficial.chat", chat)
    spec = importlib.util.spec_from_file_location("offline_preview_sender", Path(__file__).parents[1] / "chat_sender.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    services = FakeServices()
    records = []
    services.create_sender = lambda use_mock: module.MockChatSender()
    services.create_llm = lambda path: SimpleNamespace(validate_response=lambda text: text,
        record_sent_response=lambda speech, text: records.append((speech, text)))
    bot = make_bot(services, mode="mimic", use_mock=True, auto_send=False)
    assert bot.initialize()
    assert bot.chat_sender.is_authenticated
    assert bot.chat_sender._client is None and bot.chat_sender._thread is None
    candidate = ResponseCandidate("(채팅 반응)", "ㅋㅋㅋ", "", time.monotonic(), bot.pipeline.generation, "mimic")
    assert bot._process_candidate(candidate)
    assert records == [("", "ㅋㅋㅋ")]
    assert bot.metrics.snapshot()["sent"] == 1
    assert "[MOCK 전송] ㅋㅋㅋ" in capsys.readouterr().out
    bot.stop()
    assert not bot.chat_sender.is_authenticated
