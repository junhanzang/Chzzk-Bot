import warnings
import logging
# aiohttp/chzzkpy 내부 리소스 정리 경고 억제 (재연결 시 불가피하게 발생)
warnings.filterwarnings("ignore", category=ResourceWarning)
warnings.simplefilter("ignore", ResourceWarning)
logging.getLogger("asyncio").setLevel(logging.CRITICAL)

import os
import time
import signal
import sys
import queue
import random
import threading
from difflib import SequenceMatcher
from config import Config
from audio_capture import AudioCapture, select_speaker
from speech_recognition import SpeechRecognizer
from llm_handler import LLMHandler
from chat_sender import ChatSender, MockChatSender
from chat_reader import ChatReader, extract_channel_id
from memory.memory_store import MemoryStore
from memory.memory_manager import MemoryManager
from core_logic import approval_action
from response_pipeline import ResponsePipeline, ResponseCandidate, SpeechObservation, SpeechContext


class ChzzkVoiceBot:
    """치지직 음성인식 자동 채팅 봇

    파이프라인 (각 단계가 독립 스레드로 동작):
    1. AudioCapture 스레드: 시스템 오디오 루프백 → audio_queue
    2. ASR Worker 스레드: audio_queue → 음성인식 → speech_queue
    3. LLM Worker 스레드: speech_queue → 응답 생성 → ResponsePipeline
    4. Main 스레드: 최신 제안 → 승인/전송/실제 전송 기록
    5. ChatReader 스레드: WebSocket → 실시간 채팅 수집
    """

    def __init__(self, use_mock=False, auto_send=False):
        self.audio_capture: AudioCapture | None = None
        self.speech_recognizer = SpeechRecognizer()
        self.llm_handler: LLMHandler | None = None  # initialize에서 채널별 채팅 로그와 함께 생성
        self.chat_sender = MockChatSender() if use_mock else ChatSender()
        self.chat_reader: ChatReader | None = None

        # 메모리 시스템 (initialize에서 channel_id 확정 후 초기화)
        self.streamer_memory: MemoryStore | None = None
        self.chat_memory: MemoryStore | None = None
        self.my_chat_memory: MemoryStore | None = None
        self.memory_manager: MemoryManager | None = None

        # 파이프라인 큐
        self.speech_queue = queue.Queue(maxsize=1)  # latest ASR target only
        self.pipeline = ResponsePipeline(mode=Config.RESPONSE_MODE,
            max_age_seconds=Config.RESPONSE_MAX_AGE_SECONDS,
            cooldown_seconds=Config.RESPONSE_COOLDOWN)
        self.speech_context = SpeechContext(max_age_seconds=Config.SPEECH_CONTEXT_MAX_AGE_SECONDS)

        # 스레드 제어
        self._stop_event = threading.Event()
        self._asr_thread = None
        self._llm_thread = None
        self._mimic_thread = None

        # 쿨다운 (LLM worker + main thread 공유)
        self.last_response_time = 0
        self._cooldown_lock = threading.Lock()
        self._last_reaction_wave_time: dict[str, float] = {}  # 반응 종류별 마지막 따라하기 시각
        self._reaction_wave_cooldown = 60  # 같은 반응 따라하기 쿨다운 (초)

        self.use_mock = use_mock
        self.auto_send = auto_send
        self._warmup_end_time = 0  # start()에서 설정

        self.stats = {
            "processed_speeches": 0,
            "sent_messages": 0,
            "start_time": None
        }

    @property
    def response_mode(self):
        return self.pipeline.mode

    def initialize(self):
        """초기화"""
        print("\n" + "=" * 60)
        print("  치지직 음성인식 자동 채팅 봇")
        print("=" * 60)

        # [1] 방송 URL 입력
        default_id = Config.CHZZK_CHANNEL_ID or ""
        print("\n[1/5] 방송 URL 입력")
        url = input(f"치지직 방송 URL (Enter: .env 기본값): ").strip()
        if url:
            channel_id = extract_channel_id(url)
        elif default_id:
            channel_id = default_id
        else:
            print("URL이 입력되지 않았습니다.")
            return False
        print(f"채널 ID: {channel_id}")

        # 채널별 메모리 초기화
        data_dir = os.path.join(os.path.dirname(__file__), "data", channel_id)
        self.streamer_memory = MemoryStore(
            os.path.join(data_dir, "streamer_memory.json"), max_facts=5
        )
        self.chat_memory = MemoryStore(
            os.path.join(data_dir, "chat_memory.json"), max_facts=4
        )
        self.my_chat_memory = MemoryStore(
            os.path.join(data_dir, "my_chat_memory.json"), max_facts=4
        )
        self.memory_manager = MemoryManager(
            self.streamer_memory, self.chat_memory, self.my_chat_memory
        )
        if not self.streamer_memory.is_empty():
            print(f"  기존 메모리 로드됨 (스트리머: {len(self.streamer_memory.get_facts())}개)")

        # LLM 핸들러 초기화 (채널별 채팅 로그 경로 포함)
        chat_log_path = os.path.join(data_dir, "my_chats.txt")
        self.llm_handler = LLMHandler(chat_log_path=chat_log_path)

        # [2] 채팅 리더 시작 (실시간 채팅 수집)
        print("\n[2/5] 채팅 리더 시작...")
        self.chat_reader = ChatReader(
            channel_id,
            nid_aut=Config.NID_AUT,
            nid_ses=Config.NID_SES,
        )
        self.chat_reader.start()
        time.sleep(3)  # 연결 대기

        # [3] ASR + Ollama 체크
        print("\n[3/5] ASR 모델 로딩...")
        try:
            self.speech_recognizer.load_model()
        except Exception as e:
            print(f"ASR 모델 로딩 실패: {e}")
            return False

        print("\n[4/5] Ollama 연결 확인...")
        if not self.llm_handler.check_connection():
            return False

        # [4] 스피커 선택
        print("\n[5/5] 오디오 + 채팅 설정...")
        print("브라우저에서 방송 소리가 나오고 있어야 합니다!")
        speaker = select_speaker()
        self.audio_capture = AudioCapture(speaker=speaker)

        # [5] 채팅 인증 (Mock이 아닐 때만)
        if not self.use_mock:
            if not self.chat_sender.authenticate(channel_id):
                return False
            # 새로 획득한 쿠키를 ChatReader에도 전달 (성인인증 채널용)
            if self.chat_sender._nid_aut and self.chat_reader:
                self.chat_reader.set_credentials(
                    self.chat_sender._nid_aut,
                    self.chat_sender._nid_ses,
                )

        print("\n초기화 완료!")
        return True

    def start(self):
        """봇 실행"""
        if not self.initialize():
            print("\n초기화 실패.")
            return

        mode_labels = {"ai": "AI", "mimic": "따라하기", "hybrid": "하이브리드"}
        mode_label = mode_labels.get(self.response_mode, self.response_mode)
        print("\n" + "=" * 60)
        print("  봇 시작! (동시성 파이프라인)")
        print(f"  현재 모드: {mode_label} (m키로 전환)")
        print("  ASR ─→ 응답 ─→ 전송 각각 독립 동작")
        print("  Ctrl+C로 종료")
        print("=" * 60 + "\n")

        self.stats["start_time"] = time.time()
        self._stop_event.clear()

        # 워밍업 설정
        if Config.WARMUP_SECONDS > 0:
            self._warmup_end_time = time.time() + Config.WARMUP_SECONDS
            print(f"  [워밍업] {Config.WARMUP_SECONDS}초 동안 관찰 모드...")
        else:
            self._warmup_end_time = 0

        # 오디오 캡처 시작 (기존 스레드)
        assert self.audio_capture is not None
        assert self.llm_handler is not None
        assert self.streamer_memory is not None
        assert self.chat_memory is not None
        assert self.my_chat_memory is not None
        assert self.memory_manager is not None
        self.audio_capture.start()

        # 워커 스레드 시작
        self._asr_thread = threading.Thread(
            target=self._asr_worker, name="ASR-Worker", daemon=True
        )
        self._llm_thread = threading.Thread(
            target=self._llm_worker, name="LLM-Worker", daemon=True
        )
        self._mimic_thread = threading.Thread(
            target=self._mimic_worker, name="Mimic-Worker", daemon=True
        )
        self._asr_thread.start()
        self._llm_thread.start()
        self._mimic_thread.start()

        # 자동 모드일 때 키 입력 리스너 (m키로 모드 전환)
        if self.auto_send:
            self._key_thread = threading.Thread(
                target=self._key_listener, name="Key-Listener", daemon=True
            )
            self._key_thread.start()

        # 메인 스레드에서 응답 처리
        try:
            self._response_handler()
        except KeyboardInterrupt:
            print("\n\n종료...")
        finally:
            self.stop()

    def _is_tts_donation(self, text, threshold=0.4):
        """ASR 결과가 도네 TTS인지 도네이션/채팅 내용과 비교하여 판단

        Args:
            text: ASR로 인식된 텍스트
            threshold: 유사도 임계값 (0.0~1.0, 기본 0.4)

        Returns:
            bool: TTS 도네이션이면 True
        """
        if not self.chat_reader:
            return False

        text_clean = text.strip().lower()

        # 1차: 도네이션 메시지와 비교 (on_donation 이벤트로 수집)
        donations = self.chat_reader.get_recent_donations(20, max_age_seconds=20)
        for msg in donations:
            donate_text = msg["content"].strip().lower()
            if len(donate_text) < 3:
                continue
            ratio = SequenceMatcher(None, text_clean, donate_text).ratio()
            if ratio > threshold:
                print(f"[ASR] TTS 도네 감지 (도네 유사도 {ratio:.0%}): {donate_text[:30]}")
                return True
            # 부분 포함 체크 (ASR이 도네 텍스트의 일부만 인식한 경우)
            if len(donate_text) >= 10 and donate_text in text_clean:
                print(f"[ASR] TTS 도네 감지 (부분 일치): {donate_text[:30]}")
                return True
            if len(text_clean) >= 10 and text_clean in donate_text:
                print(f"[ASR] TTS 도네 감지 (부분 일치): {donate_text[:30]}")
                return True

        # 2차: 일반 채팅과도 비교 (도네가 채팅에도 표시되는 경우)
        recent = self.chat_reader.get_recent_messages(20, max_age_seconds=20)
        for msg in recent:
            chat_text = msg["content"].strip().lower()
            if len(chat_text) < 5:
                continue
            ratio = SequenceMatcher(None, text_clean, chat_text).ratio()
            if ratio > 0.5:
                print(f"[ASR] TTS 도네 감지 (채팅 유사도 {ratio:.0%}): {chat_text[:30]}")
                return True
        return False

    @staticmethod
    def _vary_reaction(text: str) -> str:
        """반복 문자 개수를 랜덤하게 변형 (봇처럼 안 보이게)

        예: ㅋㅋㅋㅋㅋㅋㅋ → ㅋㅋㅋㅋㅋ
        """
        text = text.strip()
        if len(text) < 2:
            return text

        # 같은 문자 반복만 변형 (ㅋㅋㅋㅋ → ㅋㅋㅋㅋㅋ)
        if len(set(text)) == 1:
            n = len(text)
            if n <= 3:
                variation = random.randint(-1, 1)
            else:
                # 4자 이상: 반드시 변형 (0 제외)
                variation = random.choice([-3, -2, -1, 1, 2, 3])
            new_count = max(2, n + variation)
            return text[0] * new_count

        return text

    @staticmethod
    def _is_simple_reaction(text):
        """채팅이 단순 반응인지 판별 - 안전하게 따라칠 수 있는 것만"""
        text = text.strip()
        if not text or len(text) > 15:
            return False
        # 같은 문자 반복 (ㅋㅋㅋ, ㅎㅎ, ??, ..)
        if len(set(text)) == 1 and len(text) >= 2:
            return text[0] in "ㅋㅎㅠㅜ?!"
        # 짧은 자모 (2~3자): ㅇㅇ, ㄷㄷ, ㄹㅇ, ㅇㅈ
        return text in {"ㅇㅇ", "ㄷㄷ", "ㄹㅇ", "ㅇㅈ"}

    @staticmethod
    def _reaction_type(text: str) -> str:
        """반응의 종류 키 반환 (같은 문자 반복 → 대표 문자, 짧은 자모 → 원문)"""
        text = text.strip()
        if len(set(text)) == 1:
            return text[0]  # ㅋㅋㅋ → "ㅋ", ㅎㅎ → "ㅎ"
        return text  # ㄹㅇ → "ㄹㅇ", ㅇㅈ → "ㅇㅈ"

    def _is_reaction_wave(self, target: str, threshold: int = 4, window: int = 10) -> bool:
        """최근 채팅에서 target과 같은 종류의 반응이 threshold개 이상이면 True"""
        if not self.chat_reader:
            return False
        target_type = self._reaction_type(target)

        # 같은 종류 반응 쿨다운 체크 (연속 도배 방지)
        last_wave = self._last_reaction_wave_time.get(target_type, 0)
        if time.monotonic() - last_wave < self._reaction_wave_cooldown:
            return False

        recent = self.chat_reader.get_recent_messages(window, max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS)
        count = sum(
            1 for m in recent
            if self._is_simple_reaction(m["content"])
            and self._reaction_type(m["content"]) == target_type
        )
        print(f"[반응체크] '{target_type}' 최근 {len(recent)}개 중 {count}개 (기준: {threshold}개)")
        return count >= threshold

    def _mark_reaction_wave_sent(self, target: str):
        """반응 따라하기 전송 후 쿨다운 기록"""
        target_type = self._reaction_type(target)
        self._last_reaction_wave_time[target_type] = time.monotonic()

    def _cycle_mode(self):
        """모드 순환: ai → hybrid → mimic → ai"""
        mode_order = ["ai", "hybrid", "mimic"]
        mode_labels = {"ai": "AI", "hybrid": "하이브리드", "mimic": "따라하기"}
        idx = mode_order.index(self.response_mode) if self.response_mode in mode_order else 0
        old = self.response_mode
        self.pipeline.switch_mode(mode_order[(idx + 1) % len(mode_order)])
        print(f"\n  [모드] {mode_labels.get(old, old)} → {mode_labels.get(self.response_mode, self.response_mode)}")

    def _get_mimic_response(self):
        """Return the latest fresh message with its original timestamp."""
        if not self.chat_reader:
            return None
        recent = self.chat_reader.get_recent_messages(1, max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS)
        if not recent:
            return None
        return recent[-1]

    def _mimic_worker(self):
        """Offer fresh crowd reactions through the same send policy as AI."""
        last_seen = None
        while not self._stop_event.is_set():
            try:
                if self.response_mode not in ("mimic", "hybrid"):
                    self._stop_event.wait(0.5)
                    continue
                if self._warmup_end_time and time.time() < self._warmup_end_time:
                    self._stop_event.wait(1)
                    continue
                generation = self.pipeline.generation
                message = self._get_mimic_response()
                if message:
                    identity = (message.get("time"), message.get("nickname"), message["content"])
                    response = message["content"]
                    if identity != last_seen and self._is_simple_reaction(response) and self._is_reaction_wave(response):
                        # Chat timestamps are wall time; preserve their age when
                        # crossing into the monotonic response policy.
                        age = time.time() - message["time"]
                        candidate = ResponseCandidate("(채팅 반응)", self._vary_reaction(response), "",
                            time.monotonic() - age, generation, kind="mimic")
                        if self.pipeline.can_send(candidate) and self.pipeline.submit(candidate):
                            last_seen = identity
                            self.stats["processed_speeches"] += 1
                            print(f"[따라하기] 제안: {candidate.text}")
                self._stop_event.wait(1)
            except Exception as e:
                if not self._stop_event.is_set():
                    print(f"\n[따라하기] 오류: {e}")
                    self._stop_event.wait(1)

    def _asr_worker(self):
        """ASR 워커 스레드: 오디오 → 음성인식 → speech_queue"""
        assert self.audio_capture is not None
        while not self._stop_event.is_set():
            try:
                # 1. 오디오 청크 수집
                generation = self.pipeline.generation
                captured = self.audio_capture.get_audio_chunk(timeout=1.0, with_timestamp=True)
                if captured is None:
                    continue
                audio_data, observed_at = captured

                # 2. 소리 감지
                if not self.audio_capture.is_speech_present(audio_data):
                    continue

                print("\n[ASR] 음성 감지됨, 인식 중...")

                # 3. 음성 인식
                text = self.speech_recognizer.transcribe(audio_data)
                if not text:
                    print("[ASR] 인식 실패")
                    continue

                print(f"[ASR] 스트리머: {text}")

                # 4. 유효성 검증
                if not self.speech_recognizer.is_valid_speech(text):
                    print("[ASR] 무효한 발화 (무시)")
                    continue

                # 5. TTS 도네이션 필터
                if self._is_tts_donation(text):
                    continue

                # 6. speech_queue에 전달
                self._observe_speech(SpeechObservation(text, observed_at, generation))

            except Exception as e:
                if not self._stop_event.is_set():
                    print(f"\n[ASR] 오류: {e}")
                    time.sleep(1)

    def _observe_speech(self, observation):
        """Retain surrounding speech even when its response target is skipped."""
        if self._stop_event.is_set() or observation.generation != self.pipeline.generation:
            return
        self.speech_context.observe(observation)
        try:
            self.speech_queue.put_nowait(observation)
        except queue.Full:
            try:
                self.speech_queue.get_nowait()
            except queue.Empty:
                pass
            self.speech_queue.put_nowait(observation)

    def _drain_speech_queue(self):
        """Return the latest observation; earlier speech stays in SpeechContext."""
        text = self.speech_queue.get(timeout=1.0)
        skipped = 0
        while not self.speech_queue.empty():
            try:
                text = self.speech_queue.get_nowait()
                skipped += 1
            except queue.Empty:
                break
        if skipped > 0:
            print(f"[LLM] {skipped}개 이전 발화 스킵, 최신 처리: {text.text[:20]}")
        return text

    def _generate_candidate(self, observation):
        """Generate a draft from a fresh observation, retaining prior context."""
        text = observation.text
        if not self.pipeline.accepts(observation.observed_at, observation.generation):
            return None
        if self._warmup_end_time and time.time() < self._warmup_end_time:
            return None
        chat_rate = self.chat_reader.get_chat_rate(30) if self.chat_reader else 0
        cooldown = Config.RESPONSE_COOLDOWN * (3 if chat_rate > 20 else 2 if chat_rate > 10 else 1)
        with self._cooldown_lock:
            if self.last_response_time and time.monotonic() - self.last_response_time < cooldown:
                return None
        if Config.RESPONSE_CHANCE < 1.0 and random.random() > Config.RESPONSE_CHANCE:
            return None
        chat_context = self.chat_reader.get_chat_context(10, filter_reactions=True,
            max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS) if self.chat_reader else ""
        if Config.SMART_RESPONSE and not self.llm_handler.should_respond(text, chat_context):
            return None
        # The optional judge is another model call; it must not renew the input's age.
        if not self.pipeline.accepts(observation.observed_at, observation.generation):
            return None
        self.stats["processed_speeches"] += 1
        response = self.llm_handler.generate_response(
            text, chat_context,
            streamer_memory=self.streamer_memory.get_facts_as_prompt(),
            chat_memory=self.chat_memory.get_facts_as_prompt(),
            my_chat_memory=self.my_chat_memory.get_facts_as_prompt(),
            speech_context=self.speech_context.recent(observation),
        )
        if not response:
            print("[LLM] 응답 생략 또는 생성 실패")
            return None
        if self._is_simple_reaction(response):
            return None
        candidate = ResponseCandidate(text, response, chat_context,
            observation.observed_at, observation.generation)
        if not self.pipeline.is_current(candidate):
            print("[LLM] 오래되었거나 모드가 바뀐 제안은 버렸어요.")
            return None
        return candidate

    def _llm_worker(self):
        """Latest ASR target to a bounded, shared AI/reaction proposal slot."""
        while not self._stop_event.is_set():
            try:
                observation = self._drain_speech_queue()
                candidate = self._generate_candidate(observation)
                if candidate and self.pipeline.submit(candidate):
                    print(f"[LLM] 제안: {candidate.text}")
            except queue.Empty:
                continue
            except Exception as error:
                if not self._stop_event.is_set():
                    print(f"[LLM] 오류: {error}")
                    self._stop_event.wait(1)

    def _process_candidate(self, candidate):
        """Approve, revalidate and record only the message actually sent."""
        if self._stop_event.is_set() or not self.pipeline.can_send(candidate):
            print("[응답] 오래된 제안 또는 전송 간격 미충족: 건너뜀")
            return False
        response = candidate.text
        if not self.auto_send:
            mode_labels = {"ai": "AI", "mimic": "따라하기", "hybrid": "하이브리드"}
            mode_label = mode_labels.get(self.response_mode, self.response_mode)
            choice = input(f"  [{mode_label}] [{response}] Enter=전송 / s=스킵 / e=수정 / m=모드전환: ").strip().lower()
            action = approval_action(choice)
            if action == "mode":
                self._cycle_mode()
                return False
            if action == "skip":
                return False
            if action == "edit":
                response = input("  수정 메시지: ").strip()
        response = self.llm_handler.validate_response(response)
        # Approval and editing can take a long time. Neither makes the original
        # moment new again, and all response paths use the same final guard.
        if not response or self._stop_event.is_set() or not self.pipeline.can_send(candidate):
            print("[응답] 만료·중복·금칙어 또는 전송 간격으로 건너뛰었어요.")
            return False
        if not self.chat_sender.send_message(response):
            return False
        self.pipeline.record_sent(candidate)
        self.llm_handler.record_sent_response(candidate.speech if candidate.kind == "ai" else "", response)
        self.stats["sent_messages"] += 1
        with self._cooldown_lock:
            self.last_response_time = time.monotonic()
        if candidate.kind == "mimic":
            self._mark_reaction_wave_sent(candidate.text)
        # A crowd reaction is not a streamer utterance. Don't teach fabricated
        # streamer facts from the marker used for a reaction proposal.
        if candidate.kind == "ai":
            self.memory_manager.record_interaction(candidate.speech, response, candidate.chat_context)
        return True

    def _response_handler(self):
        """Consume one proposal at a time; waiting proposals are coalesced."""
        while not self._stop_event.is_set():
            try:
                candidate = self.pipeline.take(timeout=1.0)
                if candidate is not None:
                    self._process_candidate(candidate)
            except Exception as error:
                if not self._stop_event.is_set():
                    print(f"[응답] 오류: {error}")
                    self._stop_event.wait(1)

    def _key_listener(self):
        """자동 모드용 키 입력 리스너 (m키로 모드 전환)"""
        import msvcrt
        while not self._stop_event.is_set():
            try:
                if msvcrt.kbhit():
                    key = msvcrt.getch().decode("utf-8", errors="ignore").lower()
                    if key == "m":
                        self._cycle_mode()
                time.sleep(0.1)
            except Exception:
                time.sleep(0.1)

    def stop(self):
        """종료"""
        self._stop_event.set()
        self.pipeline.close()

        if self.audio_capture:
            self.audio_capture.stop()
        if self.chat_reader:
            self.chat_reader.stop()
        if self.chat_sender:
            self.chat_sender.disconnect()

        # 워커 스레드 종료 대기
        if self._asr_thread and self._asr_thread.is_alive():
            self._asr_thread.join(timeout=3)
        if self._llm_thread and self._llm_thread.is_alive():
            self._llm_thread.join(timeout=3)
        if self._mimic_thread and self._mimic_thread.is_alive():
            self._mimic_thread.join(timeout=3)

        # No new proposal can be accepted or sent after shutdown begins.
        if self.memory_manager:
            print("메모리 저장 중...")
            self.memory_manager.force_update()
            self.memory_manager.save_all()
            print("메모리 저장 완료")

        if self.stats["start_time"]:
            runtime = time.time() - self.stats["start_time"]
            print(f"\n  실행: {time.strftime('%H:%M:%S', time.gmtime(runtime))}")
            print(f"  처리: {self.stats['processed_speeches']}개")
            print(f"  전송: {self.stats['sent_messages']}개")


def main():
    signal.signal(signal.SIGINT, lambda s, f: sys.exit(0))

    use_mock = "--mock" in sys.argv
    auto_send = "--auto" in sys.argv

    if use_mock:
        print("\n[Mock 모드] 채팅은 콘솔에만 출력됩니다.\n")
    if not auto_send:
        print("[수동 모드] 메시지 전송 전 확인합니다. (--auto로 자동 전송)\n")

    bot = ChzzkVoiceBot(use_mock=use_mock, auto_send=auto_send)
    bot.start()


if __name__ == "__main__":
    main()
