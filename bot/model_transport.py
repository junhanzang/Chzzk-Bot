"""Model HTTP adapters. Prompt policy and final-send guards stay in LLMHandler."""

import requests
from bot.settings import normalize_api_base_url


class ModelTransportError(Exception):
    """Only a fixed reason code crosses into UI or reports, never HTTP bodies."""


class OllamaClient:
    provider = "ollama"

    def __init__(self, *, host, model, keep_alive):
        self.host, self.model, self.keep_alive = host.rstrip("/"), model, keep_alive
        self.api_url = self.host + "/api/chat"

    def generate(self, messages, options, *, timeout):
        response = requests.post(self.api_url, json={
            "model": self.model, "messages": messages, "stream": False,
            "think": False, "keep_alive": self.keep_alive, "options": options,
        }, timeout=timeout)
        if response.status_code != 200:
            raise ModelTransportError(f"http_{response.status_code}")
        return response.json()


class OpenAICompatibleClient:
    provider = "openai_compatible"

    def __init__(self, *, base_url, model, api_key=""):
        self.host = normalize_api_base_url(base_url)
        self.model = model
        if not isinstance(api_key, str) or len(api_key) > 8192 or any(ord(c) < 33 or ord(c) > 126 for c in api_key):
            raise ValueError("API 키 형식을 확인하세요.")
        self._api_key = api_key
        self.api_url = self.host + "/chat/completions"

    def generate(self, messages, options, *, timeout):
        # No redirects: a changed endpoint must never receive a stored key.
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = "Bearer " + self._api_key
        response = requests.post(self.api_url, json={
            "model": self.model, "messages": messages, "stream": False, **options,
        }, headers=headers, timeout=timeout, allow_redirects=False)
        if response.status_code != 200:
            raise ModelTransportError(f"http_{response.status_code}")
        payload = response.json()
        if not isinstance(payload, dict) or not isinstance(payload.get("choices"), list) or not payload["choices"]:
            raise ModelTransportError("invalid_payload")
        choice = payload["choices"][0]
        if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
            raise ModelTransportError("invalid_payload")
        message = choice["message"]
        reason = choice.get("finish_reason")
        if message.get("refusal") or reason == "content_filter":
            return {"message": {"content": ""}, "done_reason": "content_filter"}
        if reason not in ("stop", "length") or message.get("tool_calls") or message.get("function_call"):
            raise ModelTransportError("invalid_payload")
        return {"message": {"content": message.get("content")}, "done_reason": reason}
