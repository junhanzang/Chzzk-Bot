"""Backward-compatible settings facade with explicit, safe validation."""

import os

from bot.settings import DEFAULTS, ENV_PATH, parse_settings, read_env_values


class Config:
    """Precedence: defaults < project .env < environment < CLI overrides."""

    _errors = []
    _env_path = ENV_PATH

    @classmethod
    def load(cls, *, overrides=None, env_path=None, environ=None):
        cls._env_path = ENV_PATH if env_path is None else env_path
        try:
            raw = read_env_values(cls._env_path)
            read_errors = []
        except (OSError, UnicodeError):
            raw = {}
            read_errors = [".env 파일을 읽을 수 없습니다. 경로와 읽기 권한을 확인하세요."]
        source = os.environ if environ is None else environ
        raw.update({key: source[key] for key in DEFAULTS if key in source})
        raw.update({key: value for key, value in (overrides or {}).items() if value is not None})
        values, errors = parse_settings(raw)
        for key, value in values.items():
            setattr(cls, key, value)
        cls._errors = read_errors + errors
        return cls

    @classmethod
    def validation_errors(cls, *, require_channel=True):
        errors = list(cls._errors)
        if require_channel and not cls.CHZZK_CHANNEL_ID and not any("CHZZK_CHANNEL_ID:" in error for error in errors):
            errors.append("CHZZK_CHANNEL_ID: 채널을 설정하거나 --channel 방송URL을 지정하세요.")
        return errors

    @classmethod
    def validate(cls, *, require_channel=True):
        errors = cls.validation_errors(require_channel=require_channel)
        if errors:
            raise ValueError("설정 오류:\n- " + "\n- ".join(errors) + "\n\npython main.py --setup 또는 .env에서 수정하세요.")
        return True

    @classmethod
    def display(cls):
        print("=" * 50)
        print("현재 설정:")
        print(f"Ollama 모델: {cls.OLLAMA_MODEL}")
        print(f"Ollama 호스트: {cls.OLLAMA_HOST}")
        print(f"ASR 모델: {cls.ASR_MODEL}")
        print(f"오디오: {cls.AUDIO_SAMPLE_RATE}Hz / {cls.AUDIO_CHUNK_DURATION}초")
        print(f"스피커: {cls.AUDIO_SPEAKER_ID or '시스템 기본 장치'}")
        print(f"응답 모드: {cls.RESPONSE_MODE} / 쿨다운: {cls.RESPONSE_COOLDOWN}초")
        print(f"응답 유효시간: {cls.RESPONSE_MAX_AGE_SECONDS:g}초 (캡처 시점 기준)")
        print(f"최근 채팅 문맥: {cls.CHAT_CONTEXT_MAX_AGE_SECONDS:g}초")
        print(f"이전 발화 문맥: {cls.SPEECH_CONTEXT_MAX_AGE_SECONDS:g}초")
        print(f"응답 확률: {cls.RESPONSE_CHANCE} / 스마트 판단: {'켜짐' if cls.SMART_RESPONSE else '꺼짐'}")
        print(f"금칙어: {len(cls.BANNED_WORDS)}개 / 워밍업: {cls.WARMUP_SECONDS}초")
        print(f"치지직 채널 ID: {cls.CHZZK_CHANNEL_ID or '미설정'}")
        print(f"네이버 쿠키: {'설정됨' if cls.NID_AUT and cls.NID_SES else '미설정 또는 불완전'}")
        print("=" * 50)


Config.load()
