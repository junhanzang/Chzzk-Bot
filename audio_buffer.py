"""Bounded, timestamped capture blocks without audio-device dependencies."""

import math
import queue
import time
from collections import deque
from dataclasses import dataclass
from threading import Condition


@dataclass(frozen=True)
class AudioBlock:
    data: object
    captured_at: float


class RecentAudioBuffer:
    def __init__(self, max_blocks, max_age_seconds, clock=time.monotonic):
        if max_blocks < 1 or not math.isfinite(max_age_seconds) or max_age_seconds <= 0:
            raise ValueError("Audio buffer limits must be positive and finite")
        self._blocks = deque(maxlen=max_blocks)
        self._condition = Condition()
        self._clock = clock
        self.max_age_seconds = max_age_seconds

    def put(self, data):
        with self._condition:
            self._blocks.append(AudioBlock(data, self._clock()))
            self._condition.notify()

    def get(self, timeout=1.0):
        deadline = time.monotonic() + timeout
        with self._condition:
            while True:
                now = self._clock()
                while self._blocks:
                    block = self._blocks.popleft()
                    if 0 <= now - block.captured_at <= self.max_age_seconds:
                        return block
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                self._condition.wait(remaining)

    def clear(self):
        with self._condition:
            self._blocks.clear()
