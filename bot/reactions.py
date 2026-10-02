"""Recent donation matching and conservative crowd-reaction policy."""
import random
import time
from difflib import SequenceMatcher

from config import Config
from response_pipeline import ResponseCandidate


class ReactionPolicy:
    def __init__(self, bot):
        self.bot = bot
        self.last_sent = {}
        self.wave_cooldown = 60

    def is_tts_donation(self, text, threshold=0.4):
        """ASR 결과가 도네 TTS인지 도네이션/채팅 내용과 비교하여 판단

        Args:
            text: ASR로 인식된 텍스트
            threshold: 유사도 임계값 (0.0~1.0, 기본 0.4)

        Returns:
            bool: TTS 도네이션이면 True
        """
        bot = self.bot
        if not bot.chat_reader:
            return False

        text_clean = text.strip().lower()

        # 1차: 도네이션 메시지와 비교 (on_donation 이벤트로 수집)
        donations = bot.chat_reader.get_recent_donations(20, max_age_seconds=20)
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
        recent = bot.chat_reader.get_recent_messages(20, max_age_seconds=20)
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
    def vary(text: str) -> str:
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
    def is_simple(text):
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
    def kind(text: str) -> str:
        """반응의 종류 키 반환 (같은 문자 반복 → 대표 문자, 짧은 자모 → 원문)"""
        text = text.strip()
        if len(set(text)) == 1:
            return text[0]  # ㅋㅋㅋ → "ㅋ", ㅎㅎ → "ㅎ"
        return text  # ㄹㅇ → "ㄹㅇ", ㅇㅈ → "ㅇㅈ"

    def is_wave(self, target: str, threshold: int = 4, window: int = 10) -> bool:
        """최근 채팅에서 target과 같은 종류의 반응이 threshold개 이상이면 True"""
        bot = self.bot
        if not bot.chat_reader:
            return False
        target_type = bot._reaction_type(target)

        # 같은 종류 반응 쿨다운 체크 (연속 도배 방지)
        last_wave = self.last_sent.get(target_type)
        if last_wave is not None and time.monotonic() - last_wave < self.wave_cooldown:
            return False

        recent = bot.chat_reader.get_recent_messages(window, max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS)
        count = sum(
            1 for m in recent
            if bot._is_simple_reaction(m["content"])
            and bot._reaction_type(m["content"]) == target_type
        )
        print(f"[반응체크] '{target_type}' 최근 {len(recent)}개 중 {count}개 (기준: {threshold}개)")
        return count >= threshold

    def record_sent(self, target: str):
        """반응 따라하기 전송 후 쿨다운 기록"""
        self.last_sent[self.kind(target)] = time.monotonic()

    def latest(self):
        """Return the latest fresh message with its original timestamp."""
        bot = self.bot
        if not bot.chat_reader:
            return None
        recent = bot.chat_reader.get_recent_messages(1, max_age_seconds=Config.CHAT_CONTEXT_MAX_AGE_SECONDS)
        if not recent:
            return None
        return recent[-1]

    def run(self):
        """Offer fresh crowd reactions through the same send policy as AI."""
        bot = self.bot
        last_seen = None
        while not bot._stop_event.is_set():
            try:
                if bot.response_mode not in ("mimic", "hybrid"):
                    bot._stop_event.wait(0.5)
                    continue
                if bot._warmup_end_time and time.time() < bot._warmup_end_time:
                    bot._stop_event.wait(1)
                    continue
                generation = bot.pipeline.generation
                message = bot._get_mimic_response()
                if message:
                    identity = (message.get("time"), message.get("nickname"), message["content"])
                    response = message["content"]
                    if identity != last_seen and bot._is_simple_reaction(response) and bot._is_reaction_wave(response):
                        # Chat timestamps are wall time; preserve their age when
                        # crossing into the monotonic response policy.
                        age = time.time() - message["time"]
                        candidate = ResponseCandidate("(채팅 반응)", bot._vary_reaction(response), "",
                            time.monotonic() - age, generation, kind="mimic")
                        if bot.pipeline.can_send(candidate) and bot.pipeline.submit(candidate):
                            last_seen = identity
                            bot.stats["processed_speeches"] += 1
                            bot.metrics.increment("proposed")
                            print(f"[따라하기] 제안: {candidate.text}")
                bot._stop_event.wait(1)
            except Exception as e:
                if not bot._stop_event.is_set():
                    bot.metrics.increment("mimic_error")
                    print(f"\n[따라하기] 오류: {type(e).__name__}")
                    bot._stop_event.wait(1)
