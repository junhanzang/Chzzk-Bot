"""Real worker threads and asyncio loops, using only in-memory fake clients."""
import asyncio
import importlib.util
import sys
import threading
import time
import types
from pathlib import Path

import pytest

from bot.connection import close_client, close_loop
from core_logic import ChatReconnectPolicy
from response_pipeline import ResponseCandidate, ResponsePipeline


@pytest.fixture
def modules(monkeypatch):
    chat = types.ModuleType("chzzkpy.unofficial.chat")
    chat.ChatClient = object
    chat.ChatMessage = types.SimpleNamespace
    chat.DonationMessage = types.SimpleNamespace
    for name in ("chzzkpy", "chzzkpy.unofficial"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "chzzkpy.unofficial.chat", chat)
    config = types.ModuleType("config")
    config.Config = types.SimpleNamespace(NID_AUT="test-auth", NID_SES="test-session")
    monkeypatch.setitem(sys.modules, "config", config)
    results = []
    for filename in ("chat_sender", "chat_reader"):
        spec = importlib.util.spec_from_file_location(f"test_transport_{filename}", Path(__file__).parents[1] / f"{filename}.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        monkeypatch.setattr(module, "ChatReconnectPolicy", lambda **kwargs: ChatReconnectPolicy(initial_delay=.01, max_delay=.02))
        results.append(module)
    return tuple(results)


class Client:
    def __init__(self, *, user_id="test-user", return_immediately=False):
        self.callbacks = {}
        self.user_id = user_id
        self.is_connected = False
        self.return_immediately = return_immediately
        self.started = threading.Event()
        self.closed = threading.Event()
        self.released = None
        self.sent = []

    def event(self, callback):
        self.callbacks[callback.__name__] = callback
        return callback

    async def start(self):
        self.is_connected = True
        self.released = asyncio.Event()
        if "on_connect" in self.callbacks:
            await self.callbacks["on_connect"]()
        self.started.set()
        if not self.return_immediately:
            await self.released.wait()

    async def close(self):
        self.is_connected = False
        if self.released:
            self.released.set()
        self.closed.set()

    async def send_chat(self, text):
        self.sent.append(text)


def until(condition, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if condition():
            return True
        threading.Event().wait(.005)
    return False


def connected_sender(modules, client):
    sender = modules[0].ChatSender()
    sender.CONNECT_TIMEOUT = 1
    sender._create_client = lambda: client
    assert sender.authenticate("channel", interactive=False)
    return sender


def test_noninteractive_missing_cookies_never_opens_a_browser(modules, monkeypatch):
    module = modules[0]
    monkeypatch.setattr(module.Config, "NID_AUT", "")
    sender = module.ChatSender()
    sender._login_via_browser = lambda: pytest.fail("unexpected browser")
    assert not sender.authenticate("channel", interactive=False)
    assert sender.status == "auth_required"
    assert sender._thread is None


def test_noninteractive_expired_cookies_close_worker_and_require_login(modules):
    sender = modules[0].ChatSender()
    client = Client(user_id=None)
    sender._create_client = lambda: client
    sender._login_via_browser = lambda: pytest.fail("unexpected browser")
    assert not sender.authenticate("channel", interactive=False)
    assert sender.status == "auth_required"
    assert not sender.is_authenticated
    assert not sender._thread.is_alive()
    assert client.closed.is_set()


@pytest.mark.parametrize("error_name", ["UnauthorizedException", "HTTPException"])
def test_explicit_auth_error_stops_reconnecting_without_leaking_exception(modules, capsys, error_name):
    sender = modules[0].ChatSender()
    error_type = type(error_name, (Exception,), {})
    attempts = []

    def create():
        attempts.append(1)
        raise error_type("cookie=private-test-value (401)")

    sender._create_client = create
    assert not sender.authenticate("channel", interactive=False)
    assert sender.status == "auth_required"
    assert len(attempts) == 1
    assert "private-test-value" not in capsys.readouterr().out


def test_network_failure_does_not_trigger_browser_login(modules):
    sender = modules[0].ChatSender()
    sender.CONNECT_TIMEOUT = .04
    sender._create_client = lambda: (_ for _ in ()).throw(ConnectionError("offline"))
    sender._login_via_browser = lambda: pytest.fail("unexpected browser")
    assert not sender.authenticate("channel", interactive=True)
    assert sender.status == "stopped"
    assert not sender._thread.is_alive()


def test_successful_send_and_stop_use_one_worker_loop(modules):
    client = Client()
    sender = connected_sender(modules, client)
    try:
        assert sender.send_message("안녕하세요")
        assert client.sent == ["안녕하세요"]
        assert sender.last_send_time > 0
        assert sender.status == "connected"
    finally:
        sender.disconnect()
    assert client.closed.is_set()
    assert not sender._thread.is_alive()
    assert not sender.is_connected()
    assert sender.status == "stopped"
    assert not sender.send_message("종료 후 전송 금지")


def test_normal_return_from_socket_start_reconnects_with_new_client(modules):
    first, second = Client(), Client()
    sender = modules[0].ChatSender()
    clients = iter((first, second))
    sender._create_client = lambda: next(clients)
    assert sender.authenticate("channel", interactive=False)
    try:
        sender._loop.call_soon_threadsafe(first.released.set)
        assert second.started.wait(1)
        assert first.closed.is_set()
        assert until(sender.is_connected)
        assert sender._client is second
        assert sender.send_message("새 연결")
        assert first.sent == []
        assert second.sent == ["새 연결"]
    finally:
        sender.disconnect()


def test_timeout_cancels_inflight_send_and_never_retries(modules):
    class SlowClient(Client):
        def __init__(self):
            super().__init__()
            self.calls = 0
            self.cancelled = threading.Event()

        async def send_chat(self, text):
            self.calls += 1
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled.set()

    client = SlowClient()
    sender = connected_sender(modules, client)
    sender.SEND_TIMEOUT = .02
    try:
        assert not sender.send_message("늦은 메시지", retry=99)
        assert client.cancelled.wait(1)
        assert client.calls == 1
        assert sender.last_send_time == 0
        assert "자동 재전송하지" in sender.last_error
    finally:
        sender.disconnect()


def test_reconnect_cancels_send_owned_by_old_socket(modules):
    class SlowClient(Client):
        def __init__(self):
            super().__init__()
            self.sending = threading.Event()
            self.cancelled = threading.Event()

        async def send_chat(self, text):
            self.sending.set()
            try:
                await asyncio.Event().wait()
            finally:
                self.cancelled.set()

    old, current = SlowClient(), Client()
    sender = modules[0].ChatSender()
    clients = iter((old, current))
    sender._create_client = lambda: next(clients)
    assert sender.authenticate("channel", interactive=False)
    result = []
    worker = threading.Thread(target=lambda: result.append(sender.send_message("전환 중")))
    worker.start()
    try:
        assert old.sending.wait(1)
        sender._loop.call_soon_threadsafe(old.released.set)
        assert current.started.wait(1)
        assert old.cancelled.wait(1)
        worker.join(1)
        assert result == [False]
        assert current.sent == []
    finally:
        sender.disconnect()
        worker.join(1)


def test_shutdown_interrupts_rate_limit_wait_without_sending(modules):
    client = Client()
    sender = connected_sender(modules, client)
    assert sender.send_message("첫 메시지")
    result = []
    worker = threading.Thread(target=lambda: result.append(sender.send_message("두 번째")))
    worker.start()
    started = time.monotonic()
    sender.disconnect()
    worker.join(1)
    assert time.monotonic() - started < 1
    assert result == [False]
    assert client.sent == ["첫 메시지"]


@pytest.mark.parametrize("change", ["expire", "mode"])
def test_freshness_guard_rechecks_after_rate_limit_wait(modules, monkeypatch, change):
    client = Client()
    sender = connected_sender(modules, client)
    clock = [19.5]
    pipeline = ResponsePipeline(max_age_seconds=20, clock=lambda: clock[0])
    candidate = ResponseCandidate("방금 질문", "현재 응답", "", 0, pipeline.generation)
    monkeypatch.setattr(modules[0], "time", types.SimpleNamespace(time=time.time, monotonic=lambda: clock[0]))
    sender._last_send_monotonic = clock[0]

    def wait(seconds):
        assert seconds == 2
        if change == "expire":
            clock[0] += seconds
        else:
            pipeline.switch_mode("mimic")
        return False

    monkeypatch.setattr(sender._stop_event, "wait", wait)
    try:
        assert pipeline.can_send(candidate)
        assert not sender.send_message(candidate.text, is_current=lambda: pipeline.can_send(candidate))
        assert client.sent == []
        assert sender.last_send_time == 0
    finally:
        sender.disconnect()


@pytest.mark.parametrize("change", ["expire", "mode"])
def test_freshness_guard_rechecks_on_worker_loop_before_server_call(modules, monkeypatch, change):
    client = Client()
    sender = connected_sender(modules, client)
    clock = [19.5]
    pipeline = ResponsePipeline(max_age_seconds=20, clock=lambda: clock[0])
    candidate = ResponseCandidate("방금 질문", "현재 응답", "", 0, pipeline.generation)
    schedule = asyncio.run_coroutine_threadsafe

    def schedule_after_change(coroutine, loop):
        # The two caller-thread checks passed, but this draft becomes stale
        # before the scheduled coroutine can begin on the connection thread.
        if change == "expire":
            clock[0] += 1
        else:
            pipeline.switch_mode("mimic")
        return schedule(coroutine, loop)

    monkeypatch.setattr(modules[0].asyncio, "run_coroutine_threadsafe", schedule_after_change)
    try:
        assert pipeline.can_send(candidate)
        assert not sender.send_message(candidate.text, is_current=lambda: pipeline.can_send(candidate))
        assert client.sent == []
        assert sender.last_send_time == 0
    finally:
        sender.disconnect()


def test_freshness_guard_allows_valid_delivery_and_fails_closed(modules):
    client = Client()
    sender = connected_sender(modules, client)
    try:
        assert not sender.send_message("실패한 검사", is_current=lambda: 1 / 0)
        assert sender.send_message("유효한 응답", is_current=lambda: True)
        assert client.sent == ["유효한 응답"]
    finally:
        sender.disconnect()


def test_stale_client_cannot_send_or_change_authentication(modules):
    sender = modules[0].ChatSender()
    old, new = Client(), Client()
    sender._register_sender_events(old, ChatReconnectPolicy())
    sender._client = new
    sender._running = True
    assert asyncio.run(sender._send_if_current(old, "오래된 연결")) is False
    asyncio.run(old.callbacks["on_connect"]())
    assert not sender.is_authenticated
    assert old.sent == []


def test_internal_socket_disconnect_disables_send_until_handshake(modules):
    client = Client()
    sender = connected_sender(modules, client)
    try:
        asyncio.run_coroutine_threadsafe(client.callbacks["on_disconnect"](), sender._loop).result(1)
        assert not sender.is_connected()
        assert not sender.send_message("재접속 중")
        assert sender.status == "reconnecting"
        asyncio.run_coroutine_threadsafe(client.callbacks["on_connect"](), sender._loop).result(1)
        assert sender.is_connected()
    finally:
        sender.disconnect()


def test_send_exception_does_not_expose_raw_network_error(modules, capsys):
    class FailingClient(Client):
        async def send_chat(self, text):
            raise RuntimeError("NID_AUT=private-test-value")

    sender = connected_sender(modules, FailingClient())
    try:
        assert not sender.send_message("테스트")
        assert "private-test-value" not in capsys.readouterr().out
    finally:
        sender.disconnect()


def test_reader_discards_events_from_old_clients(modules):
    reader = modules[1].ChatReader("channel")
    old, current = Client(), Client()
    reader._running = True
    reader._client = old
    reader._register_events(old, ChatReconnectPolicy())
    reader._client = current
    event = types.SimpleNamespace(profile=None, content="old")
    asyncio.run(old.callbacks["on_chat"](event))
    asyncio.run(old.callbacks["on_donation"](event))
    asyncio.run(old.callbacks["on_connect"]())
    assert list(reader.messages) == []
    assert list(reader.donations) == []
    assert reader.status == "idle"


def test_reader_stop_cancels_hanging_socket_and_is_idempotent(modules):
    reader = modules[1].ChatReader("channel")
    client = Client()
    reader._create_client = lambda: client
    reader.start()
    assert client.started.wait(1)
    reader.stop()
    reader.stop()
    assert client.closed.is_set()
    assert not reader._thread.is_alive()
    assert reader.status == "stopped"


def test_reader_normal_socket_return_reconnects(modules):
    reader = modules[1].ChatReader("channel")
    first, second = Client(return_immediately=True), Client()
    clients = iter((first, second))
    reader._create_client = lambda: next(clients)
    reader.start()
    try:
        assert second.started.wait(1)
        assert first.closed.is_set()
        assert reader.status == "connected"
    finally:
        reader.stop()


def test_reader_explicit_auth_failure_is_terminal_until_restarted(modules):
    reader = modules[1].ChatReader("channel")
    error_type = type("LoginRequired", (Exception,), {})
    attempts = []

    def create():
        attempts.append(1)
        raise error_type("expired")

    reader._create_client = create
    reader.start()
    assert until(lambda: not reader._thread.is_alive())
    assert reader.status == "auth_required"
    assert len(attempts) == 1
    assert not reader._running


def test_stop_interrupts_long_backoff_in_both_transports(modules, monkeypatch):
    for module in modules:
        monkeypatch.setattr(module, "ChatReconnectPolicy", lambda **kwargs: ChatReconnectPolicy(initial_delay=30, max_delay=30))
    sender = modules[0].ChatSender()
    sender._create_client = lambda: (_ for _ in ()).throw(ConnectionError("offline"))
    sender._running = True
    sender._thread = threading.Thread(target=sender._run)
    sender._thread.start()
    reader = modules[1].ChatReader("channel")
    reader._create_client = sender._create_client
    reader.start()
    try:
        assert until(lambda: sender.status == "reconnecting" and reader.status == "reconnecting")
        started = time.monotonic()
        sender.disconnect()
        reader.stop()
        assert time.monotonic() - started < 1
        assert not sender._thread.is_alive()
        assert not reader._thread.is_alive()
    finally:
        sender.disconnect()
        reader.stop()


def test_saved_cookies_are_upserted_when_keys_or_file_are_missing(modules, monkeypatch, tmp_path):
    from bot.settings import read_env_values
    path = tmp_path / ".env"
    monkeypatch.setattr(modules[0], "ENV_FILE", str(path))
    modules[0].ChatSender._save_cookies_to_env("first-auth", "first-session")
    assert read_env_values(path)["NID_AUT"] == "first-auth"
    path.write_text('# keep comment\nOLLAMA_MODEL="custom"\nNID_AUT="old"\n', encoding="utf-8")
    modules[0].ChatSender._save_cookies_to_env("second-auth", "second-session")
    values = read_env_values(path)
    assert values["NID_AUT"] == "second-auth"
    assert values["NID_SES"] == "second-session"
    assert values["OLLAMA_MODEL"] == "custom"
    assert "# keep comment" in path.read_text(encoding="utf-8")


def test_cookie_save_error_preserves_authenticated_session(modules, capsys):
    sender = modules[0].ChatSender()
    sender._save_cookies_to_env = lambda *_args: (_ for _ in ()).throw(OSError("read-only"))
    sender._remember_credentials("private-auth", "private-session")
    output = capsys.readouterr().out
    assert "저장하지 못했습니다" in output
    assert "private-" not in output


def test_mock_sender_supports_noninteractive_without_network(modules):
    sender = modules[0].MockChatSender()
    assert not sender.send_message("인증 전")
    assert sender.authenticate(interactive=False)
    assert sender.is_connected()
    assert not sender.send_message("오래된 응답", is_current=lambda: False)
    assert not sender.send_message("실패한 검사", is_current=lambda: 1 / 0)
    assert sender.send_message("로컬 출력")
    sender.disconnect()
    assert not sender.is_connected()


def test_shared_cleanup_cancels_unfinished_client_close():
    class HangingClose:
        async def close(self):
            await asyncio.Event().wait()

    loop = asyncio.new_event_loop()
    close_client(loop, HangingClose(), timeout=.01)
    close_loop(loop)
    assert loop.is_closed()


@pytest.mark.parametrize("window", [0, -1, True, "30", float("inf"), float("nan")])
def test_chat_rate_rejects_invalid_window(modules, window):
    with pytest.raises(ValueError):
        modules[1].ChatReader("channel").get_chat_rate(window)
