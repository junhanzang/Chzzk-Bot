import os
from dotenv import load_dotenv

from core_logic import parse_banned_words

load_dotenv()


class Config:
    """애플리케이션 설정 관리"""

    # 치지직 채널 설정
    CHZZK_CHANNEL_ID = os.getenv("CHZZK_CHANNEL_ID")

    # Ollama 설정
    OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "qwen3:4b")
    OLLAMA_HOST = os.getenv("OLLAMA_HOST", "http://localhost:11434")
    OLLAMA_KEEP_ALIVE = os.getenv("OLLAMA_KEEP_ALIVE", "10m")

    # LLM 생성 설정
    LLM_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "50"))
    LLM_NUM_CTX = int(os.getenv("LLM_NUM_CTX", "2048"))

    # ASR 설정
    ASR_MODEL = os.getenv("ASR_MODEL", "Qwen/Qwen3-ASR-0.6B")

    # 오디오 설정
    AUDIO_SAMPLE_RATE = int(os.getenv("AUDIO_SAMPLE_RATE", "16000"))
    AUDIO_CHUNK_DURATION = int(os.getenv("AUDIO_CHUNK_DURATION", "5"))

    # 채팅 설정
    MIN_SPEECH_LENGTH = int(os.getenv("MIN_SPEECH_LENGTH", "3"))
    RESPONSE_COOLDOWN = int(os.getenv("RESPONSE_COOLDOWN", "10"))
    RESPONSE_CHANCE = float(os.getenv("RESPONSE_CHANCE", "1.0"))
    SMART_RESPONSE = os.getenv("SMART_RESPONSE", "false").lower() == "true"
    RESPONSE_MODE = os.getenv("RESPONSE_MODE", "hybrid")  # "ai", "mimic", "hybrid"
    WARMUP_SECONDS = int(os.getenv("WARMUP_SECONDS", "0"))  # 시작 후 관찰만 하는 시간 (초)
    BANNED_WORDS = parse_banned_words(os.getenv("BANNED_WORDS", ""))  # 쉼표로 구분

    # 네이버 로그인 쿠키 (채팅 전송용)
    NID_AUT = os.getenv("NID_AUT", "")
    NID_SES = os.getenv("NID_SES", "")

    @classmethod
    def validate(cls):
        """필수 설정값 검증"""
        errors = []

        if not cls.CHZZK_CHANNEL_ID:
            errors.append("CHZZK_CHANNEL_ID가 설정되지 않았습니다.")

        if errors:
            error_message = "\n".join(errors)
            raise ValueError(f"설정 오류:\n{error_message}\n\n.env 파일을 확인하세요.")

        return True

    @classmethod
    def display(cls):
        """현재 설정 표시 (민감한 정보는 마스킹)"""
        print("=" * 50)
        print("현재 설정:")
        print("=" * 50)
        print(f"Ollama 모델: {cls.OLLAMA_MODEL}")
        print(f"Ollama 호스트: {cls.OLLAMA_HOST}")
        print(f"ASR 모델: {cls.ASR_MODEL}")
        print(f"오디오 샘플레이트: {cls.AUDIO_SAMPLE_RATE}Hz")
        print(f"오디오 청크 길이: {cls.AUDIO_CHUNK_DURATION}초")
        print(f"LLM 최대 토큰: {cls.LLM_MAX_TOKENS}")
        print(f"LLM 컨텍스트: {cls.LLM_NUM_CTX}")
        print(f"최소 발화 길이: {cls.MIN_SPEECH_LENGTH}초")
        print(f"응답 쿨다운: {cls.RESPONSE_COOLDOWN}초")
        print(f"응답 확률: {cls.RESPONSE_CHANCE}")
        print(f"스마트 응답: {'켜짐' if cls.SMART_RESPONSE else '꺼짐'}")
        print(f"응답 모드: {cls.RESPONSE_MODE}")
        print(f"금칙어: {len(cls.BANNED_WORDS)}개")
        print(f"워밍업: {cls.WARMUP_SECONDS}초" if cls.WARMUP_SECONDS > 0 else "워밍업: 없음")
        print(f"치지직 채널 ID: {cls.CHZZK_CHANNEL_ID}")
        print(f"네이버 쿠키: {'설정됨' if cls.NID_AUT else '미설정'}")
        print("=" * 50)
