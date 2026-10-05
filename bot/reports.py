"""Atomic JSON reports shared by offline replay and model evaluation."""

import json
import os
from pathlib import Path
import tempfile


def write_report(path, report):
    path = Path(path)
    if path.suffix.lower() != ".json":
        raise ValueError("보고서 경로는 .json으로 지정하세요.")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent,
                                         suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
