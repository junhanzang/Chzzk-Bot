"""Dependency-free settings parsing shared by setup, diagnostics and runtime."""

import math
import re
from pathlib import Path
from urllib.parse import urlsplit

from core_logic import parse_banned_words

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"


def normalize_channel_id(value):
    """Accept an exact channel ID or official CHZZK channel/live URL."""
    text = (value or "").strip()
    if re.fullmatch(r"[0-9a-fA-F]{32}", text):
        return text.lower()
    try:
        url = urlsplit(text)
        if (url.scheme not in ("https", "http")
                or url.hostname not in ("chzzk.naver.com", "m.chzzk.naver.com")
                or url.username or url.password or url.port not in (None, 80, 443)):
            raise ValueError
        match = re.fullmatch(r"/(?:live/)?([0-9a-fA-F]{32})/?", url.path)
        if not match:
            raise ValueError
        return match.group(1).lower()
    except ValueError:
        raise ValueError("채널은 치지직 방송 URL 또는 32자리 채널 ID로 입력하세요.") from None


def read_env_values(path):
    """Read dotenv assignments without expanding secrets or importing packages."""
    path = Path(path)
    if not path.exists():
        return {}
    values = {}
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not match:
            continue
        key, value = match.groups()
        if value.startswith('"'):
            quoted = re.match(r'^"((?:\\.|[^"\\])*)"\s*(?:#.*)?$', value)
            if quoted:
                value = re.sub(r'\\([\\"nrt])',
                               lambda m: {"n": "\n", "r": "\r", "t": "\t"}.get(m[1], m[1]), quoted[1])
        elif value.startswith("'"):
            quoted = re.match(r"^'([^']*)'\s*(?:#.*)?$", value)
            if quoted:
                value = quoted[1]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[key] = value
    return values


DEFAULTS = {
    "CHZZK_CHANNEL_ID": "", "OLLAMA_MODEL": "qwen3:4b",
    "OLLAMA_HOST": "http://localhost:11434", "OLLAMA_KEEP_ALIVE": "10m",
    "LLM_MAX_TOKENS": 50, "LLM_NUM_CTX": 2048,
    "ASR_MODEL": "Qwen/Qwen3-ASR-0.6B", "AUDIO_SAMPLE_RATE": 16000,
    "AUDIO_CHUNK_DURATION": 5, "AUDIO_SPEAKER_ID": "", "MIN_SPEECH_LENGTH": 3,
    "RESPONSE_COOLDOWN": 10, "RESPONSE_MAX_AGE_SECONDS": 20.0,
    "CHAT_CONTEXT_MAX_AGE_SECONDS": 30.0, "SPEECH_CONTEXT_MAX_AGE_SECONDS": 45.0,
    "RESPONSE_CHANCE": 1.0, "SMART_RESPONSE": False, "RESPONSE_MODE": "hybrid",
    "WARMUP_SECONDS": 0, "BANNED_WORDS": "", "NID_AUT": "", "NID_SES": "",
}

NUMERIC_RULES = {
    "LLM_MAX_TOKENS": (int, 1, 4096), "LLM_NUM_CTX": (int, 256, 131072),
    "AUDIO_SAMPLE_RATE": (int, 8000, 192000), "AUDIO_CHUNK_DURATION": (int, 1, 30),
    "MIN_SPEECH_LENGTH": (int, 1, 1000), "RESPONSE_COOLDOWN": (int, 0, 3600),
    "RESPONSE_MAX_AGE_SECONDS": (float, 1, 3600),
    "CHAT_CONTEXT_MAX_AGE_SECONDS": (float, 1, 3600),
    "SPEECH_CONTEXT_MAX_AGE_SECONDS": (float, 1, 3600),
    "RESPONSE_CHANCE": (float, 0, 1), "WARMUP_SECONDS": (int, 0, 86400),
}


def parse_settings(raw):
    """Return safe typed values and all validation errors, never secret values."""
    values = {key: raw.get(key, default) for key, default in DEFAULTS.items()}
    errors = []
    for key, (kind, minimum, maximum) in NUMERIC_RULES.items():
        try:
            parsed = kind(values[key])
            if isinstance(values[key], bool) or not math.isfinite(parsed) or not minimum <= parsed <= maximum:
                raise ValueError
            if kind is int and isinstance(values[key], float) and parsed != values[key]:
                raise ValueError
            values[key] = parsed
        except (ValueError, TypeError, OverflowError):
            errors.append(f"{key}: {minimum}~{maximum} 범위의 {'정수' if kind is int else '숫자'}가 필요합니다.")
            values[key] = DEFAULTS[key]
    flag = str(values["SMART_RESPONSE"]).lower().strip()
    if flag not in ("true", "false", "1", "0", "yes", "no", "on", "off"):
        errors.append("SMART_RESPONSE: true 또는 false를 입력하세요.")
    values["SMART_RESPONSE"] = flag in ("true", "1", "yes", "on")
    mode = str(values["RESPONSE_MODE"]).strip().lower()
    if mode not in ("ai", "mimic", "hybrid"):
        errors.append("RESPONSE_MODE: ai, mimic, hybrid 중 하나를 입력하세요.")
        mode = DEFAULTS["RESPONSE_MODE"]
    values["RESPONSE_MODE"] = mode
    channel = str(values["CHZZK_CHANNEL_ID"] or "").strip()
    if channel:
        try:
            channel = normalize_channel_id(channel)
        except ValueError as error:
            errors.append(f"CHZZK_CHANNEL_ID: {error}")
            channel = ""
    values["CHZZK_CHANNEL_ID"] = channel
    host = str(values["OLLAMA_HOST"]).strip().rstrip("/")
    try:
        url = urlsplit(host)
        if (any(ord(char) < 32 or char.isspace() for char in host)
                or url.scheme not in ("http", "https") or not url.hostname
                or url.username or url.password or url.query or url.fragment):
            raise ValueError
        url.port
    except ValueError:
        errors.append("OLLAMA_HOST: 인증정보 없는 http:// 또는 https:// 주소가 필요합니다.")
        host = DEFAULTS["OLLAMA_HOST"]
    values["OLLAMA_HOST"] = host
    for key in ("OLLAMA_MODEL", "ASR_MODEL"):
        text = str(values[key]).strip()
        if not text or any(ord(char) < 32 for char in text):
            errors.append(f"{key}: 올바른 모델 이름을 입력하세요.")
            text = DEFAULTS[key]
        values[key] = text
    values["AUDIO_SPEAKER_ID"] = str(values["AUDIO_SPEAKER_ID"] or "").strip()
    values["BANNED_WORDS"] = parse_banned_words(str(values["BANNED_WORDS"]))
    return values, errors
