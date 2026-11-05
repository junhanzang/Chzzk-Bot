"""Bounded JSON-lines control for the desktop app, with no listening socket.

The adapter is idle until an explicit command starts a session or text preview.
Credentials stay in process memory and never appear in snapshots or events.
"""

from collections import deque
from contextlib import redirect_stderr, redirect_stdout
import json
import os
import sys
import threading
import time
from uuid import uuid4


MAX_LINE = 65536
EVENT_TYPES = frozenset({"heard", "generated", "proposed", "skipped", "filtered", "error", "preview", "sent", "status"})


def _text(value, name, limit, *, empty=False):
    if not isinstance(value, str) or len(value) > limit or (not empty and not value.strip()):
        raise ValueError(f"{name} 입력을 확인하세요.")
    return value.strip()


def _object(value, allowed):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError("요청 항목을 확인하세요.")
    return value


class BotControl:
    def __init__(self, *, emit=None, config=None, bot_factory=None, handler_factory=None,
                 clock=time.monotonic, wall_clock=time.time):
        if config is None:
            from config import Config
            config = Config
        self.config = config
        self._emit = emit or (lambda _: None)
        self._bot_factory = bot_factory
        self._handler_factory = handler_factory
        self._clock = clock
        self._wall_clock = wall_clock
        self._condition = threading.Condition(threading.RLock())
        self._events = deque(maxlen=50)
        self._thread = self._bot = None
        self._cancel = threading.Event()
        self._operation = 0
        self._overrides = {}
        self._status = "idle"
        self._message = "봇을 시작하거나 문장으로 미리보기 할 수 있어요."
        self._send_mode = "preview"
        self._response_mode = "ai"
        self._channel = ""
        self._pending = None
        self._pending_deadline = 0.0
        self._decision = None
        self._closed = False

    def snapshot(self):
        with self._condition:
            provider = getattr(self.config, "LLM_PROVIDER", "ollama")
            return {
                "status": self._status, "message": self._message,
                "sendMode": self._send_mode, "responseMode": self._response_mode,
                "channelId": self._channel,
                "pending": dict(self._pending) if self._pending else None,
                "events": [dict(event) for event in self._events],
                "config": {
                    "provider": provider,
                    "baseUrl": getattr(self.config, "OLLAMA_HOST", "") if provider == "ollama" else getattr(self.config, "LLM_BASE_URL", ""),
                    "model": getattr(self.config, "OLLAMA_MODEL", "") if provider == "ollama" else getattr(self.config, "LLM_MODEL", ""),
                    "apiKeySet": bool(getattr(self.config, "LLM_API_KEY", "")),
                },
            }

    def _publish(self):
        self._emit({"event": "state", "state": self.snapshot()})

    def _idle(self):
        if self._closed:
            raise ValueError("제어 연결이 종료되었습니다.")
        if self._status not in ("idle", "error") or (self._thread and self._thread.is_alive()):
            raise ValueError("현재 작업을 중지한 뒤 다시 시도하세요.")

    def _event(self, event, operation):
        with self._condition:
            if operation != self._operation or self._cancel.is_set() or self._closed:
                return
            kind = event.get("type")
            if kind not in EVENT_TYPES:
                return
            record = {"id": uuid4().hex, "type": kind, "at": int(self._wall_clock() * 1000)}
            for key, size in (("speech", 2000), ("response", 100), ("reason", 120)):
                value = event.get(key)
                if isinstance(value, str) and value:
                    record[key] = value[:size]
            self._events.append(record)
            if kind == "status" and event.get("reason") == "running":
                self._status = "running"
                self._message = "보내지 않고 미리보기 중이에요." if self._send_mode == "preview" else "방송을 듣고 있어요."
            self._publish()

    def configure(self, arg):
        arg = _object(arg, {"provider", "baseUrl", "model", "apiKey"})
        with self._condition:
            self._idle()
            current = self.snapshot()["config"]
            provider = arg.get("provider", current["provider"])
            if provider not in ("ollama", "openai_compatible"):
                raise ValueError("AI 실행 위치를 확인하세요.")
            next_values = dict(self._overrides, LLM_PROVIDER=provider)
            # A credential belongs to its explicitly chosen destination. Never
            # forward the old key to a newly selected provider or base URL.
            if "apiKey" not in arg and (provider != current["provider"]
                    or ("baseUrl" in arg and isinstance(arg["baseUrl"], str)
                        and arg["baseUrl"].strip().rstrip("/") != current["baseUrl"].rstrip("/"))):
                next_values["LLM_API_KEY"] = ""
            for key, limit in (("baseUrl", 2048), ("model", 200), ("apiKey", 4096)):
                if key in arg:
                    value = _text(arg[key], key, limit, empty=key == "apiKey")
                    field = {"baseUrl": "OLLAMA_HOST" if provider == "ollama" else "LLM_BASE_URL",
                             "model": "OLLAMA_MODEL" if provider == "ollama" else "LLM_MODEL",
                             "apiKey": "LLM_API_KEY"}[key]
                    next_values[field] = value
            try:
                self.config.load(overrides=next_values)
                self.config.validate(require_channel=False)
            except Exception:
                self.config.load(overrides=self._overrides)
                raise ValueError("AI 설정을 저장하지 못했습니다. 주소·모델·키 형식을 확인하세요.") from None
            self._overrides = next_values
            self._status = "idle"
            self._message = "설정을 적용했어요. 문장 미리보기로 연결을 확인하세요."
            self._publish()
            return self.snapshot()

    def authenticate(self, arg):
        """Private parent-process credential handoff, never persisted or echoed."""
        arg = _object(arg, {"nidAut", "nidSes"})
        credentials = {}
        for name, target in (("nidAut", "NID_AUT"), ("nidSes", "NID_SES")):
            value = arg.get(name)
            if (not isinstance(value, str) or not 1 <= len(value) <= 8192
                    or any(ord(char) < 33 or ord(char) > 126 or char == ";" for char in value)):
                raise ValueError("앱의 네이버 로그인 상태를 확인하세요.")
            credentials[target] = value
        with self._condition:
            self._idle()
            next_values = {**self._overrides, **credentials}
            try:
                self.config.load(overrides=next_values)
                self.config.validate(require_channel=False)
            except Exception:
                self.config.load(overrides=self._overrides)
                raise ValueError("앱 로그인 정보를 적용하지 못했습니다. 연결 설정을 확인하세요.") from None
            self._overrides = next_values
            return self.snapshot()

    def _launch(self, operation):
        self._idle()
        self._operation += 1
        identifier = self._operation
        self._cancel = threading.Event()
        self._pending = self._decision = None
        self._status = "starting"
        self._message = "준비 중이에요."
        def work():
            failed = False
            failure_reason = "operation_failed"
            try:
                failed = operation(identifier) is False
            except ImportError:
                failed = True
                failure_reason = "dependencies_missing"
                self._event({"type": "error", "reason": failure_reason}, identifier)
            except Exception:
                failed = True
                self._event({"type": "error", "reason": "operation_failed"}, identifier)
            finally:
                with self._condition:
                    if identifier == self._operation:
                        self._bot = None
                        self._pending = self._decision = None
                        self._status = "error" if failed and not self._cancel.is_set() else "idle"
                        self._message = ("실행 패키지가 없습니다. 봇 설치 안내를 확인하세요." if failure_reason == "dependencies_missing"
                                         else "실행하지 못했습니다. 연결 설정·패키지·로그인을 확인하세요.") if self._status == "error" else "중지했어요." if self._cancel.is_set() else "작업을 마쳤어요."
                        self._condition.notify_all()
                        self._publish()
        self._thread = threading.Thread(target=work, name="Bot-Control-Operation", daemon=True)
        self._publish()
        self._thread.start()
        return self.snapshot()

    def preview(self, arg):
        arg = _object(arg, {"speech", "chat", "priorSpeech"})
        speech = _text(arg.get("speech"), "문장", 2000)
        chat = _text(arg.get("chat", ""), "채팅 문맥", 4000, empty=True)
        prior = arg.get("priorSpeech", [])
        if not isinstance(prior, list) or len(prior) > 5:
            raise ValueError("이전 발화는 최대 5개까지 입력하세요.")
        prior = tuple(_text(value, "이전 발화", 300) for value in prior)
        def operation(identifier):
            self.config.validate(require_channel=False)
            if self._handler_factory:
                handler = self._handler_factory()
            else:
                from llm_handler import LLMHandler
                handler = LLMHandler()
            if self._cancel.is_set():
                return
            self._event({"type": "heard", "speech": speech}, identifier)
            result = handler.generate_result(speech, chat, speech_context=prior)
            self._event({"type": result.status, "speech": speech,
                         "response": result.response, "reason": result.reason}, identifier)
            return result.status != "error"
        with self._condition:
            self._idle()
            self._send_mode = "preview"
            return self._launch(operation)

    def start(self, arg):
        arg = _object(arg, {"channelId", "sendMode", "responseMode"})
        from bot.settings import normalize_channel_id
        channel = normalize_channel_id(_text(arg.get("channelId"), "방송", 2048))
        send_mode = arg.get("sendMode", "preview")
        response_mode = arg.get("responseMode", "ai")
        if send_mode not in ("preview", "approve", "auto") or response_mode not in ("ai", "mimic", "hybrid"):
            raise ValueError("봇 실행 방식을 확인하세요.")
        def operation(identifier):
            self.config.validate(require_channel=False)
            factory = self._bot_factory
            if factory is None:
                from bot.runtime import ChzzkVoiceBot
                factory = ChzzkVoiceBot
            bot = factory(use_mock=send_mode == "preview", auto_send=send_mode != "approve",
                          channel_id=channel, non_interactive=True, mode=response_mode,
                          event_sink=lambda event: self._event(event, identifier),
                          approval_provider=self._approval if send_mode == "approve" else None)
            with self._condition:
                self._bot = bot
                cancelled = self._cancel.is_set()
            if cancelled:
                bot.request_stop()
                bot.stop()
                return
            if not bot.start() and not self._cancel.is_set():
                raise RuntimeError("session_failed")
        with self._condition:
            self._idle()
            if send_mode != "preview" and not (self.config.NID_AUT and self.config.NID_SES):
                raise ValueError("앱에서 네이버 로그인을 완료하거나 보내지 않는 미리보기를 선택하세요.")
            self._channel = channel
            self._send_mode = send_mode
            self._response_mode = response_mode
            return self._launch(operation)

    def _approval(self, candidate):
        with self._condition:
            remaining = self.config.RESPONSE_MAX_AGE_SECONDS - (self._clock() - candidate.observed_at)
            if remaining <= 0 or self._cancel.is_set():
                return {"action": "skip"}
            self._pending_deadline = self._clock() + remaining
            self._pending = {"id": uuid4().hex, "speech": candidate.speech[:2000],
                             "response": candidate.text[:100], "expiresAt": int((self._wall_clock() + remaining) * 1000)}
            self._decision = None
            self._publish()
            while self._decision is None and not self._cancel.is_set():
                remaining = self._pending_deadline - self._clock()
                if remaining <= 0:
                    break
                self._condition.wait(min(remaining, 0.25))
            decision = self._decision if not self._cancel.is_set() and self._clock() < self._pending_deadline else None
            self._pending = self._decision = None
            self._publish()
            return decision or {"action": "skip"}

    def approve(self, arg):
        arg = _object(arg, {"id", "action", "text"})
        identifier = _text(arg.get("id"), "제안 ID", 64)
        action = arg.get("action")
        if action not in ("send", "skip", "edit"):
            raise ValueError("전송 또는 생략을 선택하세요.")
        text = _text(arg.get("text"), "수정 답변", 100) if action == "edit" or "text" in arg else None
        with self._condition:
            if (self._pending is None or self._pending["id"] != identifier or self._decision is not None
                    or self._cancel.is_set() or self._clock() >= self._pending_deadline):
                raise ValueError("만료되었거나 이미 처리한 제안입니다.")
            self._decision = {"action": "edit" if text is not None and action == "send" else action}
            if text is not None:
                self._decision["text"] = text
            self._condition.notify_all()
            return self.snapshot()

    def stop(self):
        with self._condition:
            self._cancel.set()
            self._pending = self._decision = None
            self._condition.notify_all()
            if self._thread is not None and self._thread.is_alive():
                self._status = "stopping"
                self._message = "새 전송을 중지했어요. 진행 중인 작업을 정리하고 있어요."
            else:
                self._status = "idle"
                self._message = "중지했어요."
            bot = self._bot
            if bot is not None:
                bot.request_stop()
            self._publish()
            return self.snapshot()

    def close(self):
        self.stop()
        with self._condition:
            self._closed = True
        if self._thread is not None and self._thread is not threading.current_thread():
            self._thread.join(timeout=2)

    def dispatch(self, method, arg=None):
        if method == "getState":
            if arg not in (None, {}):
                raise ValueError("상태 조회에는 입력이 필요하지 않습니다.")
            return self.snapshot()
        if method == "stop":
            if arg not in (None, {}):
                raise ValueError("중지에는 입력이 필요하지 않습니다.")
            return self.stop()
        actions = {"configure": self.configure, "authenticate": self.authenticate,
                   "preview": self.preview, "start": self.start, "approve": self.approve}
        if method not in actions:
            raise ValueError("지원하지 않는 봇 명령입니다.")
        return actions[method](arg)


