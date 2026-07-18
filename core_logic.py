"""Standard-library-only business logic for the Chzzk voice bot."""

import re
from difflib import SequenceMatcher
from urllib.parse import urlparse


def extract_channel_id(url_or_id: str) -> str:
    """Extract a channel id from a Chzzk URL or return an already bare id."""
    value = (url_or_id or "").strip().rstrip("/")
    if not value:
        return ""
    parsed = urlparse(value)
    path = parsed.path if parsed.scheme or parsed.netloc else value
    parts = [part for part in path.split("/") if part]
    return parts[-1] if parts else ""


def build_llm_messages(system_prompt, streamer_speech, *, history=(),
                       chat_context="", streamer_memory="", chat_memory="",
                       my_chat_memory=""):
    """Build Ollama Chat API messages without performing I/O."""
    messages = [{"role": "system", "content": system_prompt}]
    user_parts = []
    memory_section = []
    if streamer_memory:
        memory_section.append(f"스트리머 특징:\n{streamer_memory}")
    if chat_memory:
        memory_section.append(f"채팅 분위기:\n{chat_memory}")
    if my_chat_memory:
        memory_section.append(f"내 응답 패턴:\n{my_chat_memory}")
    if memory_section:
        user_parts.extend(("[참고 정보]", "\n".join(memory_section)))
    if chat_context:
        user_parts.extend(("현재 채팅창 분위기:", chat_context))
    history = list(history)
    if history:
        user_parts.append("대화 히스토리:")
        for item in history:
            role_name = "스트리머" if item["role"] == "streamer" else "나"
            user_parts.append(f"{role_name}: {item['text']}")
    user_parts.append(f'스트리머가 방금 한 말: "{streamer_speech}"')
    user_parts.append("이 말에 대한 채팅 한 줄 (다른 시청자 채팅과 겹치지 않게):")
    messages.append({"role": "user", "content": "\n".join(user_parts)})
    return messages


def postprocess_llm_response(text, max_length=50):
    """Clean an LLM response into the single Korean chat line to send."""
    if not text:
        return None
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()
    text = re.sub(r"<think>.*", "", text, flags=re.DOTALL).strip()
    text = text.split("\n")[0].strip()
    text = re.sub(r'"\s*(which|translat|meaning|seems|or\s+"|that|this|the|but|so|and|is|I |it |not|look)\b.*',
                  "", text, flags=re.IGNORECASE).strip()
    korean_match = re.search(r"[가-힣ㄱ-ㅎㅏ-ㅣ]", text)
    if korean_match and korean_match.start() > 0:
        text = text[korean_match.start():]
    elif not korean_match:
        return None
    text = re.sub(r"[\u2E80-\u9FFF\u3040-\u309F\u30A0-\u30FF]", "", text).strip()
    text = re.sub(r"\s+[a-zA-Z][\w\s]*$", "", text).strip()
    text = re.sub(r"^(응답:\s*|Response:\s*)", "", text).strip()
    text = text.strip("\"'")
    text = text[:max_length]
    return text if len(text) >= 2 else None


# 치지직 일반 채팅 입력 상한 (자)
CHZZK_CHAT_MAX_LENGTH = 100

_QUOTE_CHARS = "\"'`“”‘’「」『』«»"


def parse_banned_words(raw):
    """Parse a comma/newline separated banned-word setting into a tuple."""
    words = []
    for part in re.split(r"[,\n]", raw or ""):
        word = part.strip()
        if word and word.lower() not in (w.lower() for w in words):
            words.append(word)
    return tuple(words)


def clean_chat_message(text):
    """Strip surrounding whitespace and stray quote characters."""
    return (text or "").strip(_QUOTE_CHARS + " \t\r\n　")


def contains_banned_word(text, banned_words):
    """Case-insensitive substring check against a banned-word list."""
    lowered = (text or "").lower()
    return bool(lowered) and any(
        word.strip() and word.strip().lower() in lowered
        for word in banned_words
    )


def _normalize_for_similarity(text):
    """Lowercase, drop whitespace, collapse character runs (ㅋㅋㅋ == ㅋㅋ)."""
    collapsed = re.sub(r"\s+", "", (text or "").lower())
    return re.sub(r"(.)\1+", r"\1", collapsed)


def is_repetitive_message(text, recent_messages, similarity_threshold=0.8):
    """True if text is identical or too similar to any recent message."""
    norm = _normalize_for_similarity(text)
    if not norm:
        return False
    for previous in recent_messages:
        prev_norm = _normalize_for_similarity(previous)
        if not prev_norm:
            continue
        if norm == prev_norm:
            return True
        if SequenceMatcher(None, norm, prev_norm).ratio() >= similarity_threshold:
            return True
    return False


def guard_chat_message(text, *, recent_messages=(), banned_words=(),
                       max_length=CHZZK_CHAT_MAX_LENGTH, similarity_threshold=0.8):
    """Final safety guard for an outgoing chat message.

    Returns the cleaned message to send, or None if it must be dropped.
    """
    cleaned = clean_chat_message(text)
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length].rstrip()
    if not cleaned:
        return None
    if contains_banned_word(cleaned, banned_words):
        return None
    if is_repetitive_message(cleaned, recent_messages, similarity_threshold):
        return None
    return cleaned


class ChatReconnectPolicy:
    """Pure reconnect state machine with exponential backoff (no I/O, no chzzkpy).

    States and transitions:
        connecting -> connected   (on_connected: handshake succeeded)
        connecting -> waiting     (on_disconnected: attempt failed)
        connected  -> waiting     (on_disconnected: live connection dropped)
        waiting    -> connecting  (on_retry: backoff wait finished)
        any        -> stopped     (on_stopped: terminal, no further retries)
    """

    def __init__(self, initial_delay: float = 3.0, max_delay: float = 60.0,
                 factor: float = 2.0):
        if initial_delay <= 0:
            raise ValueError("initial_delay must be positive")
        if max_delay < initial_delay:
            raise ValueError("max_delay must be >= initial_delay")
        if factor < 1:
            raise ValueError("factor must be >= 1")
        self.initial_delay = float(initial_delay)
        self.max_delay = float(max_delay)
        self.factor = float(factor)
        self.state = "connecting"
        self._failures = 0

    @property
    def consecutive_failures(self) -> int:
        return self._failures

    def should_retry(self) -> bool:
        return self.state != "stopped"

    def on_connected(self):
        """Handshake succeeded: reset the backoff schedule."""
        if self.state != "stopped":
            self.state = "connected"
            self._failures = 0

    def on_disconnected(self) -> float:
        """Attempt failed or connection dropped: seconds to wait before retrying."""
        if self.state == "stopped":
            return 0.0
        self.state = "waiting"
        delay = self._current_delay()
        self._failures += 1
        return delay

    def on_retry(self):
        """Backoff wait finished: the next connection attempt starts."""
        if self.state != "stopped":
            self.state = "connecting"

    def on_stopped(self):
        """Shutdown requested: terminal state, no further retries."""
        self.state = "stopped"

    def _current_delay(self) -> float:
        delay = self.initial_delay
        for _ in range(self._failures):
            if delay >= self.max_delay:
                break
            delay *= self.factor
        return min(delay, self.max_delay)


def approval_action(choice: str) -> str:
    """Classify a manual approval answer."""
    return {"s": "skip", "e": "edit", "m": "mode"}.get(
        (choice or "").strip().lower(), "send"
    )
