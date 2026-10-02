"""Read-only preflight checks: no model, browser, account or audio access."""

from dataclasses import dataclass
import importlib.util
import json
import sys
from urllib.error import URLError
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class Diagnostic:
    name: str
    status: str
    detail: str
    action: str = ""


def model_is_available(wanted, models):
    """Ollama's omitted tag means :latest; prefixes are never a match."""
    def canonical(name):
        if not isinstance(name, str) or not name.strip():
            return None
        text = name.strip()
        return text if ":" in text.rsplit("/", 1)[-1] else text + ":latest"

    target = canonical(wanted)
    if target is None or not isinstance(models, list):
        return False
    return any(canonical(model.get("name", "")) == target
               or canonical(model.get("model", "")) == target
               for model in models if isinstance(model, dict))


def _ollama_models(host, *, timeout=3):
    request = Request(host.rstrip("/") + "/api/tags", headers={"Accept": "application/json"})
    with urlopen(request, timeout=timeout) as response:
        payload = response.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024:
        raise ValueError("Ollama 응답이 너무 큽니다.")
    data = json.loads(payload)
    if not isinstance(data, dict) or not isinstance(data.get("models"), list):
        raise ValueError("Ollama 모델 목록 형식이 올바르지 않습니다.")
    return data["models"]


def collect_diagnostics(config, *, find_spec=None, fetch_models=None):
    find_spec = importlib.util.find_spec if find_spec is None else find_spec
    fetch_models = _ollama_models if fetch_models is None else fetch_models
    checks = []
    checks.append(Diagnostic("Python", "ok" if sys.version_info >= (3, 11) else "error",
                             "Python 3.11 이상 필요", "Python 3.11 이상을 설치하세요." if sys.version_info < (3, 11) else ""))
    errors = config.validation_errors(require_channel=False)
    checks.append(Diagnostic("설정", "error" if errors else "ok", " / ".join(errors) if errors else "형식 검사 통과",
                             "python main.py --setup" if errors else ""))
    checks.append(Diagnostic("방송 채널", "ok" if config.CHZZK_CHANNEL_ID else "warning",
                             "설정됨" if config.CHZZK_CHANNEL_ID else "실행 때 입력 필요", "python main.py --setup" if not config.CHZZK_CHANNEL_ID else ""))
    both_cookies = bool(config.NID_AUT and config.NID_SES)
    checks.append(Diagnostic("로그인 쿠키", "ok" if both_cookies else "warning",
                             "두 항목 저장됨 (유효성은 실전 연결 때 확인)" if both_cookies else "미설정 또는 불완전",
                             "첫 실전 실행에서 로그인하세요. --mock은 로그인 없이 전송을 연습합니다." if not both_cookies else ""))
    packages = {"chzzkpy": "chzzkpy", "requests": "requests"}
    if config.RESPONSE_MODE != "mimic":
        packages.update({"torch": "torch", "qwen_asr": "qwen-asr", "soundcard": "soundcard", "numpy": "numpy"})
    for module, package in packages.items():
        try:
            installed = find_spec(module) is not None
        except (ImportError, ValueError, AttributeError):
            installed = False
        action = "README의 설치 순서에 따라 pip install -r requirements.txt 를 실행하세요." if not installed else ""
        checks.append(Diagnostic(package, "ok" if installed else "error", "설치됨 (가져오기·장치 접근 생략)" if installed else "설치되지 않음", action))
    if config.RESPONSE_MODE == "mimic":
        checks.append(Diagnostic("오디오·AI", "ok", "mimic 모드: 음성 인식과 Ollama 모델이 필요하지 않습니다."))
    elif not any(error.startswith(("OLLAMA_HOST:", "OLLAMA_MODEL:")) for error in errors):
        try:
            models = fetch_models(config.OLLAMA_HOST, timeout=3)
            available = model_is_available(config.OLLAMA_MODEL, models)
            checks.append(Diagnostic("Ollama 모델", "ok" if available else "error",
                                     "설정한 모델 설치됨" if available else "서버에 설정한 모델이 없습니다.",
                                     "" if available else "ollama list 로 설치 목록을 확인하고 OLLAMA_MODEL을 맞추세요. 필요한 모델은 ollama pull 모델명으로 직접 설치할 수 있습니다."))
        except (OSError, URLError, TimeoutError, ValueError, TypeError):
            checks.append(Diagnostic("Ollama 연결", "error", "모델 목록을 가져오지 못했습니다.",
                                     "Ollama를 실행하고 OLLAMA_HOST 주소를 확인하세요. 최대 대기시간은 3초입니다."))
        checks.append(Diagnostic("오디오·GPU", "warning", "장치와 실제 모델 실행은 이 진단에서 검사하지 않습니다.",
                                 "방송 소리를 재생한 뒤 python main.py --mock 으로 확인하세요. --mock도 음성·모델은 사용합니다."))
    return checks


def run_doctor(config, *, output=print, **kwargs):
    output("실행 준비 상태 - 로그인·모델 로딩·오디오 장치 접근 없이 검사합니다.")
    checks = collect_diagnostics(config, **kwargs)
    labels = {"ok": "통과", "warning": "안내", "error": "수정 필요"}
    for check in checks:
        output(f"[{labels[check.status]}] {check.name}: {check.detail}")
        if check.action:
            output(f"  → {check.action}")
    failed = sum(check.status == "error" for check in checks)
    output(f"진단 완료: 수정 필요 {failed}개. 실제 연결·모델 응답 품질은 실행 후 확인하세요.")
    return 1 if failed else 0
