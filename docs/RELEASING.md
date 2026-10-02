# 검사와 배포

Python 봇의 기존 `v1.0.x` 릴리스와 데스크 앱의 배포를 구분한다. 데스크 앱·확장의 공통 버전은 `desktop/package.json`, `desktop/package-lock.json`(최상위와 루트 패키지), `browser-extension/package.json`, `browser-extension/manifest.json`에 맞춘다. 태그는 `desk-v0.3.0` 형식이다.

## GitHub Actions

`.github/workflows/ci.yml`은 main 푸시, PR, 수동 실행에 동작한다.

1. Windows에서 잠금 파일로 의존성을 설치한다.
2. 버전·릴리스 노트, JavaScript 문법, 단위 테스트와 모듈 의존성을 확인한다.
3. 합성 방송으로 RPC 녹화·MP4 디코딩을 검사한다. 실제 앱·브라우저를 열지 않는다.
4. Windows 설치 파일·ZIP과 Chrome 확장 ZIP을 생성하고 패키지 내부 파일을 검사한다.
5. 배포 파일과 `SHA256SUMS.txt`를 Actions의 `chzzk-desk-distribution` 아티팩트에 14일간 보관한다.
6. 별도 Linux 작업에서 Python core 테스트를 실행한다. GPU·음성 인식용 의존성은 설치하지 않는다.

`.github/workflows/release.yml`은 `desk-v*` 태그 푸시에서 같은 CI를 실행한다. **모든 작업 성공 후** 이번 실행의 파일을 받아 체크섬을 확인하고 GitHub Releases에 시험 배포한다. 기존 Python 릴리스의 Latest 표시는 바꾸지 않는다. 태그·버전이 다르거나 릴리스 노트가 없으면 배포하지 않는다. 이미 있는 릴리스의 파일도 덮어쓰지 않는다.

GitHub 기본 `GITHUB_TOKEN`을 쓰므로 게시용 개인 토큰을 저장소 Secret에 추가하지 않는다. 게시 작업만 `contents: write`를 받고, 테스트·빌드는 읽기 권한을 쓴다. 외부 Actions는 정확한 커밋으로 고정하고 Dependabot이 업데이트 PR을 제안한다.

## 다음 버전 배포

1. 위 네 파일의 버전을 함께 올린다. 데스크톱에서는 `npm version <버전> --no-git-tag-version`으로 잠금 파일도 갱신할 수 있다.
2. `docs/releases/<버전>.md`에 변경 내용·다운로드 방법·확인하지 못한 사항을 작성한다.
3. 코드를 커밋하고 main에 푸시한 뒤 CI 결과를 확인한다.
4. 해당 커밋에 태그를 붙이고 푸시한다.

```powershell
git tag -a desk-v0.3.1 -m "Chzzk Desk 0.3.1"
git push origin desk-v0.3.1
```

처음 푸시할 때 GitHub가 OAuth 토큰의 `workflow` 권한 부족을 알리면 사용자가 `gh auth refresh -h github.com -s workflow`로 권한을 갱신한 뒤 다시 푸시한다. 토큰 값을 코드·채팅에 붙여 넣지 않는다. 네트워크 등의 일시 오류는 실패한 Actions 실행을 재실행할 수 있다. 배포된 버전의 태그나 파일은 교체하지 않고 새 버전을 만든다.

## 로컬에서 같은 검사 실행

Windows x64와 Node.js 22가 필요하다. 실제 앱 창은 실행하지 않는다.

```powershell
npm ci --prefix desktop
npm run check --prefix desktop
python -m pytest tests -q
npm run test:browser-replay --prefix desktop
npm run package --prefix browser-extension
npm run dist:win --prefix desktop
node scripts/release-bundle.cjs pack
```

`release/`에 이번 버전의 세 파일과 체크섬이 모인다. 이전 버전 파일이 남아 있으면 혼합 배포를 막기 위해 실패하므로 이전 산출물은 별도로 옮긴 뒤 다시 실행한다. 로컬 Python 테스트에는 pytest 8.x만 있으면 된다.

## 배포 범위

- 현재 Windows x64만 제공한다. 코드서명 인증서와 자동 업데이트는 구성하지 않았다.
- Chrome 확장은 ZIP으로 배포하며 사용자가 압축을 풀어 개발자 모드로 로드한다. 웹 스토어 자동 게시와 업데이트는 별도 작업이다.
- Electron과 FFmpeg 실행 파일을 포함하지만 사용자 프로필·로그인 세션·클립·테스트 파일은 포함하지 않는다.
- FFmpeg 라이선스·원본·빌드 출처는 각 버전의 릴리스 노트와 패키지의 `resources/ffmpeg/README`에서 확인한다.

구성 근거: [GitHub 워크플로 권한](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#permissions), [GitHub 릴리스 생성 옵션](https://cli.github.com/manual/gh_release_create), [electron-builder 파일 포함 규칙](https://www.electron.build/contents.html).
