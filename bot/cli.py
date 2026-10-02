"""Lightweight CLI: help, setup and offline replay work without AI packages."""

import argparse
import sys


def build_parser():
    parser = argparse.ArgumentParser(
        description="치지직 방송 맥락을 참고하는 채팅 봇",
        epilog="처음 실행: --setup → --doctor → --mock. --demo는 모델·음성·로그인 없이 실행합니다.")
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument("--menu", action="store_true", help="설정·진단·실행 메뉴")
    actions.add_argument("--setup", action="store_true", help="채널·모델·응답 간격을 .env에 저장")
    actions.add_argument("--doctor", action="store_true", help="설정·패키지·Ollama 준비 상태 진단")
    actions.add_argument("--demo", action="store_true", help="모델 없이 기본 방송 상황 예제로 검사")
    actions.add_argument("--replay", metavar="JSON", help="저장한 방송 상황을 채팅 전송 없이 재현")
    actions.add_argument("--list-speakers", action="store_true", help="사용 가능한 출력 장치의 ID 표시")
    parser.add_argument("--generate", action="store_true", help="--demo/--replay에서 Ollama로 답변 생성 (채팅 전송 없음)")
    parser.add_argument("--report", metavar="JSON", help="--demo/--replay 결과를 JSON 파일로 저장")
    parser.add_argument("--channel", metavar="URL_OR_ID", help="이번 실행의 치지직 방송 URL 또는 채널 ID")
    parser.add_argument("--mode", choices=("ai", "hybrid", "mimic"), help="이번 실행의 응답 모드")
    parser.add_argument("--speaker", metavar="ID", help="출력 장치 ID (--list-speakers로 확인)")
    parser.add_argument("--non-interactive", action="store_true", help="질문·브라우저 로그인 없이 실행 (실전 전송은 --auto 필요)")
    parser.add_argument("--mock", action="store_true", help="채팅 전송을 콘솔 출력으로 대체 (AI 모드는 오디오·모델 사용)")
    parser.add_argument("--auto", action="store_true", help="제안한 답변을 개별 승인 없이 자동 전송")
    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    replaying = args.demo or args.replay is not None
    if (args.generate or args.report) and not replaying:
        parser.error("--generate와 --report는 --demo 또는 --replay와 함께 사용하세요.")
    if (args.setup or args.menu) and args.non_interactive:
        parser.error("--setup과 --menu는 입력이 필요하므로 --non-interactive와 함께 사용할 수 없습니다.")
    if args.menu:
        from bot.launcher import main as menu
        return menu()
    if args.setup:
        from bot.setup import run_setup
        return run_setup()
    if replaying and not args.generate:
        from bot.replay import run_replay
        return run_replay(args.replay, generate=False, report_path=args.report)
    if args.list_speakers:
        try:
            import soundcard
            speakers = soundcard.all_speakers()
            for speaker in speakers:
                print(f"{speaker.name}\n  --speaker \"{speaker.id}\"")
            if not speakers:
                print("출력 장치가 없습니다. Windows 소리 설정에서 출력 장치를 확인하세요.")
                return 1
            return 0
        except ImportError:
            print("soundcard가 설치되지 않았습니다. pip install soundcard 로 설치하세요.", file=sys.stderr)
            return 1
        except Exception:
            print("출력 장치를 읽을 수 없습니다. 시스템 소리 설정을 확인하세요.", file=sys.stderr)
            return 1
    from config import Config
    Config.load(overrides={"CHZZK_CHANNEL_ID": args.channel, "RESPONSE_MODE": args.mode,
                           "AUDIO_SPEAKER_ID": args.speaker})
    if args.doctor:
        from bot.diagnostics import run_doctor
        return run_doctor(Config)
    try:
        Config.validate(require_channel=args.non_interactive and not replaying)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    if replaying:
        from bot.replay import run_replay
        return run_replay(args.replay, generate=True, report_path=args.report)
    if args.non_interactive and not args.mock and not args.auto:
        print("--non-interactive 실전 실행은 --auto가 필요합니다. 전송 없이 확인하려면 --mock을 쓰세요.", file=sys.stderr)
        return 2
    if args.non_interactive and not args.mock and not (Config.NID_AUT and Config.NID_SES):
        print("저장된 로그인 쿠키가 없습니다. 먼저 python main.py 로 로그인하거나 --mock으로 확인하세요.", file=sys.stderr)
        return 2
    if args.mock:
        print("[미리보기] 실제 채팅을 전송하지 않습니다. AI 모드는 방송 오디오와 모델을 사용합니다.")
    elif args.auto:
        print("[자동 전송] 설정한 채널에 답변을 자동으로 보냅니다. Ctrl+C로 종료합니다.")
    else:
        print("[승인 모드] 답변을 확인한 뒤 전송합니다. --auto로 자동 전송할 수 있어요.")
    try:
        from bot.runtime import ChzzkVoiceBot
        bot = ChzzkVoiceBot(use_mock=args.mock, auto_send=args.auto,
                           channel_id=Config.CHZZK_CHANNEL_ID or None,
                           speaker_id=Config.AUDIO_SPEAKER_ID or None,
                           non_interactive=args.non_interactive, mode=Config.RESPONSE_MODE)
        return 0 if bot.start() else 1
    except KeyboardInterrupt:
        print("\n봇을 종료했습니다.")
        return 130
    except (ImportError, ModuleNotFoundError):
        print("실행에 필요한 패키지를 불러오지 못했습니다. python main.py --doctor 로 설치 상태를 확인하세요.", file=sys.stderr)
        return 1
    except Exception as error:
        # Third-party auth/device exceptions can contain tokens or requests.
        print(f"실행을 완료하지 못했습니다 ({type(error).__name__}). 위 안내와 --doctor 진단을 확인하세요.", file=sys.stderr)
        return 1
