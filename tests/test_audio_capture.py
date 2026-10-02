"""Exercise real capture assembly without NumPy, soundcard, or audio devices."""

import importlib.util
import math
from pathlib import Path
import queue
import sys
import types

import pytest

from audio_buffer import AudioBlock, RecentAudioBuffer


class FakeArray:
    """The small two-dimensional array surface used by mono chunk assembly."""

    def __init__(self, rows):
        self.rows = [list(row) for row in rows]

    @property
    def ndim(self):
        return 2

    @property
    def shape(self):
        return (len(self.rows), len(self.rows[0]) if self.rows else 1)

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, selection):
        if isinstance(selection, slice):
            return FakeArray(self.rows[selection])
        return self.rows[selection]


def samples(*values):
    return FakeArray([[value] for value in values])


@pytest.fixture
def capture_module(monkeypatch):
    numpy = types.ModuleType("numpy")

    def concatenate(arrays, axis=0):
        assert axis == 0
        return FakeArray(row for array in arrays for row in array.rows)

    numpy.concatenate = concatenate
    numpy.zeros = lambda shape: FakeArray([[0] * shape[1] for _ in range(shape[0])])
    soundcard = types.ModuleType("soundcard")

    def no_devices(*args, **kwargs):
        raise AssertionError("Tests must not enumerate or open audio devices")

    soundcard.default_speaker = no_devices
    soundcard.all_speakers = no_devices
    soundcard.get_microphone = no_devices
    foundation = types.ModuleType("soundcard.mediafoundation")
    foundation.SoundcardRuntimeWarning = type("SoundcardRuntimeWarning", (Warning,), {})
    config = types.ModuleType("config")
    config.Config = types.SimpleNamespace(AUDIO_SAMPLE_RATE=10, AUDIO_CHUNK_DURATION=0.6)
    for name, module in (("numpy", numpy), ("soundcard", soundcard),
                         ("soundcard.mediafoundation", foundation), ("config", config)):
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location(
        "desk_audio_capture_test", Path(__file__).parents[1] / "audio_capture.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeClock:
    now = 100.0

    def __call__(self):
        return self.now


def capture_with_blocks(capture_module, blocks, *, duration=0.6, max_blocks=10, max_age=10):
    clock = FakeClock()
    capture = capture_module.AudioCapture(
        speaker=types.SimpleNamespace(id="fake", name="Fake output"),
        sample_rate=10, chunk_duration=duration,
    )
    capture.audio_queue = RecentAudioBuffer(max_blocks, max_age, clock=clock)
    for timestamp, values in blocks:
        clock.now = timestamp
        capture.audio_queue.put(samples(*values))
    capture.is_capturing = True
    return capture, clock


def test_timestamp_retains_first_original_sample_time_across_collected_blocks(capture_module):
    capture, clock = capture_with_blocks(capture_module, [
        (100.2, (1, 2)), (100.4, (3, 4)), (100.6, (5, 6)),
    ])
    # Waiting to assemble the chunk must not replace capture time with now.
    clock.now = 104.0
    data, captured_at = capture.get_audio_chunk(timeout=0, with_timestamp=True)
    assert data.rows == [[1], [2], [3], [4], [5], [6]]
    assert math.isclose(captured_at, 100.0, abs_tol=1e-9)
    assert captured_at < clock.now


def test_capture_gap_discards_partial_old_audio_instead_of_stitching_moments(capture_module):
    capture, _ = capture_with_blocks(capture_module, [
        (100.2, (1, 1)),
        (101.0, (8, 8)), (101.2, (9, 9)), (101.4, (10, 10)),
    ])
    data, captured_at = capture.get_audio_chunk(timeout=0, with_timestamp=True)
    assert data.rows == [[8], [8], [9], [9], [10], [10]]
    assert math.isclose(captured_at, 100.8, abs_tol=1e-9)


def test_default_api_still_returns_audio_data_only(capture_module):
    capture, _ = capture_with_blocks(capture_module, [(100.2, (2, 3))], duration=0.2)
    result = capture.get_audio_chunk(timeout=0)
    assert isinstance(result, FakeArray)
    assert result.rows == [[2], [3]]


def test_expired_backlog_is_discarded_before_audio_assembly(capture_module):
    capture, _ = capture_with_blocks(capture_module, [
        (100.2, (1, 1)), (101.4, (7, 8)),
    ], duration=0.2, max_age=1.0)
    data, captured_at = capture.get_audio_chunk(timeout=0, with_timestamp=True)
    assert data.rows == [[7], [8]]
    assert math.isclose(captured_at, 101.2, abs_tol=1e-9)


def test_buffer_capacity_keeps_newest_blocks_when_asr_falls_behind(capture_module):
    capture, _ = capture_with_blocks(capture_module, [
        (100.2, (1, 1)), (100.4, (2, 2)), (100.6, (3, 3)),
    ], duration=0.4, max_blocks=2)
    data, captured_at = capture.get_audio_chunk(timeout=0, with_timestamp=True)
    assert data.rows == [[2], [2], [3], [3]]
    assert math.isclose(captured_at, 100.2, abs_tol=1e-9)


def test_no_recent_audio_returns_none_instead_of_refreshing_stale_capture(capture_module):
    capture, clock = capture_with_blocks(capture_module, [(100.2, (1, 2))], max_age=1)
    clock.now = 102
    assert capture.get_audio_chunk(timeout=0, with_timestamp=True) is None


def test_partial_audio_padding_preserves_capture_timestamp(capture_module):
    capture, _ = capture_with_blocks(capture_module, [(100.2, (4, 5))])
    data, captured_at = capture.get_audio_chunk(timeout=0, with_timestamp=True)
    assert data.rows == [[4], [5], [0], [0], [0], [0]]
    assert math.isclose(captured_at, 100.0, abs_tol=1e-9)


@pytest.mark.parametrize("partial", [False, True])
def test_stop_flag_ends_collection_even_without_caller_timeout(capture_module, partial):
    capture, _ = capture_with_blocks(capture_module, [])

    class StoppingQueue:
        calls = 0

        def get(self, timeout):
            assert timeout == 1.0
            self.calls += 1
            if partial and self.calls == 1:
                return AudioBlock(samples(8, 9), 100.2)
            capture.is_capturing = False
            raise queue.Empty

    stopping = StoppingQueue()
    capture.audio_queue = stopping
    result = capture.get_audio_chunk(with_timestamp=True)
    assert stopping.calls == (2 if partial else 1)
    if partial:
        data, captured_at = result
        assert data.rows == [[8], [9], [0], [0], [0], [0]]
        assert math.isclose(captured_at, 100.0, abs_tol=1e-9)
    else:
        assert result is None


def test_stopped_capture_rejects_new_collection(capture_module):
    capture, _ = capture_with_blocks(capture_module, [(100.2, (1, 2))])
    capture.is_capturing = False
    with pytest.raises(RuntimeError, match="시작되지 않았습니다"):
        capture.get_audio_chunk(timeout=0)