def run_control(*, input_stream=None, output_stream=None, factory=BotControl):
    source, destination = input_stream or sys.stdin, output_stream or sys.stdout
    write_lock = threading.Lock()
    def write(value):
        with write_lock:
            destination.write(json.dumps(value, ensure_ascii=True, allow_nan=False) + "\n")
            destination.flush()
    # Adapter logs may include source speech or HTTP exception details. The UI
    # receives only our bounded protocol; do not copy adapter logs to stderr.
    with open(os.devnull, "w", encoding="utf-8") as quiet, redirect_stdout(quiet), redirect_stderr(quiet):
        control = factory(emit=write)
        try:
            while True:
                line = source.readline(MAX_LINE + 1)
                if not line:
                    break
                if len(line) > MAX_LINE:
                    write({"id": None, "ok": False, "error": "요청이 너무 큽니다."})
                    break
                identifier = None
                try:
                    request = json.loads(line)
                    _object(request, {"id", "method", "arg"})
                    identifier = request.get("id")
                    if isinstance(identifier, bool) or not isinstance(identifier, (str, int)) or len(str(identifier)) > 80:
                        identifier = None
                        raise ValueError("요청 ID를 확인하세요.")
                    method = _text(request.get("method"), "명령", 40)
                    value = control.dispatch(method, request.get("arg"))
                    write({"id": identifier, "ok": True, "value": value})
                except json.JSONDecodeError:
                    write({"id": identifier, "ok": False, "error": "요청을 처리하지 못했습니다. 입력과 현재 봇 상태를 확인하세요."})
                except ValueError as error:
                    # Public command validation raises fixed messages only.
                    # Provider/session exceptions are caught in worker threads.
                    write({"id": identifier, "ok": False, "error": str(error)[:240]})
                except (TypeError, KeyError):
                    write({"id": identifier, "ok": False, "error": "요청 항목을 확인하세요."})
                except Exception:
                    write({"id": identifier, "ok": False, "error": "봇 제어 요청에 실패했습니다."})
        except (KeyboardInterrupt, BrokenPipeError):
            pass
        finally:
            try:
                control.close()
            except (OSError, BrokenPipeError):
                pass
    return 0
