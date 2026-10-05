"""Speech capture and response generation workers, independent of lifecycle setup."""
import queue
import random
import time

from config import Config
from response_pipeline import ResponseCandidate, SpeechObservation


class SpeechWorkers:
    def __init__(self, bot):
        self.bot = bot

    def asr_loop(self):
        """ASR 워커 스레드: 오디오 → 음성인식 → speech_queue"""
        bot = self.bot
        while not bot._stop_event.is_set():
            try:
                if bot.audio_capture is None or bot.response_mode == "mimic":
                    bot._stop_event.wait(0.5)
                    continue
                # 1. 오디오 청크 수집
                generation = bot.pipeline.generation
                captured = bot.audio_capture.get_audio_chunk(timeout=1.0, with_timestamp=True)
                if captured is None:
                    continue
                audio_data, observed_at = captured

                # 2. 소리 감지
                if not bot.audio_capture.is_speech_present(audio_data):
                    continue

                print("\n[ASR] 음성 감지됨, 인식 중...")

                # 3. 음성 인식
                text = bot.speech_recognizer.transcribe(audio_data)
                if not text:
                    print("[ASR] 인식 실패")
                    continue

                print(f"[ASR] 스트리머: {text}")

                # 4. 유효성 검증
                if not bot.speech_recognizer.is_valid_speech(text):
                    print("[ASR] 무효한 발화 (무시)")
                    continue

                # 5. TTS 도네이션 필터
                if bot._is_tts_donation(text):
                    continue

                # 6. speech_queue에 전달
                bot._observe_speech(SpeechObservation(text, observed_at, generation))

            except Exception as e:
                if not bot._stop_event.is_set():
                    bot.metrics.increment("asr_error")
                    print(f"\n[ASR] 오류: {type(e).__name__}")
                    bot._stop_event.wait(1)

    def observe_speech(self, observation):
        """Retain surrounding speech even when its response target is skipped."""
        bot = self.bot
        if bot._stop_event.is_set() or observation.generation != bot.pipeline.generation:
            return
        bot.metrics.increment("observed")
        bot.speech_context.observe(observation)
        try:
            bot.speech_queue.put_nowait(observation)
        except queue.Full:
            try:
                bot.speech_queue.get_nowait()
            except queue.Empty:
                pass
            bot.speech_queue.put_nowait(observation)

    def drain_speech_queue(self):
        """Return the latest observation; earlier speech stays in SpeechContext."""
        bot = self.bot
        text = bot.speech_queue.get(timeout=1.0)
        skipped = 0
        while not bot.speech_queue.empty():
            try:
                text = bot.speech_queue.get_nowait()
                skipped += 1
            except queue.Empty:
                break
        if skipped > 0:
            print(f"[LLM] {skipped}개 이전 발화 스킵, 최신 처리: {text.text[:20]}")
        return text

    def generate_candidate(self, observation):
        """Generate a draft from a fresh observation, retaining prior context."""
        bot = self.bot
        text = observation.text
        if not bot.pipeline.accepts(observation.observed_at, observation.generation):
            bot.metrics.increment("fresh_expired")
            return None
        if bot._warmup_end_time and time.time() < bot._warmup_end_time:
            bot.metrics.increment("warmup")
            return None
        chat_rate = bot.chat_reader.get_chat_rate(30) if bot.chat_reader else 0
        cooldown = Config.RESPONSE_COOLDOWN * (3 if chat_rate > 20 else 2 if chat_rate > 10 else 1)
        with bot._cooldown_lock:
            if bot.last_response_time and time.monotonic() - bot.last_response_time < cooldown:
                bot.metrics.increment("cooldown")
                return None
        if Config.RESPONSE_CHANCE < 1.0 and random.random() > Config.RESPONSE_CHANCE:
            bot.metrics.increment("skipped")
            return None
        chat_context = bot.chat_reader.get_chat_context(10, filter_reactions=True,
            max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS) if bot.chat_reader else ""
        memories = {
            "streamer_memory": bot.streamer_memory.get_facts_as_prompt(),
            "chat_memory": bot.chat_memory.get_facts_as_prompt(),
            "my_chat_memory": bot.my_chat_memory.get_facts_as_prompt(),
        }
        speech_context = bot.speech_context.recent(observation)
        # Context collection and inference share the original observation's TTL.
        # Participation and wording are decided in one request with the same context.
        remaining = bot.pipeline.max_age_seconds - (time.monotonic() - observation.observed_at)
        if remaining <= 0:
            bot.metrics.increment("fresh_expired")
            return None
        if not bot.pipeline.accepts(observation.observed_at, observation.generation):
            bot.metrics.increment("fresh_expired")
            return None
        bot.stats["processed_speeches"] += 1
        result = bot.llm_handler.generate_result(
            text, chat_context,
            **memories,
            speech_context=speech_context,
            timeout_seconds=min(30.0, remaining),
        )
        if result.status != "generated":
            metric, message = {
                "skipped": ("skipped", "이 발화에는 반응하지 않기로 했어요."),
                "filtered": ("invalid_response", "응답이 전송 전 필터에 걸렸어요."),
                "error": ("generation_failed", "응답 생성에 실패했어요."),
            }.get(result.status, ("generation_failed", "응답 결과 형식이 올바르지 않아요."))
            bot.metrics.increment(metric)
            print(f"[LLM] {message}")
            return None
        response = result.response
        if not response:
            bot.metrics.increment("generation_failed")
            print("[LLM] 생성 결과에 응답이 없어요.")
            return None
        if bot._is_simple_reaction(response):
            bot.metrics.increment("skipped")
            return None
        candidate = ResponseCandidate(text, response, chat_context,
            observation.observed_at, observation.generation)
        if not bot.pipeline.is_current(candidate):
            bot.metrics.increment("fresh_expired")
            print("[LLM] 오래되었거나 모드가 바뀐 제안은 버렸어요.")
            return None
        return candidate

    def llm_loop(self):
        """Latest ASR target to a bounded, shared AI/reaction proposal slot."""
        bot = self.bot
        while not bot._stop_event.is_set():
            try:
                observation = bot._drain_speech_queue()
                candidate = bot._generate_candidate(observation)
                if candidate and bot.pipeline.submit(candidate):
                    bot.metrics.increment("proposed")
                    print(f"[LLM] 제안: {candidate.text}")
            except queue.Empty:
                continue
            except Exception as error:
                if not bot._stop_event.is_set():
                    bot.metrics.increment("llm_error")
                    print(f"[LLM] 오류: {type(error).__name__}")
                    bot._stop_event.wait(1)
