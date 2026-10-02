"""Bot lifecycle and final-send boundary; adapters are loaded by BotSession."""
import os
import queue
import threading
import time

from config import Config
from core_logic import approval_action
from response_pipeline import ResponsePipeline, SpeechContext
from bot.reactions import ReactionPolicy
from bot.session import BotServices, BotSession, SessionSetupError
from bot.workers import SpeechWorkers


MODE_LABELS = {"ai": "AI", "mimic": "따라하기", "hybrid": "하이브리드"}


class ChzzkVoiceBot:
    """A single session, with injectable adapters and shared send policy."""

    def __init__(self, use_mock=False, auto_send=False, *, channel_id=None,
                 speaker_id=None, non_interactive=False, mode=None, metrics=None,
                 services=None):
        self.channel_id = channel_id
        self.speaker_id = speaker_id or getattr(Config, "AUDIO_SPEAKER_ID", "")
        self.non_interactive = non_interactive
        self.use_mock = use_mock
        self.auto_send = auto_send or (non_interactive and use_mock)
        self.audio_capture = self.speech_recognizer = self.llm_handler = None
        self.chat_sender = self.chat_reader = None
        self.streamer_memory = self.chat_memory = self.my_chat_memory = None
        self.memory_manager = None
        self.speech_queue = queue.Queue(maxsize=1)
        self.pipeline = ResponsePipeline(mode=mode or Config.RESPONSE_MODE,
            max_age_seconds=Config.RESPONSE_MAX_AGE_SECONDS,
            cooldown_seconds=Config.RESPONSE_COOLDOWN)
        self.speech_context = SpeechContext(max_age_seconds=Config.SPEECH_CONTEXT_MAX_AGE_SECONDS)
        self._stop_event = threading.Event()
        self._resource_lock = threading.RLock()
        self._stop_lock = threading.Lock()
        self._stopped = self._started = self._initialized = False
        self._threads = []
        self._asr_thread = self._llm_thread = self._mimic_thread = self._key_thread = None
        self.last_response_time = 0
        self._cooldown_lock = threading.Lock()
        self._warmup_end_time = 0
        self.stats = {"processed_speeches": 0, "sent_messages": 0, "start_time": None}
        if metrics is None:
            from bot.telemetry import SessionMetrics
            metrics = SessionMetrics()
        self.metrics = metrics
        self.workers = SpeechWorkers(self)
        self.reactions = ReactionPolicy(self)
        self.session = BotSession(self, services or BotServices())

    @property
    def response_mode(self):
        return self.pipeline.mode

    def initialize(self):
        """Initialize once; cleanup is guaranteed even on partial failure."""
        if self._stopped:
            raise RuntimeError("종료한 봇은 다시 시작할 수 없습니다. 새 세션을 만들어주세요.")
        if self._initialized:
            return True
        try:
            print("\n치지직 채팅 봇 준비 중...")
            with self._resource_lock:
                self._initialized = bool(self.session.initialize())
            if not self._initialized:
                self.stop()
            return self._initialized
        except BaseException:
            self.stop()
            raise

    def start(self):
        """Run one session, closing resources on initialization or loop failure."""
        if self._started or self._stopped:
            raise RuntimeError("봇 세션은 한 번만 시작할 수 있습니다.")
        try:
            if not self.initialize():
                print("초기화 실패.")
                return False
            print(f"\n봇 시작 · {MODE_LABELS[self.response_mode]} 모드 · Ctrl+C로 종료")
            if self.auto_send and not self.non_interactive and os.name == "nt":
                print("m키로 모드 전환 · h키로 연결 상태와 처리 현황 확인")
            self.print_status()
            self.stats["start_time"] = time.time()
            self._warmup_end_time = time.time() + Config.WARMUP_SECONDS if Config.WARMUP_SECONDS else 0
            if Config.WARMUP_SECONDS:
                print(f"[워밍업] {Config.WARMUP_SECONDS}초 동안 관찰합니다.")
            self._started = True
            if self.audio_capture is not None:
                self.audio_capture.start()
            for attr, target, name in (
                ("_asr_thread", self.workers.asr_loop, "ASR-Worker"),
                ("_llm_thread", self.workers.llm_loop, "LLM-Worker"),
                ("_mimic_thread", self.reactions.run, "Mimic-Worker"),
            ):
                self._start_thread(attr, target, name)
            if self.auto_send and not self.non_interactive and os.name == "nt":
                self._start_thread("_key_thread", self._key_listener, "Key-Listener")
            self._response_handler()
            return True
        except KeyboardInterrupt:
            print("\n종료 요청을 받았습니다.")
            return True
        except Exception as error:
            self.metrics.increment("session_error")
            detail = str(error) if isinstance(error, SessionSetupError) else f"{type(error).__name__}: --doctor로 실행 환경을 확인하세요."
            print(f"[실행 실패] {detail}")
            return False
        finally:
            self.stop()

    def _start_thread(self, attr, target, name):
        thread = threading.Thread(target=target, name=name, daemon=True)
        setattr(self, attr, thread)
        self._threads.append(thread)
        thread.start()

    def _cycle_mode(self):
        mode_order = ("ai", "hybrid", "mimic")
        old = self.response_mode
        new = mode_order[(mode_order.index(old) + 1) % len(mode_order)]
        if self._stop_event.is_set():
            return
        # Mode changes in an uninitialized offline bot still exercise policy.
        if self._initialized and new != "mimic" and not self.session.speech_ready:
            try:
                if not self.session.ensure_speech():
                    return
            except Exception as error:
                self.metrics.increment("mode_error")
                detail = str(error) if isinstance(error, SessionSetupError) else f"{type(error).__name__}: --doctor로 실행 환경을 확인하세요."
                print(f"[모드 전환 실패] {detail}")
                return
        if self._stop_event.is_set():
            return
        self.pipeline.switch_mode(new)
        print(f"\n[모드] {MODE_LABELS[old]} → {MODE_LABELS[new]}")

    def _can_send(self, candidate):
        if self._stop_event.is_set() or not self.pipeline.is_current(candidate):
            self.metrics.increment("fresh_expired")
            return False
        if not self.pipeline.can_send(candidate):
            self.metrics.increment("cooldown")
            return False
        return True

    def _process_candidate(self, candidate):
        """Approve, revalidate and record only the message actually sent."""
        if not self._can_send(candidate):
            print("[응답] 만료 또는 전송 간격으로 건너뛰었어요.")
            return False
        response = candidate.text
        if not self.auto_send:
            if self.non_interactive:
                self.metrics.increment("skipped")
                return False
            choice = input(f"[{MODE_LABELS[self.response_mode]}] [{response}] Enter=전송 / s=스킵 / e=수정 / m=모드전환: ").strip().lower()
            action = approval_action(choice)
            if action == "mode":
                self._cycle_mode()
                self.metrics.increment("skipped")
                return False
            if action == "skip":
                self.metrics.increment("skipped")
                return False
            if action == "edit":
                response = input("수정 메시지: ").strip()
        response = self.llm_handler.validate_response(response)
        if not response:
            self.metrics.increment("invalid_response")
            return False
        if not self._can_send(candidate):
            return False
        if not self.chat_sender.send_message(response, is_current=lambda:
                not self._stop_event.is_set() and self.pipeline.can_send(candidate)):
            self.metrics.increment("send_failed")
            return False
        self.pipeline.record_sent(candidate)
        self.llm_handler.record_sent_response(candidate.speech if candidate.kind == "ai" else "", response)
        self.stats["sent_messages"] += 1
        self.metrics.increment("sent")
        with self._cooldown_lock:
            self.last_response_time = time.monotonic()
        if candidate.kind == "mimic":
            self.reactions.record_sent(candidate.text)
        elif self.memory_manager:
            self.memory_manager.record_interaction(candidate.speech, response, candidate.chat_context)
        return True

    def _response_handler(self):
        while not self._stop_event.is_set():
            try:
                candidate = self.pipeline.take(timeout=1.0)
                if candidate is not None:
                    self._process_candidate(candidate)
            except EOFError:
                print("입력이 닫혔습니다. 자동 실행에는 --non-interactive --auto를 사용하세요.")
                break
            except Exception as error:
                if not self._stop_event.is_set():
                    self.metrics.increment("response_error")
                    print(f"[응답] 오류: {type(error).__name__}")
                    self._stop_event.wait(1)

    def _key_listener(self):
        import msvcrt
        while not self._stop_event.is_set():
            try:
                if msvcrt.kbhit():
                    key = msvcrt.getch().decode("utf-8", errors="ignore").lower()
                    if key == "m":
                        self._cycle_mode()
                    elif key == "h":
                        self.print_status()
            except Exception:
                self.metrics.increment("key_error")
            self._stop_event.wait(0.1)

    def status_snapshot(self):
        """Observable state for CLI or future UI, containing no source text."""
        return {
            "mode": self.response_mode,
            "status": "stopped" if self._stopped else "running" if self._started else "ready" if self._initialized else "idle",
            "reader": getattr(self.chat_reader, "status", "idle"),
            "sender": "mock" if self.use_mock else getattr(self.chat_sender, "status", "idle"),
            "counts": self.metrics.snapshot(),
        }

    def print_status(self):
        labels = {"idle": "대기", "connecting": "연결 중", "connected": "연결됨",
                  "reconnecting": "재연결 중", "auth_required": "로그인 필요",
                  "stopping": "종료 중", "stopped": "종료됨", "mock": "미리보기"}
        state = self.status_snapshot()
        print(f"[상태] 수신 {labels.get(state['reader'], '확인 중')} · 전송 {labels.get(state['sender'], '확인 중')} · {self.metrics.summary()}")

    def stop(self):
        """Idempotent best-effort cleanup: one broken adapter cannot leak others."""
        with self._stop_lock:
            if self._stopped:
                return
            self._stopped = True
        self._stop_event.set()
        self.pipeline.close()

        def cleanup(label, action):
            try:
                action()
            except BaseException as error:
                self.metrics.increment("cleanup_error")
                print(f"[종료] {label} 정리 실패: {type(error).__name__}")

        # Serialize with lazy mode setup so no new audio resource starts after stop.
        with self._resource_lock:
            for label, resource, method in (
                ("오디오", self.audio_capture, "stop"),
                ("채팅 수신", self.chat_reader, "stop"),
                ("채팅 전송", self.chat_sender, "disconnect"),
            ):
                if resource is not None:
                    cleanup(label, lambda resource=resource, method=method: getattr(resource, method)())
        for thread in self._threads:
            if thread is not threading.current_thread() and thread.is_alive():
                cleanup(thread.name, lambda thread=thread: thread.join(timeout=3))
        if self.memory_manager is not None:
            cleanup("메모리 갱신", self.memory_manager.force_update)
            cleanup("메모리 저장", self.memory_manager.save_all)
        print(f"[세션 요약] {self.metrics.summary()}")

    # Preserve extension/testing entry points while implementations belong to
    # composed workers/policies rather than a growing runtime class.
    def _asr_worker(self):
        return self.workers.asr_loop()

    def _observe_speech(self, observation):
        return self.workers.observe_speech(observation)

    def _drain_speech_queue(self):
        return self.workers.drain_speech_queue()

    def _generate_candidate(self, observation):
        return self.workers.generate_candidate(observation)

    def _is_tts_donation(self, text, threshold=0.4):
        return self.reactions.is_tts_donation(text, threshold)

    _is_simple_reaction = staticmethod(ReactionPolicy.is_simple)
    _vary_reaction = staticmethod(ReactionPolicy.vary)
    _reaction_type = staticmethod(ReactionPolicy.kind)

    def _is_reaction_wave(self, target, threshold=4, window=10):
        return self.reactions.is_wave(target, threshold, window)

    def _get_mimic_response(self):
        return self.reactions.latest()
