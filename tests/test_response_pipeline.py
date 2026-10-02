from dataclasses import FrozenInstanceError
import threading

import pytest

from response_pipeline import ResponseCandidate, ResponsePipeline, SpeechContext, SpeechObservation


class FakeClock:
    def __init__(self, now=100):
        self.now = now

    def __call__(self):
        return self.now


def candidate(clock, *, age=0, generation=0, kind="ai", text="그 선택은 괜찮겠네"):
    return ResponseCandidate("이쪽으로 가볼까", text, "현재 채팅", clock() - age, generation, kind)


def test_observation_and_candidate_are_immutable():
    observation = SpeechObservation("발화", 100, 0)
    response = ResponseCandidate("발화", "반응", "채팅", 100, 0)
    with pytest.raises(FrozenInstanceError):
        observation.observed_at = 200
    with pytest.raises(FrozenInstanceError):
        response.generation = 1


def test_slow_inference_cannot_refresh_old_observation():
    clock = FakeClock()
    pipeline = ResponsePipeline(max_age_seconds=20, clock=clock)
    observed_at = clock()
    assert pipeline.accepts(observed_at, pipeline.generation)
    clock.now += 21
    response = ResponseCandidate("지난 상황", "뒤늦은 반응", "", observed_at, 0)
    assert not pipeline.accepts(observed_at, pipeline.generation)
    assert not pipeline.submit(response)
    assert pipeline.take(timeout=0) is None


def test_approval_wait_invalidates_previously_dequeued_reply():
    clock = FakeClock()
    pipeline = ResponsePipeline(max_age_seconds=20, clock=clock)
    response = candidate(clock)
    assert pipeline.submit(response)
    assert pipeline.take(timeout=0) is response
    assert pipeline.can_send(response)
    clock.now += 20.01
    assert not pipeline.is_current(response)
    assert not pipeline.can_send(response)


def test_mode_switch_discards_pending_and_inflight_generation():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    pending = candidate(clock)
    inflight = candidate(clock, text="아직 생성 중")
    pipeline.submit(pending)
    assert pipeline.switch_mode("mimic") == 1
    assert pipeline.mode == "mimic"
    assert pipeline.generation == 1
    assert pipeline.take(timeout=0) is None
    assert not pipeline.submit(inflight)
    assert not pipeline.can_send(pending)
    assert not pipeline.accepts(clock(), 1, "ai")
    assert pipeline.submit(candidate(clock, generation=1, kind="mimic"))
    pipeline.switch_mode("ai")
    assert not pipeline.accepts(clock(), 2, "mimic")
    assert not pipeline.accepts(clock(), 0, "ai")
    assert pipeline.accepts(clock(), 2, "ai")


def test_queue_is_one_slot_and_keeps_newest_observation_not_latest_completion():
    clock = FakeClock()
    pipeline = ResponsePipeline(mode="ai", clock=clock)
    for age in reversed(range(10)):
        assert pipeline.submit(candidate(clock, age=age, text=str(age)))
    assert not pipeline.submit(candidate(clock, age=5, text="늦게 끝난 오래된 추론"))
    assert pipeline.take(timeout=0).text == "0"
    assert pipeline.take(timeout=0) is None


@pytest.mark.parametrize("first_kind", ["ai", "mimic"])
def test_hybrid_prefers_reaction_for_nearby_observations(first_kind):
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    ai = candidate(clock, age=0, kind="ai")
    reaction = candidate(clock, age=1.5, kind="mimic", text="ㅋㅋㅋㅋ")
    first, second = (ai, reaction) if first_kind == "ai" else (reaction, ai)
    assert pipeline.submit(first)
    assert pipeline.submit(second) == (second.kind == "mimic")
    assert pipeline.take(timeout=0) is reaction


def test_old_reaction_does_not_suppress_ai_for_new_situation():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    assert pipeline.submit(candidate(clock, age=3, kind="mimic"))
    fresh = candidate(clock)
    assert pipeline.submit(fresh)
    assert not pipeline.submit(candidate(clock, age=4, kind="mimic"))
    assert pipeline.take(timeout=0) is fresh


def test_stale_pending_is_dropped_and_fresh_candidate_can_replace_it():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    pipeline.submit(candidate(clock))
    clock.now += 21
    assert pipeline.take(timeout=0) is None
    fresh = candidate(clock)
    assert pipeline.submit(fresh)
    assert pipeline.take(timeout=0) is fresh


def test_cooldown_records_only_success_and_survives_mode_change():
    clock = FakeClock()
    pipeline = ResponsePipeline(cooldown_seconds=10, clock=clock)
    failed = candidate(clock)
    assert pipeline.can_send(failed)
    # A failed send does not call record_sent, and a retry is not suppressed.
    assert pipeline.can_send(failed)
    pipeline.record_sent(failed)
    assert not pipeline.can_send(candidate(clock))
    pipeline.switch_mode("ai")
    response = candidate(clock, generation=1)
    assert not pipeline.can_send(response)
    clock.now += 9.99
    assert not pipeline.can_send(response)
    clock.now += 0.01
    assert pipeline.can_send(response)


