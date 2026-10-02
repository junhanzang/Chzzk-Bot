import warnings
warnings.filterwarnings("ignore", message="data discontinuity")
try:
    from soundcard.mediafoundation import SoundcardRuntimeWarning
    warnings.filterwarnings("ignore", category=SoundcardRuntimeWarning)
except ImportError:
    warnings.filterwarnings("ignore", module="soundcard")

import numpy as np
import queue
import threading
from config import Config
from audio_buffer import RecentAudioBuffer

import soundcard as sc  # type: ignore[import-untyped]
SOUNDCARD_AVAILABLE = True


def list_speakers():
    """시스템 스피커(출력 장치) 목록"""
    if not SOUNDCARD_AVAILABLE:
        print("soundcard 라이브러리가 필요합니다: pip install soundcard")
        return []

    speakers = sc.all_speakers()
    default = sc.default_speaker()

    print("\n출력 장치 목록 (브라우저 소리가 나오는 장치를 선택하세요):")
    print("=" * 70)
    for i, spk in enumerate(speakers):
        marker = " ← [기본]" if spk.id == default.id else ""
        print(f"  {i}: {spk.name}{marker}")
    print("=" * 70)
    return speakers


def select_speaker():
    """사용자가 스피커 선택 → 해당 스피커의 오디오를 루프백 캡처"""
    speakers = list_speakers()
    if not speakers:
        return None

    while True:
        try:
            choice = input("\n장치 번호 선택 (Enter: 기본 장치): ").strip()
            if not choice:
                default = sc.default_speaker()
                print(f"기본 장치 선택: {default.name}")
                return default

            idx = int(choice)
            if 0 <= idx < len(speakers):
                print(f"선택: {speakers[idx].name}")
                return speakers[idx]
            else:
                print("유효하지 않은 번호입니다.")
        except ValueError:
            print("숫자를 입력하세요.")
        except KeyboardInterrupt:
            print("\n취소됨")
            return None


class AudioCapture:
    """시스템 오디오 루프백 캡처 (soundcard 기반)

    선택한 스피커의 출력을 그대로 캡처합니다.
    브라우저에서 방송 소리가 나오면, 그 소리를 잡아냅니다.
    """

    def __init__(self, speaker=None, sample_rate=None, chunk_duration=None):
        """
        Args:
            speaker: soundcard Speaker 객체 (None이면 기본 스피커)
            sample_rate: 샘플링 레이트
            chunk_duration: 청크 길이 (초)
        """
        self.speaker = speaker or sc.default_speaker()
        self.sample_rate = sample_rate or Config.AUDIO_SAMPLE_RATE
        self.chunk_duration = chunk_duration or Config.AUDIO_CHUNK_DURATION
        self.chunk_size = int(self.sample_rate * self.chunk_duration)

        # Keep at most one recent utterance instead of replaying an ASR backlog.
        self.audio_queue = RecentAudioBuffer(
            max_blocks=max(1, int(self.chunk_duration * 10)),
            max_age_seconds=max(1.0, self.chunk_duration * 2),
        )
        self.is_capturing = False
        self._thread = None
        self._recorder = None

    def _capture_loop(self):
        """별도 스레드에서 루프백 녹음"""
        try:
            # 스피커에 대응하는 루프백 마이크를 가져옴
            loopback_mic = sc.get_microphone(
                self.speaker.id,
                include_loopback=True
            )
            with loopback_mic.recorder(
                samplerate=self.sample_rate,
                channels=1
            ) as recorder:
                self._recorder = recorder
                block_size = int(self.sample_rate * 0.1)  # 100ms

                while self.is_capturing:
                    data = recorder.record(numframes=block_size)
                    if data is not None and len(data) > 0:
                        self.audio_queue.put(data)
        except Exception as e:
            if self.is_capturing:
                print(f"오디오 캡처 오류: {e}")

    def start(self):
        """캡처 시작"""
        if self.is_capturing:
            return

        if not SOUNDCARD_AVAILABLE:
            raise RuntimeError("soundcard 라이브러리를 설치하세요: pip install soundcard")

        self.is_capturing = True
        self._thread = threading.Thread(target=self._capture_loop, daemon=True)
        self._thread.start()

        print(f"오디오 캡처 시작 (루프백: {self.speaker.name}, {self.sample_rate}Hz)")

    def stop(self):
        """캡처 중지"""
        if not self.is_capturing:
            return

        self.is_capturing = False
        if self._thread:
            self._thread.join(timeout=3)

        self.audio_queue.clear()

        print("오디오 캡처 중지")

    def get_audio_chunk(self, timeout=None, *, with_timestamp=False):
        """오디오 청크 반환"""
        if not self.is_capturing:
            raise RuntimeError("오디오 캡처가 시작되지 않았습니다.")

        audio_chunks = []
        total_samples = 0
        target_samples = self.chunk_size
        captured_at = None
        previous_at = None

        while self.is_capturing and total_samples < target_samples:
            try:
                block = self.audio_queue.get(timeout=timeout if timeout is not None else 1.0)
                # A skipped backlog must not splice unrelated moments together.
                if previous_at is not None and block.captured_at - previous_at > 0.5:
                    audio_chunks = []
                    total_samples = 0
                    captured_at = None
                chunk = block.data
                if captured_at is None:
                    captured_at = block.captured_at - len(chunk) / self.sample_rate
                previous_at = block.captured_at
                audio_chunks.append(chunk)
                total_samples += len(chunk)
            except queue.Empty:
                if timeout is not None:
                    break
                continue

        if not audio_chunks:
            return None

        audio_data = np.concatenate(audio_chunks, axis=0)

        # 모노로 변환
        if audio_data.ndim > 1 and audio_data.shape[1] > 1:
            audio_data = np.mean(audio_data, axis=1, keepdims=True)

        # 1D가 아니면 reshape
        if audio_data.ndim == 1:
            audio_data = audio_data.reshape(-1, 1)

        if len(audio_data) > target_samples:
            audio_data = audio_data[:target_samples]
        elif len(audio_data) < target_samples:
            padding = np.zeros((target_samples - len(audio_data), audio_data.shape[1]))
            audio_data = np.concatenate([audio_data, padding], axis=0)

        return (audio_data, captured_at) if with_timestamp else audio_data

    def is_speech_present(self, audio_data, threshold=0.002):
        """소리가 있는지 에너지 기반 검사"""
        if audio_data is None or len(audio_data) == 0:
            return False
        energy = np.sqrt(np.mean(audio_data ** 2))
        return energy > threshold

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.stop()
