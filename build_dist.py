"""Build an allowlisted Python source ZIP, excluding settings and user data.

    python build_dist.py
    python build_dist.py --output release/chzzk-bot-source.zip
    python build_dist.py --upload --tag <existing-release-tag>

No directory removal or external release update occurs by default.
"""

import argparse
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile


SCRIPT_DIR = Path(__file__).resolve().parent
SOURCE_FILES = (
    "main.py", "config.py", "core_logic.py", "response_pipeline.py",
    "audio_buffer.py", "audio_capture.py", "speech_recognition.py",
    "llm_handler.py", "chat_reader.py", "chat_sender.py", "requirements.txt",
    ".env.example", "LICENSE", "README.md", "start-bot.cmd",
    "examples/bot-demo.json", "examples/bot-quality.json",
    "docs/BOT.md", "docs/BOT_ARCHITECTURE.md",
)
PACKAGE_DIRS = ("bot", "memory")


def source_files(source=SCRIPT_DIR):
    source = Path(source).resolve()
    names = set(SOURCE_FILES)
    for package in PACKAGE_DIRS:
        names.add(f"{package}/__init__.py")
        names.update(path.relative_to(source).as_posix() for path in (source / package).glob("*.py"))
    for name in sorted(names):
        path = source / name
        if not path.is_file():
            raise ValueError(f"배포에 필요한 파일이 없습니다: {name}")
        if path.is_symlink() or not path.resolve().is_relative_to(source):
            raise ValueError(f"배포 원본은 프로젝트 내부 일반 파일이어야 합니다: {name}")
        yield name, path


def build_zip(output=None, *, source=SCRIPT_DIR):
    source = Path(source).resolve()
    output = Path(output) if output else source / "release" / "chzzk-bot-source.zip"
    if output.suffix.lower() != ".zip":
        raise ValueError("배포 출력 경로는 .zip으로 지정하세요.")
    files = list(source_files(source))
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".zip.tmp", delete=False) as stream:
            temporary = Path(stream.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, path in files:
                info = zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = 0o100644 << 16
                # Git may use CRLF on Windows and LF on Linux. Normalize text
                # so both CI runners produce the same source archive; retain
                # native CRLF for the Windows launcher.
                payload = path.read_bytes().replace(b"\r\n", b"\n")
                if name.endswith(".cmd"):
                    payload = payload.replace(b"\n", b"\r\n")
                archive.writestr(info, payload)
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    checksum = output.with_suffix(output.suffix + ".sha256")
    checksum.write_text(f"{digest}  {output.name}\n", encoding="utf-8")
    return output, checksum


def main(argv=None):
    parser = argparse.ArgumentParser(description="계정·메모리·모델을 제외한 봇 소스 ZIP 생성")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--upload", action="store_true", help="지정한 기존 GitHub Release에 업로드")
    parser.add_argument("--tag", help="--upload 대상인 기존 릴리스 태그")
    args = parser.parse_args(argv)
    if args.upload and not args.tag:
        parser.error("--upload에는 --tag가 필요합니다.")
    try:
        archive, checksum = build_zip(args.output)
        print(f"봇 소스 ZIP: {archive.resolve()}")
        print(f"SHA-256: {checksum.resolve()}")
        if args.upload:
            subprocess.run(["gh", "release", "upload", args.tag, str(archive), str(checksum)], check=True)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(f"배포 파일 생성/업로드 실패: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
