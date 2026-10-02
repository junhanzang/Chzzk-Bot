"""치지직 채팅 읽기 모듈 (chzzkpy unofficial ChatClient 사용)

채널 ID로 실시간 채팅 메시지를 수집합니다.
성인인증 채널은 NID_AUT/NID_SES 쿠키가 필요합니다.
"""
import time
import asyncio
import threading
import math
from collections import deque
from datetime import datetime

from chzzkpy.unofficial.chat import ChatClient, ChatMessage, DonationMessage
from bot.connection import cancel_connection, close_client, close_loop, is_authentication_error
from core_logic import ChatReconnectPolicy, extract_channel_id


class ChatReader:
    """치지직 채팅 읽기 클래스

    별도 스레드에서 비동기 ChatClient를 실행하여
    실시간 채팅 메시지를 수집합니다.
    """

    def __init__(self, channel_id: str, max_messages: int = 20,
                 nid_aut: str = "", nid_ses: str = ""):
        """
        Args:
            channel_id: 치지직 채널 ID (방송 URL에서 추출)
            max_messages: 보관할 최근 메시지 수
            nid_aut: 네이버 인증 쿠키 (성인인증 채널용)
            nid_ses: 네이버 세션 쿠키 (성인인증 채널용)
        """
        self.channel_id = channel_id
        self.messages = deque(maxlen=max_messages)
        self.donations = deque(maxlen=max_messages)
        self._thread = None
        self._loop = None
        self._client = None
        self._start_task = None
        self._running = False
        self._stop_event = threading.Event()
        self._credentials_lock = threading.Lock()
        self._nid_aut = nid_aut
        self._nid_ses = nid_ses
        self.status = "idle"
        self.last_error = ""

    def set_credentials(self, nid_aut: str, nid_ses: str):
        """인증 정보 업데이트 (성인인증 채널용, 다음 재연결 시 적용)"""
        with self._credentials_lock:
            self._nid_aut = nid_aut
            self._nid_ses = nid_ses

    def start(self):
        """채팅 리더 시작 (별도 스레드)"""
        if self._running or (self._thread and self._thread.is_alive()):
            return

        self._running = True
        self._stop_event.clear()
        self.status = "connecting"
        self.last_error = ""
        self._thread = threading.Thread(target=self._run_client, name="ChatReader", daemon=True)
        self._thread.start()
        print(f"채팅 리더 시작 (채널: {self.channel_id})")

    def _create_client(self) -> ChatClient:
        """현재 인증 정보로 새 ChatClient 생성 (재연결 시 채널 접속 상태 복구)"""
        with self._credentials_lock:
            nid_aut, nid_ses = self._nid_aut, self._nid_ses
        if nid_aut and nid_ses:
            return ChatClient(
                channel_id=self.channel_id,
                authorization_key=nid_aut,
                session_key=nid_ses,
            )
        return ChatClient(channel_id=self.channel_id)

    def _register_events(self, client, policy):
        # Each reconnect has its own closure: late events from an older socket
        # cannot enter the current conversation or reset the connection status.
        def is_current():
            return self._running and self._client is client

        @client.event
        async def on_chat(message: ChatMessage):
            if not is_current():
                return
            nickname = message.profile.nickname if message.profile else "???"
            self.messages.append({"nickname": nickname, "content": message.content,
                                  "time": self._message_time(message)})

        @client.event
        async def on_donation(message: DonationMessage):
            if not is_current():
                return
            nickname = message.profile.nickname if message.profile else "???"
            content = message.content or ""
            if content:
                self.donations.append({"nickname": nickname, "content": content,
                                       "time": self._message_time(message)})

        @client.event
        async def on_connect():
            if is_current():
                policy.on_connected()
                self.status = "connected"
                self.last_error = ""
                print("채팅 연결 성공! 메시지 수신 중...")

        @client.event
        async def on_disconnect():
            if is_current():
                self.status = "reconnecting"

    def _run_client(self):
        """별도 스레드에서 ChatClient 실행 (지수 백오프 자동 재연결)"""
        policy = ChatReconnectPolicy(initial_delay=3.0, max_delay=60.0)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop

        while self._running and policy.should_retry():
            client = None
            error = None
            try:
                client = self._create_client()
                self._client = client

                self._register_events(client, policy)

                # stop()이 while 조건 확인과 클라이언트 생성 사이에 호출될 수 있다.
                # 그 경우 새 네트워크 연결을 시작하지 않는다.
                if self._running:
                    task = loop.create_task(client.start())
                    self._start_task = task
                    if not self._running:
                        task.cancel()
                    loop.run_until_complete(task)

            except asyncio.CancelledError:
                pass
            except Exception as e:
                error = e

            self._start_task = None
            self._close_client(loop, client)
            if self._client is client:
                self._client = None
            if not self._running:
                break

            if error is not None and is_authentication_error(error):
                self.status = "auth_required"
                self.last_error = "채팅 읽기 로그인이 만료되었습니다. 다시 로그인해주세요."
                print(self.last_error)
                break

            delay = policy.on_disconnected()
            self.status = "reconnecting"
            if error is not None:
                self.last_error = "채팅 읽기 연결 오류. 자동으로 다시 연결합니다."
                print(f"채팅 읽기 연결 오류 ({delay:.0f}초 후 재연결...)")
            else:
                print(f"채팅 연결 끊김 ({delay:.0f}초 후 재연결...)")
            # stop() 호출 시 즉시 깨어나도록 Event로 대기
            self._stop_event.wait(delay)
            policy.on_retry()

        policy.on_stopped()
        close_loop(loop)
        self._running = False
        if self.status != "auth_required":
            self.status = "stopped"
        self._loop = None

    @staticmethod
    def _close_client(loop, client):
        close_client(loop, client)

    @staticmethod
    def _message_time(message):
        """chzzkpy의 msgTime/messageTime datetime을 epoch 초로 보관한다."""
        if not hasattr(message, "time"):
            # 구버전 메시지에 시각 필드가 없는 경우에만 수신 시각을 사용한다.
            return time.time()
        value = message.time
        if not isinstance(value, datetime) or value.tzinfo is None:
            return None
        try:
            timestamp = value.timestamp()
            return timestamp if math.isfinite(timestamp) else None
        except (ValueError, OverflowError, OSError):
            return None

    @staticmethod
    def _fresh_entries(entries, max_age_seconds=None):
        snapshot = list(entries)
        if max_age_seconds is None:
            return snapshot
        if (isinstance(max_age_seconds, bool) or not isinstance(max_age_seconds, (int, float))
                or not math.isfinite(max_age_seconds) or max_age_seconds < 0):
            raise ValueError("max_age_seconds must be a finite non-negative number")
        now = time.time()
        return [entry for entry in snapshot
                if isinstance(entry.get("time"), (int, float)) and not isinstance(entry["time"], bool)
                and math.isfinite(entry["time"]) and 0 <= now - entry["time"] <= max_age_seconds]

    def get_recent_messages(self, count: int = 10, *, max_age_seconds: float | None = None) -> list[dict]:
        """최근 채팅 메시지 반환"""
        messages = self._fresh_entries(self.messages, max_age_seconds)
        return messages[-count:] if count > 0 else []

    def get_recent_donations(self, count: int = 10, *, max_age_seconds: float | None = None) -> list[dict]:
        """최근 도네이션 메시지 반환"""
        donations = self._fresh_entries(self.donations, max_age_seconds)
        return donations[-count:] if count > 0 else []

    def get_chat_rate(self, window: int = 30) -> float:
        """최근 N초 동안의 채팅 속도 (메시지/분)"""
        if isinstance(window, bool) or not isinstance(window, (int, float)) or not math.isfinite(window) or window <= 0:
            raise ValueError("window must be a finite positive number")
        recent = self._fresh_entries(self.messages, window)
        return len(recent) / (window / 60)

    def get_chat_context(self, count: int = 10, filter_reactions: bool = False, *, max_age_seconds: float | None = None) -> str:
        """LLM 프롬프트용 채팅 컨텍스트 문자열 반환

        Args:
            count: 가져올 메시지 수
            filter_reactions: True이면 단순 반응(ㅋㅋ, ㅎㅎ 등) 제외
            max_age_seconds: 지정하면 이 시간 안의 채팅만 사용 (초)
        """
        # 오래된 메시지와 단순 반응을 먼저 거른 뒤 결과 개수를 제한한다.
        messages = self._fresh_entries(self.messages, max_age_seconds)
        if not messages or count <= 0:
            return "(채팅 없음)"

        lines = []
        for msg in messages:
            content = msg['content'].strip()
            if filter_reactions and self._is_noise(content):
                continue
            lines.append(f"{msg['nickname']}: {content}")
        if not lines:
            return "(채팅 없음)"
        return "\n".join(lines[-count:])

    @staticmethod
    def _is_noise(text: str) -> bool:
        """단순 반응/노이즈 채팅인지 판별"""
        text = text.strip()
        if not text or len(text) > 15:
            return False
        # 같은 문자 반복 (ㅋㅋㅋ, ㅎㅎ, ??)
        if len(set(text)) == 1 and len(text) >= 2:
            return True
        # 짧은 자모 (ㅇㅇ, ㄷㄷ, ㄹㅇ)
        import re
        if len(text) <= 3 and re.fullmatch(r'[ㄱ-ㅎㅏ-ㅣ]+', text):
            return True
        return False

    def stop(self):
        """채팅 리더 종료"""
        self._running = False
        self._stop_event.set()  # 백오프 대기 중이면 즉시 깨움
        if self.status != "auth_required":
            self.status = "stopping"
        cancel_connection(self._loop, self._start_task)
        if self._thread and self._thread is not threading.current_thread():
            self._thread.join(timeout=5)
        if (not self._thread or not self._thread.is_alive()) and self.status != "auth_required":
            self.status = "stopped"
        print("채팅 리더 종료")


if __name__ == "__main__":
    import time

    url = input("방송 URL 입력: ").strip()
    channel_id = extract_channel_id(url)
    print(f"채널 ID: {channel_id}")

    reader = ChatReader(channel_id)
    reader.start()

    try:
        while True:
            time.sleep(5)
            print(f"\n--- 최근 채팅 ({len(reader.messages)}개 수집) ---")
            print(reader.get_chat_context(5))
            print("---")
    except KeyboardInterrupt:
        reader.stop()
