"""Explicit inference outcomes shared by live workers and offline evaluation."""

from dataclasses import dataclass
from typing import Literal


@dataclass(frozen=True)
class GenerationResult:
    status: Literal["generated", "skipped", "filtered", "error"]
    response: str | None = None
    raw_text: str = ""
    reason: str = ""
    latency_seconds: float = 0.0
