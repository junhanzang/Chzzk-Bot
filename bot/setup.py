"""Interactive first-run setup and atomic, secret-preserving dotenv updates."""

import os
import re
import tempfile
import threading
from pathlib import Path

from bot.settings import ENV_PATH, normalize_channel_id, parse_settings, read_env_values

_WRITE_LOCK = threading.RLock()


def _quoted(value):
    text = str(value).replace("\\", "\\\\").replace('"', '\\"')
    return '"' + text.replace("\r", "\\r").replace("\n", "\\n").replace("\t", "\\t") + '"'


def write_env_values(path, updates):
    """Upsert only requested keys, retaining all unrelated lines and cookies.

    A same-directory temporary file plus replace prevents partial configuration
    on interruption. Secret values never appear in messages or exceptions.
    """
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) for key in updates):
        raise ValueError("설정 키 형식이 올바르지 않습니다.")
    path = Path(path)
    with _WRITE_LOCK:
        previous = path.read_bytes().decode("utf-8-sig") if path.exists() else ""
        newline = "\r\n" if "\r\n" in previous else "\n"
        seen = set()
        lines = []
        for line in previous.splitlines():
            match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=", line)
            key = match[1] if match else None
            if key in updates:
                if key not in seen:
                    lines.append(f"{key}={_quoted(updates[key])}")
                    seen.add(key)
            else:
                lines.append(line)
        lines.extend(f"{key}={_quoted(value)}" for key, value in updates.items() if key not in seen)
        content = newline.join(lines) + newline
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="",
                                             prefix=f".{path.name}.", suffix=".tmp",
                                             dir=path.parent, delete=False) as file:
                temporary = Path(file.name)
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            if path.exists():
                os.chmod(temporary, path.stat().st_mode & 0o777)
            os.replace(temporary, path)
        finally:
            if temporary is not None and temporary.exists():
                temporary.unlink()


def run_setup(path=None, *, input_fn=None, output=print):
    """Save a reusable channel and playback settings; never ask for cookie text."""
    path = ENV_PATH if path is None else Path(path)
    input_fn = input if input_fn is None else input_fn
    try:
        existing = read_env_values(path)
        defaults, _ = parse_settings(existing)
        output("방송 봇 초기 설정 - Enter는 현재 값을 유지합니다. Ctrl+C로 취소할 수 있어요.")
        output("기존 로그인 쿠키와 다른 설정은 보존합니다. 로그인은 실전 실행 때 진행합니다.")
        updates = {}

        def ask(key, label, validate=None, *, allow_blank=False):
            default = str(defaults[key])
            while True:
                value = input_fn(f"{label} [{default or '미설정'}]: ").strip() or default
                if allow_blank and value == "-":
                    value = ""
                if not value and not allow_blank:
                    output("값을 입력하세요.")
                    continue
                try:
                    result = validate(value) if validate and value else value
                    updates[key] = result
                    return
                except ValueError as error:
                    output(str(error))

        def validate_field(key):
            def validate(value):
                _, errors = parse_settings({key: value})
                if errors:
                    raise ValueError(errors[0])
                return value
            return validate

        ask("CHZZK_CHANNEL_ID", "치지직 방송 URL 또는 채널 ID", normalize_channel_id)
        ask("RESPONSE_MODE", "응답 모드 (ai / hybrid / mimic)", validate_field("RESPONSE_MODE"))
        ask("OLLAMA_MODEL", "Ollama 모델", validate_field("OLLAMA_MODEL"))
        ask("OLLAMA_HOST", "Ollama 주소", validate_field("OLLAMA_HOST"))
        ask("AUDIO_SPEAKER_ID", "출력 장치 ID (--list-speakers로 확인, -는 시스템 기본 장치)", allow_blank=True)
        ask("RESPONSE_COOLDOWN", "최소 응답 간격(초)", validate_field("RESPONSE_COOLDOWN"))
        # Only update these keys. In particular, never serialize DEFAULTS over
        # existing unknown options, login secrets, comments, or advanced values.
        write_env_values(path, updates)
    except (EOFError, KeyboardInterrupt):
        output("\n설정을 취소했습니다. 파일은 변경하지 않았습니다.")
        return 130
    except (OSError, UnicodeError):
        output("설정을 저장하지 못했습니다. .env 파일의 경로와 쓰기 권한을 확인하세요.")
        return 1
    output("설정을 저장했습니다. python main.py --doctor 로 실행 준비 상태를 확인하세요.")
    output("채팅 전송 없이 확인: python main.py --mock --non-interactive")
    return 0
