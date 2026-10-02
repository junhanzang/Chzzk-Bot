import logging
import re
from config import Config

# transformers의 "Setting pad_token_id to eos_token_id" 메시지 억제
logging.getLogger("transformers.generation.utils").setLevel(logging.ERROR)


class SpeechRecognizer:
    """Qwen3-ASR 기반 음성 인식 클래스"""

    def __init__(self, model_name=None):
        """
        Args:
            model_name: ASR 모델 이름 (예: Qwen/Qwen3-ASR-0.6B, Qwen/Qwen3-ASR-1.7B)
        """
        self.model_name = model_name or Config.ASR_MODEL
        from typing import Any
        self.model: Any = None
        self.is_loaded = False

    def load_model(self):
        """Qwen3-ASR 모델 로딩"""
        if self.is_loaded:
            return

        print(f"ASR 모델 로딩 중... (모델: {self.model_name})")
        print("처음 실행 시 모델 다운로드로 시간이 걸릴 수 있습니다.")

        try:
            import torch
            from qwen_asr import Qwen3ASRModel

            device = "cuda:0" if torch.cuda.is_available() else "cpu"
            self.model = Qwen3ASRModel.from_pretrained(
                self.model_name,
                dtype=torch.bfloat16 if device != "cpu" else torch.float32,
                device_map=device,
                max_new_tokens=256,
            )
            self.is_loaded = True
            print(f"ASR 모델 로딩 완료 (device: {device})")
        except Exception as e:
            print(f"ASR 모델 로딩 실패: {e}")
            raise

    def transcribe(self, audio_data, sample_rate=None, language="Korean"):
        """
        오디오 데이터를 텍스트로 변환

        Args:
            audio_data: numpy array 형태의 오디오 데이터
            sample_rate: 샘플레이트 (None이면 Config에서 가져옴)
            language: 언어 이름 (기본값: Korean)

        Returns:
            str: 인식된 텍스트 (실패 시 None)
        """
        if not self.is_loaded:
            self.load_model()

        if audio_data is None or len(audio_data) == 0:
            return None

        try:
            import numpy as np
            # 오디오 데이터 전처리
            if len(audio_data.shape) > 1:
                audio_data = audio_data.flatten()

            audio_data = audio_data.astype(np.float32)

            # [-1, 1] 범위로 정규화
            max_val = np.abs(audio_data).max()
            if max_val > 0:
                audio_data = audio_data / max_val

            sr = sample_rate or Config.AUDIO_SAMPLE_RATE

            # ASR 모델은 16000Hz를 기대 → 리샘플링
            target_sr = 16000
            if sr != target_sr:
                num_samples = int(len(audio_data) * target_sr / sr)
                indices = np.linspace(0, len(audio_data) - 1, num_samples)
                audio_data = np.interp(indices, np.arange(len(audio_data)), audio_data).astype(np.float32)
                sr = target_sr

            # Qwen3-ASR는 (np.ndarray, sr) 튜플 입력 지원
            results = self.model.transcribe(
                audio=(audio_data, sr),
                language=language,
            )

            text = results[0].text.strip()
            return text if text else None

        except Exception as e:
            print(f"음성 인식 실패: {e}")
            return None

    def is_valid_speech(self, text):
        """
        인식된 텍스트가 의미 있는 발화인지 검증

        Args:
            text: 인식된 텍스트

        Returns:
            bool: 유효한 발화 여부
        """
        if not text:
            return False

        # 너무 짧은 텍스트 제외
        if len(text.strip()) < 2:
            return False

        # 반복되는 짧은 소리 제외 (예: "아 아 아", "음 음 음")
        words = text.split()
        if len(words) >= 2 and len(set(words)) == 1 and words[0] in {"아", "어", "음", "으", "오"}:
            return False

        # Stage/noise annotations are not speech. Words such as '좋아요' or
        # '자막' can be genuine speech and must not be removed by substring.
        if re.fullmatch(r"\s*(?:\[[^\]]*\]|\([^)]*\))\s*", text):
            return False
        return bool(re.search(r"[가-힣a-zA-Z0-9]", text))

    def __del__(self):
        """소멸자"""
        if self.model:
            del self.model


def test_transcribe(audio_file_path):
    """
    오디오 파일로 음성 인식 테스트

    Args:
        audio_file_path: 테스트할 오디오 파일 경로
    """
    recognizer = SpeechRecognizer()
    recognizer.load_model()

    print(f"\n테스트 파일: {audio_file_path}")

    # 오디오 로드
    import soundfile as sf
    audio_data, sample_rate = sf.read(audio_file_path)

    print(f"샘플레이트: {sample_rate}Hz")
    print(f"오디오 길이: {len(audio_data) / sample_rate:.2f}초")

    # 음성 인식
    print("\n음성 인식 중...")
    text = recognizer.transcribe(audio_data, sample_rate=sample_rate)

    if text:
        print(f"\n인식 결과: {text}")
        print(f"유효성: {'유효' if recognizer.is_valid_speech(text) else '무효'}")
    else:
        print("인식 실패")
