# Python 봇 구조와 변경 기준

## 진입점과 모듈 경계

`main.py`는 CLI 진입점이며 기존 `ChzzkVoiceBot` import를 지연해서 호환합니다. 도움말·설정·데모를 위해 장치나 모델 라이브러리를 가져오지 않습니다.

| 모듈 | 책임 |
|---|---|
| `bot/cli.py`, `bot/launcher.py` | 명령 해석, 시작 메뉴, 실행 경로 선택 |
| `bot/settings.py`, `config.py` | 의존성 없는 설정 파싱·검증, 설정 우선순위 |
| `bot/setup.py`, `bot/diagnostics.py` | 기존 값을 보존하는 설정 저장, 실행 전 진단 |
| `bot/runtime.py` | 세션 생명주기, 승인, 최종 전송 경계 |
| `bot/session.py` | 모드별 자원 초기화와 주입 가능한 서비스 팩토리 |
| `bot/workers.py` | 음성 관찰·최근 발화 유지·AI 생성 작업 |
| `bot/reactions.py` | 채팅 반응과 후원 TTS 필터 정책 |
| `bot/connection.py`, `bot/auth.py` | 연결 종료·재연결 지원, 인증·쿠키 저장 |
| `bot/replay.py`, `bot/telemetry.py` | 전송 없는 시나리오 점검, 원문 없는 세션 카운터 |
| `response_pipeline.py`, `audio_buffer.py` | 시간·세대·상한이 있는 대기열 정책 |
| `core_logic.py` | 입출력 없는 프롬프트·응답 가드·재연결 정책 |
| `chat_reader.py`, `chat_sender.py` | 치지직 수신·전송 어댑터 |
| `audio_capture.py`, `speech_recognition.py`, `llm_handler.py` | 오디오·ASR·Ollama 어댑터 |
| `memory/` | 채널별 기억, 일관된 요약 작업과 원자적 저장 |

런타임은 워커·반응 정책·세션을 조합합니다. 장치 팩토리를 주입할 수 있어서 실제 브라우저·계정·GPU 없이 시작 실패와 자원 정리를 검증합니다. 기존 내부 메서드 일부는 호환 위임으로 유지하며 새 동작은 해당 책임 모듈에 추가합니다.

## 유지해야 하는 성질

- 발화 시간은 오디오 캡처 시점입니다. 추론·승인·재연결이 시간을 갱신해서 오래된 답변을 되살리면 안 됩니다.
- 생성한 초안, 취소한 답변, 실패한 전송은 실제 보낸 대화로 기억하지 않습니다. 직접 수정한 답변은 최종 문장만 기록합니다.
- 모든 발화 경로는 전송 직전 유효시간·모드 세대·응답 간격·텍스트 가드를 통과해야 합니다.
- 모드 전환은 이전 세대의 결과를 무효화합니다. 자원 준비 실패 시 모드를 변경하지 않습니다.
- 종료는 여러 번 호출해도 한 번만 정리합니다. 일부 자원 정리에 실패해도 나머지를 정리합니다.
- 전송 결과가 불확실한 경우 같은 메시지를 자동 재시도하지 않습니다. 네트워크 연결의 재접속과 메시지 재전송을 구분합니다.
- 진단과 배포 파일에 실제 쿠키나 개인 기억을 포함하지 않습니다. 설정 저장 시 지정한 키 외에는 보존합니다.

## 검증과 배포

```powershell
python -m pip install -r requirements-ci.txt
python -m pytest tests -q
python -S main.py --demo
python build_dist.py
```

CI의 Python 작업은 Windows/Linux에서 실행합니다. 가짜 장치·가짜 전송·가짜 시계로 오류와 경쟁 조건을 검사하며, 배포 ZIP을 새 폴더에서 `python -S main.py --demo`로 검증합니다. 실제 모델 문장 품질은 `--replay ... --generate --report ...`의 결과를 검토합니다. 데모·규칙 테스트 통과를 자연스러움의 실측 결과로 보고하지 않습니다.

새 Python 모듈은 `bot/` 또는 `memory/`의 최상위 `.py` 파일이면 배포에 자동 포함됩니다. 새로운 패키지나 데이터 파일을 만들면 `build_dist.py`의 허용 목록과 배포 검증을 함께 갱신합니다. private 데이터 디렉터리를 통째로 복사하지 않습니다.
