import queue

import pytest

from audio_buffer import RecentAudioBuffer


def test_capture_backlog_keeps_only_recent_blocks_and_their_original_times():
    now = [100.0]
    buffer = RecentAudioBuffer(3, 10, clock=lambda: now[0])
    for index in range(8):
        now[0] += 0.1
        buffer.put([index])
    blocks = [buffer.get(timeout=0) for _ in range(3)]
    assert [block.data for block in blocks] == [[5], [6], [7]]
    assert blocks[0].captured_at < blocks[-1].captured_at
    with pytest.raises(queue.Empty):
        buffer.get(timeout=0)


def test_stale_audio_is_discarded_instead_of_becoming_fresh_at_asr_time():
    now = [100.0]
    buffer = RecentAudioBuffer(4, 5, clock=lambda: now[0])
    buffer.put('old')
    now[0] += 10
    with pytest.raises(queue.Empty):
        buffer.get(timeout=0)
    buffer.put('new')
    assert buffer.get(timeout=0).captured_at == 110
    buffer.put('clear me')
    buffer.clear()
    with pytest.raises(queue.Empty):
        buffer.get(timeout=0)