def test_queued_reply_cannot_burst_after_slow_send_or_approval():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    approved = candidate(clock)
    pipeline.submit(approved)
    assert pipeline.take(timeout=0) is approved
    clock.now += 8
    queued = candidate(clock, text="대기 중 생성된 반응")
    pipeline.submit(queued)
    assert pipeline.can_send(approved)
    pipeline.record_sent(approved)
    next_reply = pipeline.take(timeout=0)
    assert next_reply is queued
    assert pipeline.is_current(next_reply)
    assert not pipeline.can_send(next_reply)


def test_successful_send_records_cooldown_even_when_it_expires_during_io():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    response = candidate(clock, age=19)
    assert pipeline.can_send(response)
    clock.now += 2
    pipeline.record_sent(response)
    assert not pipeline.can_send(candidate(clock))


@pytest.mark.parametrize("timestamp", [float("nan"), float("inf"), -float("inf"), True, None, "100", 101])
def test_invalid_or_future_timestamps_cannot_enter_pipeline(timestamp):
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    response = ResponseCandidate("발화", "반응", "", timestamp, 0)
    assert not pipeline.accepts(timestamp, 0)
    assert not pipeline.submit(response)
    assert not pipeline.can_send(response)


def test_close_wakes_consumer_without_sending_or_waiting_full_timeout():
    pipeline = ResponsePipeline()
    started = threading.Event()
    output = []

    def consume():
        started.set()
        output.append(pipeline.take(timeout=None))

    consumer = threading.Thread(target=consume, daemon=True)
    consumer.start()
    assert started.wait(1)
    pipeline.close()
    consumer.join(1)
    assert not consumer.is_alive()
    assert output == [None]
    assert not pipeline.submit(candidate(FakeClock()))


def test_submit_wakes_waiting_consumer():
    clock = FakeClock()
    pipeline = ResponsePipeline(clock=clock)
    started = threading.Event()
    output = []

    def consume():
        started.set()
        output.append(pipeline.take(timeout=None))

    consumer = threading.Thread(target=consume, daemon=True)
    consumer.start()
    assert started.wait(1)
    response = candidate(clock)
    pipeline.submit(response)
    consumer.join(1)
    assert not consumer.is_alive()
    assert output == [response]


def test_speech_context_retains_skipped_segments_and_excludes_current_and_future():
    clock = FakeClock(120)
    context = SpeechContext(clock=clock)
    skipped = SpeechObservation("열쇠가 있어야 들어갈 수 있대", 100, 0)
    current = SpeechObservation("그럼 어디서 찾지", 105, 0)
    future = SpeechObservation("아 여기 있네", 110, 0)
    for observation in (skipped, current, future):
        assert context.observe(observation)
    assert context.recent(current) == (skipped.text,)
    assert context.recent(future) == (skipped.text, current.text)


def test_speech_context_is_timestamp_ordered_age_and_count_bounded():
    clock = FakeClock(120)
    context = SpeechContext(max_segments=3, max_age_seconds=10, clock=clock)
    for timestamp in (100, 115, 110, 112):
        context.observe(SpeechObservation(str(timestamp), timestamp, 0))
    assert context.recent(SpeechObservation("현재", 120, 0)) == ("110", "112", "115")
    assert context.recent(SpeechObservation("현재", 123, 0)) == ("115",)


def test_speech_context_budgets_characters_toward_most_recent_segments():
    clock = FakeClock()
    context = SpeechContext(max_characters=7, clock=clock)
    context.observe(SpeechObservation("오래된 발화", 95, 0))
    context.observe(SpeechObservation("새로운 발화", 99, 0))
    result = context.recent(SpeechObservation("현재", 100, 0))
    assert result == ("화", "새로운 발화")
    assert sum(map(len, result)) == 7


def test_new_generation_clears_context_and_late_old_asr_cannot_restore_it():
    clock = FakeClock()
    context = SpeechContext(clock=clock)
    context.observe(SpeechObservation("예전 모드 발화", 90, 0))
    context.observe(SpeechObservation("지금 모드 발화", 95, 1))
    assert not context.observe(SpeechObservation("늦게 끝난 예전 인식", 97, 0))
    assert context.recent(SpeechObservation("현재", 100, 1)) == ("지금 모드 발화",)
    assert context.recent(SpeechObservation("과거", 100, 0)) == ()


def test_context_does_not_duplicate_same_capture_after_trimming():
    clock = FakeClock()
    context = SpeechContext(max_characters=5, clock=clock)
    observation = SpeechObservation(" 아주 긴 이전 발화 ", 99, 0)
    assert context.observe(observation)
    assert not context.observe(observation)
    assert context.recent(SpeechObservation("현재", 100, 0)) == ("이전 발화",)


@pytest.mark.parametrize("observation", [
    SpeechObservation("", 99, 0), SpeechObservation("  ", 99, 0),
    SpeechObservation("발화", float("nan"), 0), SpeechObservation("발화", 101, 0),
    SpeechObservation("발화", 99, True), SpeechObservation("발화", 99, -1),
])
def test_context_ignores_malformed_observations(observation):
    context = SpeechContext(clock=FakeClock())
    assert not context.observe(observation)
    assert context.recent(SpeechObservation("현재", 100, 0)) == ()


@pytest.mark.parametrize("kwargs", [
    {"mode": "unknown"}, {"max_age_seconds": 0}, {"max_age_seconds": float("nan")},
    {"cooldown_seconds": -1}, {"cooldown_seconds": True},
])
def test_invalid_pipeline_settings_fail_at_startup(kwargs):
    with pytest.raises(ValueError):
        ResponsePipeline(**kwargs)
