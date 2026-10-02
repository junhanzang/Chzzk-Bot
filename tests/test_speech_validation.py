import pytest

from speech_recognition import SpeechRecognizer


@pytest.mark.parametrize('speech', ['안녕하세요', '그다음은?', '좋아요', '자막 켜볼까?', '구독 고마워요', '3번으로?', 'FPS가 떨어지네'])
def test_real_short_utterances_and_common_words_are_not_mistaken_for_noise(speech):
    recognizer = SpeechRecognizer()
    assert not recognizer.is_loaded
    assert recognizer.is_valid_speech(speech)


@pytest.mark.parametrize('speech', ['', '아', '음 음 음', '[음악]', '(박수)', '...'])
def test_noise_and_stage_annotations_do_not_become_reply_targets(speech):
    assert not SpeechRecognizer().is_valid_speech(speech)
