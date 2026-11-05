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
    "LLM_PROVIDER": "ollama", "LLM_BASE_URL": "https://api.openai.com/v1",
    "LLM_MODEL": "", "LLM_API_KEY": "",
    "LLM_MAX_TOKENS": 50, "LLM_NUM_CTX": 2048,
    "ASR_MODEL": "Qwen/Qwen3-ASR-0.6B", "AUDIO_SAMPLE_RATE": 16000,
    "AUDIO_CHUNK_DURATION": 5, "AUDIO_SPEAKER_ID": "", "MIN_SPEECH_LENGTH": 3,
    "RESPONSE_COOLDOWN": 10, "RESPONSE_MAX_AGE_SECONDS": 20.0,
    "CHAT_CONTEXT_MAX_AGE_SECONDS": 30.0, "SPEECH_CONTEXT_MAX_AGE_SECONDS": 45.0,
    "RESPONSE_CHANCE": 1.0, "SMART_RESPONSE": False, "RESPONSE_MODE": "hybrid",
    "WARMUP_SECONDS": 0, "BANNED_WORDS": "", "NID_AUT": "", "NID_SES": "",
}


def normalize_api_base_url(value):
    """Remote credentials require HTTPS; local compatible servers may use HTTP."""
    if not isinstance(value, str) or not 1 <= len(value) <= 2048:
        raise ValueError("LLM_BASE_URL: 올바른 API 기본 주소가 필요합니다.")
    text = value.strip().rstrip("/")
    try:
        url = urlsplit(text)
        if (any(ord(char) < 32 or char.isspace() for char in text)
                or not url.hostname or url.username or url.password or url.query or url.fragment
                or url.scheme not in ("http", "https")
                or (url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1"))):
            raise ValueError
        url.port
        if url.path.endswith("/chat/completions"):
            raise ValueError
    except ValueError:
        raise ValueError("LLM_BASE_URL: 인증정보 없는 HTTPS 기본 주소(예: https://api.openai.com/v1)를 입력하세요. HTTP는 로컬 서버만 허용합니다.") from None
    return text

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
    provider = str(values["LLM_PROVIDER"]).strip().lower()
    if provider not in ("ollama", "openai_compatible"):
        errors.append("LLM_PROVIDER: ollama 또는 openai_compatible 중 하나를 입력하세요.")
        provider = "ollama"
    values["LLM_PROVIDER"] = provider
    try:
        values["LLM_BASE_URL"] = normalize_api_base_url(values["LLM_BASE_URL"])
    except ValueError as error:
        if provider == "openai_compatible":
            errors.append(str(error))
        values["LLM_BASE_URL"] = DEFAULTS["LLM_BASE_URL"]
    model = str(values["LLM_MODEL"] or "").strip()
    if len(model) > 200 or any(ord(char) < 32 for char in model) or (provider == "openai_compatible" and not model):
        errors.append("LLM_MODEL: 외부 AI 서비스에서 사용할 모델 이름을 입력하세요.")
        model = ""
    values["LLM_MODEL"] = model
    key = values["LLM_API_KEY"]
    if not isinstance(key, str) or len(key) > 8192 or any(ord(char) < 33 or ord(char) > 126 for char in key):
        errors.append("LLM_API_KEY: 공백이나 줄바꿈 없는 API 키가 필요합니다.")
        key = ""
    values["LLM_API_KEY"] = key
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
        if provider == "ollama":
            errors.append("OLLAMA_HOST: 인증정보 없는 http:// 또는 https:// 주소가 필요합니다.")
        host = DEFAULTS["OLLAMA_HOST"]
    values["OLLAMA_HOST"] = host
    for key in ("OLLAMA_MODEL", "ASR_MODEL"):
        text = str(values[key]).strip()
        if not text or any(ord(char) < 32 for char in text):
            if key != "OLLAMA_MODEL" or provider == "ollama":
                errors.append(f"{key}: 올바른 모델 이름을 입력하세요.")
            text = DEFAULTS[key]
        values[key] = text
    values["AUDIO_SPEAKER_ID"] = str(values["AUDIO_SPEAKER_ID"] or "").strip()
    values["BANNED_WORDS"] = parse_banned_words(str(values["BANNED_WORDS"]))
    return values, errors
