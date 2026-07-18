"""배포 패키지 빌드 스크립트

Chzzk-Bot/ 소스를 ChzzkBot-Release/app/에 복사하고
python/ 폴더를 제외한 zip 파일을 생성합니다.

사용법:
    python build_dist.py          # 빌드만
    python build_dist.py --upload  # 빌드 + GitHub Release 업로드
"""
import os
import sys
import shutil
import zipfile
import subprocess
from pathlib import Path

VERSION = "1.0"

# 경로 설정
SCRIPT_DIR = Path(__file__).parent.resolve()
RELEASE_DIR = SCRIPT_DIR.parent / "ChzzkBot-Release"
APP_DIR = RELEASE_DIR / "app"
ZIP_PATH = SCRIPT_DIR.parent / f"ChzzkBot-v{VERSION}.zip"

# 복사할 소스 파일
SOURCE_FILES = [
    "main.py",
    "config.py",
    "core_logic.py",
    "chat_sender.py",
    "chat_reader.py",
    "llm_handler.py",
    "audio_capture.py",
    "speech_recognition.py",
    "requirements.txt",
    ".env.example",
    "LICENSE",
]

MEMORY_FILES = [
    "memory/__init__.py",
    "memory/memory_manager.py",
    "memory/memory_store.py",
]

# zip에서 제외할 폴더/파일
EXCLUDE_DIRS = {"python", "__pycache__", ".git"}
EXCLUDE_EXTS = {".pyc", ".pyo"}


def copy_sources():
    """소스 파일을 app/ 폴더에 복사"""
    if APP_DIR.exists():
        shutil.rmtree(APP_DIR)
    APP_DIR.mkdir(parents=True)
    (APP_DIR / "memory").mkdir()
    (APP_DIR / "data").mkdir()

    print("[1/3] 소스 파일 복사...")
    for f in SOURCE_FILES:
        src = SCRIPT_DIR / f
        if src.exists():
            shutil.copy2(src, APP_DIR / f)
            print(f"  {f}")
        else:
            print(f"  [skip] {f}")

    for f in MEMORY_FILES:
        src = SCRIPT_DIR / f
        dst = APP_DIR / f
        if src.exists():
            shutil.copy2(src, dst)
    print(f"  memory/*.py")


def create_zip():
    """python/ 폴더를 제외하고 zip 생성"""
    print(f"\n[2/3] ZIP 생성 (python/ 제외)...")
    if ZIP_PATH.exists():
        ZIP_PATH.unlink()

    with zipfile.ZipFile(ZIP_PATH, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(RELEASE_DIR):
            # 제외할 디렉토리 필터링
            dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]

            for file in files:
                if Path(file).suffix in EXCLUDE_EXTS:
                    continue
                full_path = Path(root) / file
                arc_name = full_path.relative_to(RELEASE_DIR)
                zf.write(full_path, arc_name)

    size_mb = ZIP_PATH.stat().st_size / 1024 / 1024
    print(f"  -> {ZIP_PATH.name} ({size_mb:.1f} MB)")


def upload_release():
    """GitHub Release에 zip 업로드"""
    print(f"\n[3/3] GitHub Release v{VERSION} 업로드...")
    tag = f"v{VERSION}"

    # 기존 asset 삭제 후 재업로드
    subprocess.run(
        ["gh", "release", "upload", tag, str(ZIP_PATH), "--clobber"],
        check=True,
    )
    print(f"  -> Release {tag} 업데이트 완료")


def main():
    if not RELEASE_DIR.exists():
        print(f"[ERROR] ChzzkBot-Release not found: {RELEASE_DIR}")
        sys.exit(1)

    print(f"=== ChzzkBot v{VERSION} Build ===\n")

    copy_sources()
    create_zip()

    if "--upload" in sys.argv:
        upload_release()

    print(f"\nDone!")


if __name__ == "__main__":
    main()
