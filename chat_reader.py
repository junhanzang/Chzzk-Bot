"""치지직 채팅 읽기 모듈 (chzzkpy unofficial ChatClient 사용)

채널 ID로 실시간 채팅 메시지를 수집합니다.
성인인증 채널은 NID_AUT/NID_SES 쿠키가 필요합니다.
"""
import time
import asyncio
import threading
from collections import deque

from chzzkpy.unofficial.chat import ChatClient, ChatMessage, DonationMessage
from core_logic import extract_channel_id


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
        self._running = False
        self._nid_aut = nid_aut
        self._nid_ses = nid_ses

    def set_credentials(self, nid_aut: str, nid_ses: str):
        """인증 정보 업데이트 (성인인증 채널용, 다음 재연결 시 적용)"""
        self._nid_aut = nid_aut
        self._nid_ses = nid_ses

    def start(self):
        """채팅 리더 시작 (별도 스레드)"""
        if self._running:
            return

        self._running = True
        self._thread = threading.Thread(target=self._run_client, daemon=True)
        self._thread.start()
        print(f"채팅 리더 시작 (채널: {self.channel_id})")

    def _run_client(self):
        """별도 스레드에서 ChatClient 실행 (자동 재연결)"""
        retry_delay = 3
        max_delay = 30

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop

        while self._running:
            client = None
            try:
                if self._nid_aut and self._nid_ses:
                    client = ChatClient(
                        channel_id=self.channel_id,
                        authorization_key=self._nid_aut,
                        session_key=self._nid_ses,
                    )
                else:
                    client = ChatClient(channel_id=self.channel_id)
                self._client = client

                @client.event
                async def on_chat(message: ChatMessage):
                    nickname = message.profile.nickname if message.profile else "???"
                    self.messages.append({
                        "nickname": nickname,
                        "content": message.content,
                        "time": time.time(),
                    })

                @client.event
                async def on_donation(message: DonationMessage):
                    nickname = message.profile.nickname if message.profile else "???"
                    content = message.content or ""
                    if content:
                        self.donations.append({
                            "nickname": nickname,
                            "content": content,
                        })

                @client.event
                async def on_connect():
                    nonlocal retry_delay
                    retry_delay = 3  # 성공 시 딜레이 초기화
                    print("채팅 연결 성공! 메시지 수신 중...")

                loop.run_until_complete(client.start())

            except Exception as e:
                if not self._running:
                    break
                print(f"채팅 리더 오류: {e} ({retry_delay}초 후 재연결...)")
                # 클라이언트만 정리 (루프가 돌고 있으면 건너뜀)
                if client and not loop.is_running():
                    try:
                        loop.run_until_complete(client.close())
                    except Exception:
                        pass
                    try:
                        loop.run_until_complete(asyncio.sleep(0.1))
                    except Exception:
                        pass
                time.sleep(retry_delay)
                retry_delay = min(retry_delay * 2, max_delay)
            else:
                # start()가 정상 종료된 경우 (연결 끊김)
                if client and not loop.is_running():
                    try:
                        loop.run_until_complete(client.close())
                    except Exception:
                        pass
                    try:
                        loop.run_until_complete(asyncio.sleep(0.1))
                    except Exception:
                        pass

        # 스레드 종료 시 루프 정리
        try:
            loop.close()
        except Exception:
            pass

    def get_recent_messages(self, count: int = 10) -> list[dict]:
        """최근 채팅 메시지 반환"""
        messages = list(self.messages)
        return messages[-count:]

    def get_recent_donations(self, count: int = 10) -> list[dict]:
        """최근 도네이션 메시지 반환"""
        donations = list(self.donations)
        return donations[-count:]

    def get_chat_rate(self, window: int = 30) -> float:
        """최근 N초 동안의 채팅 속도 (메시지/분)"""
        now = time.time()
        cutoff = now - window
        recent = [m for m in self.messages if m.get("time", 0) > cutoff]
        return len(recent) / (window / 60)

    def get_chat_context(self, count: int = 10, filter_reactions: bool = False) -> str:
        """LLM 프롬프트용 채팅 컨텍스트 문자열 반환

        Args:
            count: 가져올 메시지 수
            filter_reactions: True이면 단순 반응(ㅋㅋ, ㅎㅎ 등) 제외
        """
        messages = self.get_recent_messages(count * 2 if filter_reactions else count)
        if not messages:
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
        # 클라이언트를 닫아서 start()를 종료시킴
        if self._client and self._loop and not self._loop.is_closed():
            try:
                asyncio.run_coroutine_threadsafe(
                    self._client.close(), self._loop
                ).result(timeout=3)
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=5)
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
