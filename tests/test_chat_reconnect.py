import sys

import pytest

from core_logic import ChatReconnectPolicy


def _next_delay(policy):
    """한 번의 실패 → 백오프 대기 → 재시도 사이클을 돌고 대기 시간을 반환"""
    delay = policy.on_disconnected()
    policy.on_retry()
    return delay


def test_initial_state():
    policy = ChatReconnectPolicy()
    assert policy.state == "connecting"
    assert policy.consecutive_failures == 0
    assert policy.should_retry()


def test_backoff_doubles_and_caps_at_max():
    policy = ChatReconnectPolicy(initial_delay=3.0, max_delay=60.0, factor=2.0)
    assert [_next_delay(policy) for _ in range(7)] == [3, 6, 12, 24, 48, 60, 60]


def test_success_resets_backoff():
    policy = ChatReconnectPolicy()
    for _ in range(4):
        _next_delay(policy)
    policy.on_connected()
    assert policy.state == "connected"
    assert policy.consecutive_failures == 0
    assert policy.on_disconnected() == 3.0


def test_state_transitions():
    policy = ChatReconnectPolicy()
    policy.on_disconnected()
    assert policy.state == "waiting"
    policy.on_retry()
    assert policy.state == "connecting"
    policy.on_connected()
    assert policy.state == "connected"
    policy.on_disconnected()
    assert policy.state == "waiting"
    policy.on_stopped()
    assert policy.state == "stopped"
    assert not policy.should_retry()


def test_stopped_is_terminal():
    policy = ChatReconnectPolicy()
    policy.on_stopped()
    assert policy.on_disconnected() == 0.0
    policy.on_retry()
    policy.on_connected()
    assert policy.state == "stopped"
    assert not policy.should_retry()


def test_custom_parameters():
    policy = ChatReconnectPolicy(initial_delay=1.0, max_delay=10.0, factor=3.0)
    assert [_next_delay(policy) for _ in range(4)] == [1, 3, 9, 10]


def test_long_outage_does_not_overflow():
    policy = ChatReconnectPolicy()
    delay = None
    for _ in range(5000):
        delay = _next_delay(policy)
    assert delay == 60.0
    assert policy.consecutive_failures == 5000


@pytest.mark.parametrize("kwargs", [
    {"initial_delay": 0}, {"initial_delay": -1},
    {"max_delay": 1.0}, {"factor": 0.5},
])
def test_invalid_parameters_rejected(kwargs):
    with pytest.raises(ValueError):
        ChatReconnectPolicy(**kwargs)


def test_reconnect_logic_needs_no_chzzkpy():
    assert not any(name == "chzzkpy" or name.startswith("chzzkpy.")
                   for name in sys.modules)
