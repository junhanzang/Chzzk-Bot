"""Real bot orchestration with fake devices/senders; never imports GPU drivers."""

import importlib.util
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace

import pytest

from llm_handler import LLMHandler
from response_pipeline import ResponseCandidate, ResponsePipeline, SpeechContext, SpeechObservation


@pytest.fixture
def runtime(monkeypatch):
    stubs = {
        'audio_capture': {'AudioCapture': object, 'select_speaker': lambda: None},
        'speech_recognition': {'SpeechRecognizer': object},
        'chat_sender': {'ChatSender': object, 'MockChatSender': object},
        'chat_reader': {'ChatReader': object, 'extract_channel_id': lambda value: value},
    }
    for name, exports in stubs.items():
        module = ModuleType(name)
        module.__dict__.update(exports)
        monkeypatch.setitem(sys.modules, name, module)
    spec = importlib.util.spec_from_file_location('offline_bot_main', Path(__file__).parents[1] / 'main.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    bot = module.ChzzkVoiceBot(use_mock=True, auto_send=True)
    now = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    bot.pipeline = ResponsePipeline(mode='hybrid', max_age_seconds=20, cooldown_seconds=10, clock=lambda: now[0])
    bot.speech_context = SpeechContext(clock=lambda: now[0])
    bot.llm_handler = LLMHandler(model_name='fake', host='http://unused', banned_words=('금칙어',))
    records, sent = [], []
    bot.memory_manager = SimpleNamespace(record_interaction=lambda *args: records.append(args))
    memory = SimpleNamespace(get_facts_as_prompt=lambda: '')
    bot.streamer_memory = bot.chat_memory = bot.my_chat_memory = memory
    bot.chat_sender = SimpleNamespace(send_message=lambda message: sent.append(message) is None)
    monkeypatch.setattr(module.Config, 'SMART_RESPONSE', False)
    monkeypatch.setattr(module.Config, 'RESPONSE_CHANCE', 1)
    monkeypatch.setattr(module.Config, 'RESPONSE_COOLDOWN', 10)
    return SimpleNamespace(bot=bot, now=now, sent=sent, records=records, module=module)


def candidate(runtime, text='다른 길도 있겠네', kind='ai'):
    return ResponseCandidate('이 길 말고 다른 길도 있나?', text, '시청자: 다른 길 있어',
        runtime.now[0], runtime.bot.pipeline.generation, kind)


def test_short_question_keeps_unsent_surrounding_speech_and_hybrid_can_generate(runtime):
    f = runtime
    first = SpeechObservation('첫 번째 상자는 이미 열었어', 98, 0)
    target = SpeechObservation('그 다음은?', 99, 0)
    f.bot._observe_speech(first)
    f.bot._observe_speech(target)
    assert f.bot._drain_speech_queue() == target
    calls = []
    f.bot.llm_handler.generate_response = lambda *args, **kwargs: calls.append((args, kwargs)) or '두 번째 상자도 궁금하네'
    draft = f.bot._generate_candidate(target)
    assert draft.text == '두 번째 상자도 궁금하네'
    assert calls[0][1]['speech_context'] == ('첫 번째 상자는 이미 열었어',)
    assert not f.bot.llm_handler.context


@pytest.mark.parametrize('change', ['expire', 'mode', 'stop'])
def test_slow_generation_cannot_enqueue_an_obsolete_reply(runtime, change):
    f = runtime
    def generate(*args, **kwargs):
        if change == 'expire':
            f.now[0] += 21
        elif change == 'mode':
            f.bot._cycle_mode()
        else:
            f.bot.pipeline.close()
        return '이미 지난 장면의 답'
    f.bot.llm_handler.generate_response = generate
    assert f.bot._generate_candidate(SpeechObservation('지금 어느 길로 갈까?', 100, 0)) is None
    assert not f.sent


@pytest.mark.parametrize('choice', ['s', 'm'])
def test_rejected_drafts_never_enter_sent_history(runtime, monkeypatch, choice):
    f = runtime
    f.bot.auto_send = False
    monkeypatch.setattr('builtins.input', lambda _: choice)
    assert not f.bot._process_candidate(candidate(f))
    assert not f.sent and not f.records and not f.bot.llm_handler.context


def test_edited_message_not_the_draft_is_recorded_only_after_success(runtime, monkeypatch):
    f = runtime
    f.bot.auto_send = False
    answers = iter(['e', '3번 상자부터 확인해볼까'])
    monkeypatch.setattr('builtins.input', lambda _: next(answers))
    assert f.bot._process_candidate(candidate(f))
    assert f.sent == ['3번 상자부터 확인해볼까']
    assert f.bot.llm_handler.recent_responses[-1] == f.sent[-1]
    assert f.records[0][1] == f.sent[-1]


def test_expired_manual_approval_does_not_send(runtime, monkeypatch):
    f = runtime
    f.bot.auto_send = False
    def approve(_):
        f.now[0] += 21
        return ''
    monkeypatch.setattr('builtins.input', approve)
    assert not f.bot._process_candidate(candidate(f))
    assert not f.sent and not f.bot.llm_handler.context


def test_failed_send_does_not_reserve_dedup_or_cooldown(runtime):
    f = runtime
    f.bot.chat_sender.send_message = lambda _: False
    draft = candidate(f)
    assert not f.bot._process_candidate(draft)
    assert f.bot.pipeline.can_send(draft)
    assert not f.bot.llm_handler.recent_responses
    assert not f.records


def test_ai_mimic_and_edits_share_final_guard_and_success_cooldown(runtime, monkeypatch):
    f = runtime
    assert not f.bot._process_candidate(candidate(f, '금칙어 포함', 'mimic'))
    assert f.bot._process_candidate(candidate(f, 'ㅋㅋㅋ', 'mimic'))
    assert not f.records, 'A crowd reaction is not evidence of streamer speech'
    assert list(f.bot.llm_handler.context) == [{'role': 'bot', 'text': 'ㅋㅋㅋ'}]
    assert not f.bot._process_candidate(candidate(f))
    f.now[0] += 11
    assert not f.bot._process_candidate(candidate(f, 'ㅋㅋㅋㅋㅋ', 'mimic'))
    assert f.sent == ['ㅋㅋㅋ']
    f.bot.auto_send = False
    answers = iter(['e', '금칙어 수정본'])
    monkeypatch.setattr('builtins.input', lambda _: next(answers))
    assert not f.bot._process_candidate(candidate(f))


def test_mode_change_discards_late_asr_and_stale_ai_is_not_run(runtime):
    f = runtime
    f.bot._cycle_mode()
    f.bot._observe_speech(SpeechObservation('이전 모드 음성', 100, 0))
    assert f.bot.speech_queue.empty()
    f.bot.llm_handler.generate_response = lambda *args, **kwargs: pytest.fail('No obsolete model call')
    assert f.bot._generate_candidate(SpeechObservation('이미 지난 음성', 70, 1)) is None


@pytest.mark.parametrize('mode_changes', [False, True])
def test_asr_keeps_capture_time_and_rejects_results_from_previous_mode(runtime, mode_changes):
    f = runtime
    calls = []
    def capture(**kwargs):
        calls.append(kwargs)
        if len(calls) > 1:
            f.bot._stop_event.set()
            return None
        return object(), 95.0
    def transcribe(_):
        f.now[0] = 108
        if mode_changes:
            f.bot._cycle_mode()
        return '그다음은?'
    f.bot.audio_capture = SimpleNamespace(get_audio_chunk=capture, is_speech_present=lambda _: True)
    f.bot.speech_recognizer = SimpleNamespace(transcribe=transcribe, is_valid_speech=lambda _: True)
    f.bot._is_tts_donation = lambda _: False
    f.bot._asr_worker()
    assert calls[0]['with_timestamp'] is True
    if mode_changes:
        assert f.bot.speech_queue.empty()
    else:
        assert f.bot.speech_queue.get_nowait() == SpeechObservation('그다음은?', 95.0, 0)
