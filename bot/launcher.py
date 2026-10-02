"""Small terminal menu. Each command receives a freshly loaded configuration."""

from pathlib import Path
import subprocess
import sys


CHOICES = {
    "1": ("처음 설정 / 설정 변경", ["--setup"]),
    "2": ("실행 환경 진단", ["--doctor"]),
    "3": ("모델 없이 동작 데모", ["--demo"]),
    "4": ("방송을 들으며 미리보기 (실제 채팅 전송 없음)", ["--mock", "--auto"]),
    "5": ("채팅 봇 실행 (메시지마다 승인)", []),
    "6": ("채팅 봇 실행 (자동 전송)", ["--auto"]),
}


def main():
    script = Path(__file__).resolve().parents[1] / "main.py"
    while True:
        print("\n치지직 채팅 봇\n처음이라면 1 → 2 → 4 순서로 시작하세요.")
        for key, (label, _) in CHOICES.items():
            print(f"  {key}. {label}")
        print("  0. 종료")
        try:
            choice = input("선택: ").strip()
        except (EOFError, KeyboardInterrupt):
            return 0
        if choice == "0":
            return 0
        if choice not in CHOICES:
            print("0~6 중에서 선택하세요.")
            continue
        try:
            result = subprocess.call([sys.executable, str(script), *CHOICES[choice][1]], cwd=script.parent)
        except KeyboardInterrupt:
            print("\n실행을 중단했습니다.")
            continue
        if result:
            print(f"실행이 완료되지 않았습니다 (종료 코드 {result}). 위 안내를 확인하세요.")
