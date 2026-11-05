"""External model tests never contact a provider or require credentials."""
from types import SimpleNamespace

import pytest

from bot.settings import parse_settings, normalize_api_base_url
from bot.model_transport import OpenAICompatibleClient
from config import Config
from llm_handler import LLMHandler
import llm_handler


def compatible(monkeypatch, *, content="잘 해냈네", finish="stop", status=200, message=None):
    calls = []
    def post(url, **kwargs):
        calls.append((url, kwargs))
        return SimpleNamespace(status_code=status, json=lambda: {"choices":[{
            "message": message if message is not None else {"content":content}, "finish_reason":finish}]})
    monkeypatch.setattr(llm_handler.requests, "post", post)
    handler = LLMHandler(provider="openai_compatible", model_name="provided-model",
                         base_url="https://api.example.test/v1", api_key="FAKE-KEY", seed=0)
    return handler, calls


def test_external_transport_uses_only_supported_options_and_never_follows_redirects(monkeypatch):
    handler, calls = compatible(monkeypatch)
    result = handler.generate_result("목표를 달성했어", speech_context=("마지막 한 번 남았어",), timeout_seconds=4.5)
    assert result.status == "generated"
    url, args = calls[0]
    assert url == "https://api.example.test/v1/chat/completions"
    assert args["headers"]["Authorization"] == "Bearer FAKE-KEY"
    assert args["allow_redirects"] is False and args["timeout"] == 4.5
    assert args["json"]["max_completion_tokens"] == Config.LLM_MAX_TOKENS
    assert not {"think", "keep_alive", "seed", "temperature", "options"} & args["json"].keys()
    assert "마지막 한 번 남았어" in args["json"]["messages"][1]["content"]
    assert "FAKE-KEY" not in str(result) and not handler.context


@pytest.mark.parametrize("content,finish,status,reason", [
    ("[SKIP]", "stop", "skipped", "model_skip"),
    ("하다가 끊겼", "length", "filtered", "token_limit"),
    ("", "length", "filtered", "token_limit"),
    ("차단", "content_filter", "filtered", "provider_filter"),
    ("설명 [SKIP]", "stop", "filtered", "invalid_format"),
    ("답변", "tool_calls", "error", "invalid_payload"),
    (None, "stop", "error", "invalid_payload"),
])
def test_external_results_use_same_skip_filter_and_failure_policy(monkeypatch, content, finish, status, reason):
    handler, _ = compatible(monkeypatch, content=content, finish=finish)
    result = handler.generate_result("지금 어떤가")
    assert (result.status,result.reason) == (status,reason)


@pytest.mark.parametrize("status", [302,401,429,500])
def test_external_http_errors_never_echo_body_or_credentials(monkeypatch, capsys, status):
    handler, calls = compatible(monkeypatch, content="FAKE-KEY SECRET BODY", status=status)
    result = handler.generate_result("발언")
    assert (result.status,result.reason) == ("error", f"http_{status}")
    assert not result.raw_text
    assert "FAKE-KEY" not in str(result) + capsys.readouterr().out
    assert len(calls) == 1


def test_remote_refusal_does_not_become_chat(monkeypatch):
    handler, _ = compatible(monkeypatch, message={"content":None,"refusal":"이유"})
    result = handler.generate_result("발언")
    assert (result.status,result.reason) == ("filtered","provider_filter")


@pytest.mark.parametrize("url", ["http://api.example.test/v1", "https://user:pass@example.test/v1",
                                  "https://example.test/v1?key=SECRET", "https://example.test/v1#SECRET",
                                  "https://exa\nmple.test/v1", "file:///example", "https://example.test/v1/chat/completions"])
def test_external_endpoint_rejects_unsafe_or_full_completion_urls(url):
    with pytest.raises(ValueError):
        normalize_api_base_url(url)


@pytest.mark.parametrize("url", ["https://example.test/v1/", "http://localhost:1234/v1", "http://127.0.0.1:1234/v1", "http://[::1]:1234/v1"])
def test_local_compatible_servers_and_https_are_supported(url):
    assert normalize_api_base_url(url) == url.rstrip("/")


def test_provider_validation_and_key_errors_are_secret_free():
    values, errors = parse_settings({"LLM_PROVIDER":"openai_compatible", "LLM_MODEL":"example-model",
                                    "LLM_BASE_URL":"https://example.test/v1", "LLM_API_KEY":"SECRET\nVALUE",
                                    "OLLAMA_HOST":"deleted", "OLLAMA_MODEL":""})
    assert values["LLM_PROVIDER"] == "openai_compatible"
    assert errors == ["LLM_API_KEY: 공백이나 줄바꿈 없는 API 키가 필요합니다."]
    assert "SECRET" not in str(errors)
    assert not values["LLM_API_KEY"]


def test_external_readiness_check_does_not_make_billable_or_metadata_requests(monkeypatch, capsys):
    handler, calls = compatible(monkeypatch)
    monkeypatch.setattr(llm_handler.requests, "get", lambda *_a,**_k: pytest.fail("No metadata requests"))
    assert handler.check_connection()
    assert not calls and "실제 연결은 첫 응답 요청" in capsys.readouterr().out


def test_external_evaluation_metadata_never_probes_ollama_endpoints(monkeypatch):
    from bot.evaluation import collect_model_metadata
    handler, _ = compatible(monkeypatch)
    metadata = collect_model_metadata(handler, fetch_json=lambda *_: pytest.fail("No Ollama metadata"))
    assert metadata["provider"] == "openai_compatible" and metadata["seed"] is None
    assert metadata["generation_options"] == handler.generation_options
    assert "FAKE-KEY" not in str(metadata)


def test_memory_summaries_follow_selected_external_provider(monkeypatch):
    from memory.memory_manager import MemoryManager
    monkeypatch.setattr(Config,"LLM_PROVIDER","openai_compatible")
    monkeypatch.setattr(Config,"LLM_MODEL","example-model")
    monkeypatch.setattr(Config,"LLM_BASE_URL","https://api.example.test/v1")
    monkeypatch.setattr(Config,"LLM_API_KEY","FAKE-KEY")
    _, calls = compatible(monkeypatch, content='["퍼즐을 좋아함"]')
    manager = MemoryManager(None,None,None)
    assert manager._call_llm_for_facts("가상 대화") == ["퍼즐을 좋아함"]
    assert calls[0][0] == "https://api.example.test/v1/chat/completions"
