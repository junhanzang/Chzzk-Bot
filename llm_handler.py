import os
import requests
import threading
from collections import deque
from config import Config
from core_logic import build_llm_messages, guard_chat_message, postprocess_llm_response


class LLMHandler:
    """Ollama 기반 LLM 처리 클래스"""

    def __init__(self, model_name=None, host=None, context_size=5, chat_log_path=None,
                 banned_words=None):
        """
        Args:
            model_name: Ollama 모델 이름
            host: Ollama 서버 호스트
            context_size: 유지할 대화 컨텍스트 크기
            chat_log_path: 내 채팅 로그 파일 경로 (스타일 학습용)
            banned_words: 금칙어 목록 (None이면 Config.BANNED_WORDS 사용)
        """
        self.model_name = model_name or Config.OLLAMA_MODEL
        self.host = host or Config.OLLAMA_HOST
        self.api_url = f"{self.host}/api/chat"
        self.context = deque(maxlen=context_size)
        self._context_lock = threading.Lock()
        self.banned_words = tuple(banned_words) if banned_words is not None else Config.BANNED_WORDS
        self.recent_responses = deque(maxlen=10)
        self.my_chat_examples = self._load_chat_log(chat_log_path)
        self.system_prompt = self._get_system_prompt()

    def _load_chat_log(self, path):
        """내 채팅 로그 파일 로드 (한 줄에 하나씩)"""
        if not path or not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                lines = [line.strip() for line in f if line.strip()]
            if lines:
                print(f"내 채팅 로그 로드: {len(lines)}개")
            return lines
        except Exception as e:
            print(f"채팅 로그 로드 실패: {e}")
            return []

    def _get_system_prompt(self):
        """시스템 프롬프트 생성"""
        base = """너는 치지직 방송 시청자야. 채팅창에 한 줄만 친다.

핵심 규칙:
- 스트리머가 한 말의 내용에 직접 반응해 (무슨 말인지 잘 듣고 거기에 맞게)
- 다른 시청자들이 치는 채팅 분위기에 맞춰서 써
- 매번 다른 표현을 써 (같은 말 반복 금지)
- 한국어, 반말, 50자 이내
- 채팅 메시지만 출력 (설명이나 부연 금지)

나쁜 예 (하지 마):
- 아무 말에나 "ㅋㅋㅋ" "끝내줘" 붙이기
- 스트리머 말 앵무새처럼 따라하기
- 맥락 없이 "진짜?" "대박" 같은 빈 리액션"""

        # 내 채팅 로그가 있으면 스타일 학습 예시로 추가
        if self.my_chat_examples:
            import random
            samples = random.sample(self.my_chat_examples, min(20, len(self.my_chat_examples)))
            base += "\n\n내가 평소에 치는 채팅 스타일 (이 말투와 분위기를 따라해):\n"
            base += "\n".join(f"- {s}" for s in samples)
        else:
            base += """

좋은 예:
스트리머: "이 맵 진짜 어렵다" → 거기 왼쪽으로 가보세요
스트리머: "드디어 끝났다" → 수고하셨습니다 ㅎㅎ
스트리머: "어 이게 뭐지" → 뭔가 이상한데
스트리머: "오늘 몇 시까지 해요?" → 끝까지 달려주세요"""

        return base

    def check_connection(self):
        """Ollama 서버 연결 확인"""
        try:
            response = requests.get(f"{self.host}/api/tags", timeout=5)
            if response.status_code == 200:
                models = response.json().get('models', [])
                model_names = [m['name'] for m in models]

                if self.model_name in model_names or any(self.model_name in name for name in model_names):
                    print(f"Ollama 연결 성공 (모델: {self.model_name})")
                    return True
                else:
                    print(f"모델 '{self.model_name}'을 찾을 수 없습니다.")
                    print(f"사용 가능한 모델: {', '.join(model_names)}")
                    return False
            return False
        except requests.exceptions.RequestException as e:
            print(f"Ollama 서버 연결 실패: {e}")
            print(f"Ollama가 실행 중인지 확인하세요: {self.host}")
            return False

    def add_to_context(self, role, text):
        """
        대화 컨텍스트에 추가

        Args:
            role: 역할 (streamer, bot)
            text: 발화 내용
        """
        with self._context_lock:
            self.context.append({"role": role, "text": text})

    def _build_messages(self, streamer_speech, chat_context="",
                        streamer_memory="", chat_memory="", my_chat_memory=""):
        """
        Chat API용 메시지 리스트 생성

        Returns:
            list[dict]: [{"role": "system"|"user"|"assistant", "content": ...}]
        """
        with self._context_lock:
            history = list(self.context)
        return build_llm_messages(
            self.system_prompt, streamer_speech, history=history,
            chat_context=chat_context, streamer_memory=streamer_memory,
            chat_memory=chat_memory, my_chat_memory=my_chat_memory,
        )

    def generate_response(self, streamer_speech, chat_context="",
                          streamer_memory="", chat_memory="", my_chat_memory=""):
        """
        스트리머 발언에 대한 응답 생성

        Returns:
            str: 생성된 응답 (실패 시 None)
        """
        if not streamer_speech or not streamer_speech.strip():
            return None

        try:
            messages = self._build_messages(
                streamer_speech, chat_context,
                streamer_memory, chat_memory, my_chat_memory
            )

            payload = {
                "model": self.model_name,
                "messages": messages,
                "stream": False,
                "think": False,
                "keep_alive": Config.OLLAMA_KEEP_ALIVE,
                "options": {
                    "temperature": 0.9,
                    "top_p": 0.9,
                    "repeat_penalty": 1.3,
                    "num_predict": Config.LLM_MAX_TOKENS,
                    "num_ctx": Config.LLM_NUM_CTX
                }
            }

            response = requests.post(
                self.api_url,
                json=payload,
                timeout=30
            )

            if response.status_code == 200:
                result = response.json()
                raw_text = result.get("message", {}).get("content", "").strip()

                if not raw_text:
                    print(f"[LLM] 빈 응답 수신")
                    return None

                # 응답 후처리
                generated_text = self._postprocess_response(raw_text)

                if not generated_text:
                    print(f"[LLM] 후처리 후 빈 응답 (원본: {raw_text[:80]})")
                    return None

                # 전송 전 안전 가드 (반복/금칙어/길이/잔여 따옴표)
                generated_text = self._apply_safety_guard(generated_text)

                if not generated_text:
                    print(f"[LLM] 안전 가드에 걸러진 응답 (원본: {raw_text[:80]})")
                    return None

                # 컨텍스트에 추가
                self.add_to_context("streamer", streamer_speech)
                self.add_to_context("bot", generated_text)

                return generated_text
            else:
                print(f"LLM 응답 실패: {response.status_code}")
                return None

        except requests.exceptions.Timeout:
            print("LLM 응답 시간 초과")
            return None
        except Exception as e:
            print(f"LLM 응답 생성 실패: {e}")
            return None

    def _postprocess_response(self, text):
        """생성된 응답 후처리"""
        return postprocess_llm_response(text)

    def _apply_safety_guard(self, text):
        """전송 전 안전 가드. 통과한 메시지는 최근 응답 기록에 추가된다."""
        with self._context_lock:
            guarded = guard_chat_message(
                text,
                recent_messages=self.recent_responses,
                banned_words=self.banned_words,
            )
            if guarded:
                self.recent_responses.append(guarded)
        return guarded

    def should_respond(self, streamer_speech, chat_context=""):
        """스마트 응답: 이 발화에 응답할지 LLM이 판단

        Returns:
            bool: 응답해야 하면 True
        """
        messages = [
            {"role": "system", "content": "너는 치지직 채팅 시청자야. 스트리머가 말한 내용을 보고, 시청자로서 채팅을 칠 만한 상황인지 판단해. YES 또는 NO만 답해."},
            {"role": "user", "content": f"스트리머: \"{streamer_speech}\"\n{f'현재 채팅: {chat_context}' if chat_context else ''}\n\n채팅을 쳐야 하면 YES, 굳이 안 쳐도 되면 NO만 답해.\n(혼잣말, 단순 조작, 의미없는 소리 등은 NO)"}
        ]

        try:
            payload = {
                "model": self.model_name,
                "messages": messages,
                "stream": False,
                "think": False,
                "keep_alive": Config.OLLAMA_KEEP_ALIVE,
                "options": {
                    "temperature": 0.3,
                    "num_predict": 5,
                    "num_ctx": Config.LLM_NUM_CTX
                }
            }
            response = requests.post(self.api_url, json=payload, timeout=10)
            if response.status_code == 200:
                answer = response.json().get("message", {}).get("content", "")
                return "YES" in answer.strip().upper()
        except Exception:
            pass
        return True  # 판단 실패 시 응답

    def clear_context(self):
        """대화 컨텍스트 초기화"""
        with self._context_lock:
            self.context.clear()


def test_llm():
    """LLM 연결 및 응답 생성 테스트"""
    handler = LLMHandler()

    print("Ollama 연결 테스트 중...")
    if not handler.check_connection():
        print("\n테스트 실패: Ollama에 연결할 수 없습니다.")
        return

    print("\n응답 생성 테스트:")
    print("=" * 50)

    test_speeches = [
        "오늘 날씨 진짜 좋네요",
        "이거 어떻게 깨지?",
        "오늘 방송 재미있나요?",
    ]

    for speech in test_speeches:
        print(f"\n스트리머: {speech}")
        response = handler.generate_response(speech)
        if response:
            print(f"봇: {response}")
        else:
            print("응답 생성 실패")

    print("\n" + "=" * 50)
