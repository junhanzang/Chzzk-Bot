"""Authenticated chat delivery with reconnects and cancellable shutdown."""
import asyncio
import os
import threading
import time
from concurrent.futures import TimeoutError as FutureTimeout

from chzzkpy.unofficial.chat import ChatClient

from bot.connection import cancel_connection, close_client, close_loop, is_authentication_error
from config import Config
from core_logic import ChatReconnectPolicy

ENV_FILE = os.path.join(os.path.dirname(__file__), ".env")


def _guard_allows_send(is_current):
    if is_current is None:
        return True
    try:
        return bool(is_current())
    except Exception:
        # A failed freshness check must never grant permission to send.
        return False


class ChatSender:
    """Own one socket worker; never retry a message with an uncertain outcome."""

    CONNECT_TIMEOUT = 20.0
    SEND_TIMEOUT = 5.0
    MIN_SEND_INTERVAL = 2.0

    def __init__(self):
        self._client = None
        self._loop = None
        self._thread = None
        self._start_task = None
        self._lock = threading.RLock()
        self._send_lock = threading.Lock()
        self._send_tasks = set()
        self._stop_event = threading.Event()
        self._ready_event = threading.Event()
        self.is_authenticated = False
        self._running = False
        self.last_send_time = 0.0
        self._last_send_monotonic = None
        self._channel_id = ""
        self._nid_aut = ""
        self._nid_ses = ""
        self.status = "idle"
        self.last_error = ""

    @staticmethod
    def _login_via_browser() -> tuple[str, str]:
        # Import browser dependencies only for an explicitly interactive run.
        from bot.auth import login_via_browser
        try:
            return login_via_browser()
        except Exception:
            print("로그인 창을 열지 못했습니다. Chrome 설치 상태를 확인해주세요.")
            return "", ""

    @staticmethod
    def _save_cookies_to_env(nid_aut: str, nid_ses: str):
        from bot.setup import write_env_values
        write_env_values(ENV_FILE, {"NID_AUT": nid_aut, "NID_SES": nid_ses})
        print(".env에 쿠키 저장 완료 (다음부터 자동 로그인)")

    def _remember_credentials(self, nid_aut, nid_ses):
        try:
            self._save_cookies_to_env(nid_aut, nid_ses)
        except (OSError, ValueError):
            # The current session remains usable even if its file is read-only.
            print("로그인은 완료했지만 쿠키를 저장하지 못했습니다. 다음 실행에 다시 로그인해주세요.")

    def _try_connect(self, channel_id: str, nid_aut: str, nid_ses: str) -> bool:
        self.disconnect(quiet=True)
        if self._thread and self._thread.is_alive():
            self.last_error = "이전 연결이 종료되는 중입니다. 잠시 후 다시 시작해주세요."
            return False
        with self._lock:
            self._channel_id, self._nid_aut, self._nid_ses = channel_id, nid_aut, nid_ses
            self._stop_event.clear()
            self._ready_event.clear()
            self._running = True
            self.status = "connecting"
            self.last_error = ""
            self._thread = threading.Thread(target=self._run, name="ChatSender", daemon=True)
            self._thread.start()
        self._ready_event.wait(self.CONNECT_TIMEOUT)
        if self.is_connected():
            print("채팅 전송 연결 성공!")
            return True
        if not self.last_error:
            self.last_error = "채팅에 연결하지 못했습니다. 방송과 네트워크 상태를 확인해주세요."
        self.disconnect(quiet=True)
        return False

    def authenticate(self, channel_id: str, *, interactive: bool = True) -> bool:
        """Use saved cookies; only interactive runs can request browser login."""
        nid_aut, nid_ses = Config.NID_AUT, Config.NID_SES
        if not nid_aut or not nid_ses:
            if not interactive:
                self.status = "auth_required"
                self.last_error = "저장된 로그인 정보가 없습니다. 대화형 실행에서 먼저 로그인해주세요."
                print(self.last_error)
                return False
            nid_aut, nid_ses = self._login_via_browser()
            if not nid_aut or not nid_ses:
                self.status = "auth_required"
                self.last_error = "로그인에 실패했습니다."
                return False
            self._remember_credentials(nid_aut, nid_ses)

        if self._try_connect(channel_id, nid_aut, nid_ses):
            return True
        # Network outages and offline streams must not open a new login window.
        if not interactive or self.status != "auth_required":
            print(self.last_error)
            return False
        print("저장된 로그인이 만료되었습니다. 다시 로그인해주세요.")
        nid_aut, nid_ses = self._login_via_browser()
        if not nid_aut or not nid_ses:
            return False
        self._remember_credentials(nid_aut, nid_ses)
        return self._try_connect(channel_id, nid_aut, nid_ses)

    def _create_client(self):
        return ChatClient(channel_id=self._channel_id, authorization_key=self._nid_aut,
                          session_key=self._nid_ses)

    def _register_sender_events(self, client, policy):
        @client.event
        async def on_connect():
            with self._lock:
                if self._client is not client or self._stop_event.is_set():
                    return
                if not client.user_id:
                    self.is_authenticated = False
                    self.status = "auth_required"
                    self.last_error = "로그인이 만료되었습니다. 대화형 실행에서 다시 로그인해주세요."
                    self._running = False
                    self._stop_event.set()
                    cancel_connection(self._loop, self._start_task)
                else:
                    policy.on_connected()
                    self.is_authenticated = True
                    self.status = "connected"
                    self.last_error = ""
                self._ready_event.set()

        @client.event
        async def on_disconnect():
            with self._lock:
                if self._client is client:
                    self.is_authenticated = False
                    if not self._stop_event.is_set():
                        self.status = "reconnecting"

    def _run(self):
        policy = ChatReconnectPolicy(initial_delay=3.0, max_delay=30.0)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        with self._lock:
            self._loop = loop
        try:
            while not self._stop_event.is_set():
                client = None
                try:
                    client = self._create_client()
                    with self._lock:
                        self._client = client
                        self.is_authenticated = False
                    self._register_sender_events(client, policy)
                    if self._stop_event.is_set():
                        break
                    task = loop.create_task(client.start())
                    with self._lock:
                        self._start_task = task
                    if self._stop_event.is_set():
                        task.cancel()
                    loop.run_until_complete(task)
                except asyncio.CancelledError:
                    pass
                except Exception as error:
                    # Exceptions from network libraries may contain cookies/URLs.
                    if is_authentication_error(error):
                        self.status = "auth_required"
                        self.last_error = "로그인이 만료되었습니다. 대화형 실행에서 다시 로그인해주세요."
                        self._stop_event.set()
                        self._ready_event.set()
                    else:
                        self.last_error = "채팅 연결이 끊겼습니다. 자동으로 다시 연결합니다."
                finally:
                    with self._lock:
                        self.is_authenticated = False
                        self._start_task = None
                        if self._client is client:
                            self._client = None
                        pending_sends = tuple(self._send_tasks)
                    for pending in pending_sends:
                        pending.cancel()
                    close_client(loop, client)
                if self._stop_event.is_set():
                    break
                delay = policy.on_disconnected()
                self.status = "reconnecting"
                print(f"채팅 전송 연결 끊김 ({delay:.0f}초 후 재연결...)")
                if self._stop_event.wait(delay):
                    break
                policy.on_retry()
        finally:
            close_loop(loop)
            with self._lock:
                self._loop = None
                self._running = False
                self.is_authenticated = False
                if self.status != "auth_required":
                    self.status = "stopped"
                self._ready_event.set()

    async def _send_if_current(self, client, text, is_current=None):
        # Revalidate on the worker loop after scheduling, including reconnect races.
        with self._lock:
            if (self._client is not client or self._stop_event.is_set()
                    or not self.is_authenticated or not client.is_connected):
                return False
            task = asyncio.current_task()
            self._send_tasks.add(task)
        try:
            if not _guard_allows_send(is_current):
                return False
            await client.send_chat(text)
            return True
        finally:
            with self._lock:
                self._send_tasks.discard(task)

    def send_message(self, text: str, retry: int = 3, *, is_current=None) -> bool:
        """Send once, checking optional freshness after waiting and before I/O.

        ``retry`` remains accepted for older callers, but is unused.
        """
        if not text or not text.strip() or not _guard_allows_send(is_current):
            return False
        with self._send_lock:
            if not self.is_connected():
                return False
            if self._last_send_monotonic is not None:
                remaining = self.MIN_SEND_INTERVAL - (time.monotonic() - self._last_send_monotonic)
                if remaining > 0 and self._stop_event.wait(remaining):
                    return False
            if not _guard_allows_send(is_current):
                return False
            with self._lock:
                client, loop = self._client, self._loop
                if (not self.is_authenticated or self._stop_event.is_set() or not client
                        or not client.is_connected or loop is None or loop.is_closed()
                        or not loop.is_running()):
                    return False
            future = None
            coroutine = self._send_if_current(client, text, is_current)
            try:
                future = asyncio.run_coroutine_threadsafe(coroutine, loop)
                if not future.result(timeout=self.SEND_TIMEOUT):
                    return False
                self.last_send_time = time.time()
                self._last_send_monotonic = time.monotonic()
                self.last_error = ""
                print(f"채팅 전송: {text}")
                return True
            except FutureTimeout:
                future.cancel()
                # The server may already have received it. Do not duplicate it.
                self._last_send_monotonic = time.monotonic()
                self.last_error = "전송 확인 시간이 초과되어 취소했습니다. 같은 메시지는 자동 재전송하지 않습니다."
            except Exception:
                if future is not None:
                    future.cancel()
                else:
                    coroutine.close()
                self.last_error = "채팅을 전송하지 못했습니다. 연결 상태를 확인해주세요."
            print(self.last_error)
            return False

    def is_connected(self) -> bool:
        with self._lock:
            return bool(self.is_authenticated and not self._stop_event.is_set()
                        and self._client and self._client.is_connected)

    def disconnect(self, *, quiet=False):
        with self._lock:
            self._running = False
            self.is_authenticated = False
            self._stop_event.set()
            if self.status != "auth_required":
                self.status = "stopping"
            loop, task, thread = self._loop, self._start_task, self._thread
        cancel_connection(loop, task)
        if thread and thread is not threading.current_thread():
            thread.join(timeout=5)
        if (not thread or not thread.is_alive()) and self.status != "auth_required":
            self.status = "stopped"
        if not quiet:
            print("채팅 전송 종료")


class MockChatSender(ChatSender):
    """Local output only; no credentials or network client is needed."""

    def __init__(self):
        super().__init__()
        print("MockChatSender 사용 중 (실제 메시지는 전송되지 않음)")

    def authenticate(self, channel_id: str = "", *, interactive: bool = True) -> bool:
        self.is_authenticated = True
        self._stop_event.clear()
        self.status = "connected"
        print("Mock 인증 성공")
        return True

    def send_message(self, text: str, retry: int = 3, *, is_current=None) -> bool:
        if (not self.is_authenticated or not text or not text.strip()
                or not _guard_allows_send(is_current)):
            return False
        print(f"[MOCK 전송] {text}")
        self.last_send_time = time.time()
        return True

    def is_connected(self) -> bool:
        return self.is_authenticated

    def disconnect(self, *, quiet=False):
        self.is_authenticated = False
        self._stop_event.set()
        self.status = "stopped"
        if not quiet:
            print("Mock 채팅 종료")
