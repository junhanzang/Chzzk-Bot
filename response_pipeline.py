"""Bounded, timestamped response coordination without model or chat I/O.

All timestamps use the same monotonic clock.  Producers retain the observation's
timestamp and generation throughout inference; creating a reply never makes an
old observation fresh again.
"""

from collections import deque
from dataclasses import dataclass
import math
import threading
import time


@dataclass(frozen=True)
class SpeechObservation:
    text: str
    observed_at: float
    generation: int


@dataclass(frozen=True)
class ResponseCandidate:
    speech: str
    text: str
    chat_context: str
    observed_at: float
    generation: int
    kind: str = "ai"


def _duration(value, name, *, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number")
    if not math.isfinite(value) or value < 0 or (positive and value == 0):
        raise ValueError(f"{name} must be {'positive' if positive else 'non-negative'}")
    return float(value)


def _valid_timestamp(value):
    return (
        not isinstance(value, bool)
        and isinstance(value, (int, float))
        and math.isfinite(value)
    )


def _valid_generation(value):
    return not isinstance(value, bool) and isinstance(value, int) and value >= 0


class ResponsePipeline:
    """A single replaceable response slot shared by inference and reaction workers.

    ``take`` does not reserve permission to send.  The consumer must check
    ``can_send`` immediately before the actual send, including after approval,
    and call ``record_sent`` only after that send succeeds.  Mode switches retain
    the global cooldown, so changing modes cannot cause a burst of messages.
    """

    MODES = frozenset({"ai", "mimic", "hybrid"})
    REACTION_PREFERENCE_SECONDS = 2.0

    def __init__(
        self,
        mode="hybrid",
        max_age_seconds=20,
        cooldown_seconds=10,
        clock=time.monotonic,
    ):
        if mode not in self.MODES:
            raise ValueError("mode must be ai, mimic, or hybrid")
        self.max_age_seconds = _duration(max_age_seconds, "max_age_seconds", positive=True)
        self.cooldown_seconds = _duration(cooldown_seconds, "cooldown_seconds")
        self._clock = clock
        self._condition = threading.Condition()
        self._mode = mode
        self._generation = 0
        self._pending = None
        self._last_sent_at = None
        self._closed = False

    @property
    def mode(self):
        with self._condition:
            return self._mode

    @property
    def generation(self):
        with self._condition:
            return self._generation

    def switch_mode(self, mode):
        if mode not in self.MODES:
            raise ValueError("mode must be ai, mimic, or hybrid")
        with self._condition:
            self._mode = mode
            self._generation += 1
            self._pending = None
            self._condition.notify_all()
            return self._generation

    def _accepts(self, observed_at, generation, kind, now):
        if self._closed or not _valid_generation(generation):
            return False
        if generation != self._generation:
            return False
        if kind not in ("ai", "mimic"):
            return False
        if self._mode != "hybrid" and kind != self._mode:
            return False
        if not _valid_timestamp(observed_at):
            return False
        age = now - observed_at
        return 0 <= age <= self.max_age_seconds

    def accepts(self, observed_at, generation, kind="ai"):
        """Check an observation before starting expensive response generation."""
        with self._condition:
            return self._accepts(observed_at, generation, kind, self._clock())

    def _is_current(self, candidate, now):
        return isinstance(candidate, ResponseCandidate) and self._accepts(
            candidate.observed_at, candidate.generation, candidate.kind, now
        )

    def is_current(self, candidate):
        with self._condition:
            return self._is_current(candidate, self._clock())

    def submit(self, candidate):
        with self._condition:
            now = self._clock()
            if not self._is_current(candidate, now):
                return False
            pending = self._pending
            if pending is not None and self._is_current(pending, now):
                close = abs(candidate.observed_at - pending.observed_at) <= self.REACTION_PREFERENCE_SECONDS
                if self._mode == "hybrid" and close and candidate.kind != pending.kind:
                    if candidate.kind != "mimic":
                        return False
                elif candidate.observed_at <= pending.observed_at:
                    return False
            self._pending = candidate
            self._condition.notify()
            return True

    def take(self, timeout=1):
        """Return the latest eligible candidate, or None on timeout/close.

        The wait deadline uses the real monotonic clock independently of the
        injected observation clock, which makes fake-clock tests deterministic.
        """
        if timeout is not None:
            timeout = _duration(timeout, "timeout")
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            while not self._closed:
                candidate = self._pending
                self._pending = None
                if candidate is not None and self._is_current(candidate, self._clock()):
                    return candidate
                remaining = None if deadline is None else deadline - time.monotonic()
                if remaining is not None and remaining <= 0:
                    return None
                self._condition.wait(remaining)
            return None

    def can_send(self, candidate):
        with self._condition:
            now = self._clock()
            return self._is_current(candidate, now) and (
                self._last_sent_at is None
                or now - self._last_sent_at >= self.cooldown_seconds
            )

    def record_sent(self, candidate):
        """Record a completed send, even if it expired while chat I/O ran."""
        if not isinstance(candidate, ResponseCandidate):
            raise TypeError("candidate must be a ResponseCandidate")
        with self._condition:
            self._last_sent_at = self._clock()

    def close(self):
        with self._condition:
            self._closed = True
            self._pending = None
            self._condition.notify_all()


class SpeechContext:
    """Remember speech even when no response is generated or sent for it.

    ``recent(current)`` returns prior speech as a tuple of strings.  The
    current observation's timestamp anchors the age window; later observations
    are excluded even if inference has taken time.  Only the newest generation
    is retained, and a late result from an older generation cannot reset it.
    """

    def __init__(self, max_segments=6, max_age_seconds=45, max_characters=1200, clock=time.monotonic):
        if isinstance(max_segments, bool) or not isinstance(max_segments, int) or max_segments < 1:
            raise ValueError("max_segments must be a positive integer")
        if isinstance(max_characters, bool) or not isinstance(max_characters, int) or max_characters < 1:
            raise ValueError("max_characters must be a positive integer")
        self.max_age_seconds = _duration(max_age_seconds, "max_age_seconds", positive=True)
        self.max_characters = max_characters
        self._clock = clock
        self._observations = deque(maxlen=max_segments)
        self._generation = None
        self._lock = threading.Lock()

    def observe(self, observation):
        if not isinstance(observation, SpeechObservation):
            return False
        if not isinstance(observation.text, str) or not observation.text.strip():
            return False
        if not _valid_generation(observation.generation):
            return False
        if not _valid_timestamp(observation.observed_at) or observation.observed_at > self._clock():
            return False
        bounded = SpeechObservation(
            observation.text.strip()[-self.max_characters:],
            observation.observed_at,
            observation.generation,
        )
        with self._lock:
            if self._generation is not None and observation.generation < self._generation:
                return False
            if self._generation != observation.generation:
                self._observations.clear()
                self._generation = observation.generation
            if bounded in self._observations:
                return False
            # ASR completion order can differ from capture order.  Keep the
            # newest observations by timestamp, not by completion time.
            observations = sorted((*self._observations, bounded), key=lambda item: item.observed_at)
            self._observations.clear()
            self._observations.extend(observations)
            return True

    def recent(self, current):
        if (
            not isinstance(current, SpeechObservation)
            or not _valid_timestamp(current.observed_at)
            or not _valid_generation(current.generation)
        ):
            return ()
        with self._lock:
            observations = [
                item for item in self._observations
                if item.generation == current.generation
                and 0 < current.observed_at - item.observed_at <= self.max_age_seconds
            ]
        parts = []
        remaining = self.max_characters
        for item in reversed(observations):
            if remaining <= 0:
                break
            text = item.text.strip()
            part = text[-remaining:]
            parts.append(part)
            remaining -= len(part)
        return tuple(reversed(parts))
