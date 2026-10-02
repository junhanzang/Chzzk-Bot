"""Lazy device/account adapters and session setup.

Factories are injectable so lifecycle checks never need an audio device, GPU,
browser, real account or network connection.
"""
from pathlib import Path

from config import Config


class SessionSetupError(RuntimeError):
    """A fixed, user-facing setup message safe to display without credentials."""


class BotServices:
    """Create adapters only when the selected mode actually needs them."""

    def create_memories(self, channel_id, *, use_mock=False):
        from memory.memory_store import MemoryStore
        from memory.memory_manager import MemoryManager
        data_root = Path(__file__).resolve().parents[1] / "data"
        data_dir = (data_root / "mock" if use_mock else data_root) / channel_id
        stores = tuple(MemoryStore(str(data_dir / name), max_facts=count)
                       for name, count in (("streamer_memory.json", 5),
                                           ("chat_memory.json", 4),
                                           ("my_chat_memory.json", 4)))
        return (*stores, MemoryManager(*stores), str(data_dir / "my_chats.txt"))

    def create_llm(self, chat_log_path):
        from llm_handler import LLMHandler
        return LLMHandler(chat_log_path=chat_log_path)

    def create_reader(self, channel_id):
        from chat_reader import ChatReader
        return ChatReader(channel_id, nid_aut=Config.NID_AUT, nid_ses=Config.NID_SES)

    def create_sender(self, use_mock):
        from chat_sender import ChatSender, MockChatSender
        return MockChatSender() if use_mock else ChatSender()

    def create_recognizer(self):
        from speech_recognition import SpeechRecognizer
        return SpeechRecognizer()

    def create_audio(self, speaker_id, interactive):
        from audio_capture import AudioCapture
        speaker = None
        if speaker_id:
            import soundcard as sc
            speaker = next((item for item in sc.all_speakers()
                            if str(item.id) == str(speaker_id)), None)
            if speaker is None:
                raise SessionSetupError("저장한 출력 장치를 찾을 수 없습니다. --list-speakers로 장치를 확인하고 --setup에서 다시 선택하세요.")
        # Empty ID means the system default, including interactive launches.
        # Explicit selection lives in --setup/--speaker instead of every run.
        return AudioCapture(speaker=speaker)


class BotSession:
    def __init__(self, bot, services):
        self.bot = bot
        self.services = services
        self.speech_ready = False

    def initialize(self):
        from bot.settings import normalize_channel_id
        bot = self.bot
        if bot.non_interactive and not (bot.auto_send or bot.use_mock):
            raise SessionSetupError("입력 없이 실행하려면 --auto 또는 --mock을 함께 사용하세요.")
        channel = bot.channel_id or Config.CHZZK_CHANNEL_ID
        if not channel and not bot.non_interactive:
            channel = input("치지직 방송 URL 또는 채널 ID: ").strip()
        if not channel:
            raise SessionSetupError("채널이 없습니다. --channel URL 또는 --setup으로 채널을 설정하세요.")
        try:
            bot.channel_id = normalize_channel_id(channel)
        except ValueError:
            raise SessionSetupError("채널은 치지직 방송 URL 또는 32자리 채널 ID로 입력하세요.") from None
        print(f"채널 ID: {bot.channel_id}")
        if bot._stop_event.is_set():
            return False

        (bot.streamer_memory, bot.chat_memory, bot.my_chat_memory,
         bot.memory_manager, chat_log_path) = self.services.create_memories(bot.channel_id, use_mock=bot.use_mock)
        bot.llm_handler = self.services.create_llm(chat_log_path)

        # Authenticate first: avoid downloading/loading a model for expired login.
        bot.chat_sender = self.services.create_sender(bot.use_mock)
        if not bot.chat_sender.authenticate(
                bot.channel_id, interactive=not bot.non_interactive):
            print("채팅 로그인에 실패했습니다. 로그인 상태를 확인하고 다시 실행하세요.")
            return False
        if bot._stop_event.is_set():
            return False
        bot.chat_reader = self.services.create_reader(bot.channel_id)
        if not bot.use_mock and getattr(bot.chat_sender, "_nid_aut", ""):
            bot.chat_reader.set_credentials(bot.chat_sender._nid_aut, bot.chat_sender._nid_ses)
        bot.chat_reader.start()
        if bot.response_mode != "mimic":
            self.ensure_speech()
        else:
            print("따라하기 모드: 채팅 흐름만 관찰합니다. 음성 모델과 오디오는 시작하지 않아요.")
        return not bot._stop_event.is_set()

    def ensure_speech(self):
        """Prepare speech lazily, retaining working resources on repeated calls."""
        bot = self.bot
        with bot._resource_lock:
            if self.speech_ready:
                return True
            if bot._stop_event.is_set():
                return False
            print("Ollama 연결 확인 중...")
            if not bot.llm_handler.check_connection():
                raise SessionSetupError("Ollama에 연결할 수 없습니다. --doctor로 모델과 서버를 확인하세요.")
            if bot.speech_recognizer is None:
                bot.speech_recognizer = self.services.create_recognizer()
            print("음성 인식 모델 준비 중...")
            bot.speech_recognizer.load_model()
            if bot._stop_event.is_set():
                return False
            bot.audio_capture = self.services.create_audio(bot.speaker_id, not bot.non_interactive)
            try:
                if bot._started:
                    bot.audio_capture.start()
            except BaseException:
                try:
                    bot.audio_capture.stop()
                except BaseException:
                    bot.metrics.increment("cleanup_error")
                bot.audio_capture = None
                raise
            self.speech_ready = True
            return True
