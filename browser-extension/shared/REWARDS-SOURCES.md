# 통나무 런타임 구현 메모

2026-10-02 공개 자료에서 확인한 DOM 구조와 읽기 응답을 바탕으로 작성했다. 외부 프로젝트 파일을 실행하거나 런타임 의존성으로 포함하지 않는다. 실제 계정, 쿠키, 라이브 브라우저 화면은 이 구현 작업에서 읽지 않았다.

## 근거

- [네이버 공식 통나무 안내](https://help.naver.com/service/30044/contents/24337?lang=ko&osType=COMMONOS): 시청 보상은 치지직의 조건과 지급 가능 시점에 따른다. 여러 화면을 열어도 시청 시간 인정 범위를 확장하지 않는다.
- [Cheese-spanner 통나무 기능 설명](https://github.com/neder2/Cheese-spanner#9-통나무-보상-자동-받기), [관찰된 버튼 구조](https://github.com/neder2/Cheese-spanner/blob/main/features/rewardAutoCollect.js): `aside#aside-chatting` 안의 네이티브 시청 보상 알림과 `role="alertdialog"`의 1시간 시청 보상 행. 채팅 문구, 프로필 보유량, 획득 방법 목록은 수령 버튼으로 보지 않는다. 이 프로젝트의 API 수령 기능은 사용하지 않는다.
- [Chzzk-Platter 공개 소스](https://github.com/lirpa62/Chzzk-Platter/blob/main/src/content.js): `GET https://api.chzzk.naver.com/service/v1/channels/{channelId}/log-power` 응답에서 `content.amount`가 현재 채널의 보유량이다. `content.claims`에서 `claimType: WATCH_1_HOUR`, `state: COMPLIED`, `saveType: ACTIVE`인 행은 `claimId`, `amount`를 가진다. 이 정보는 조회와 수령 결과 확인에만 사용한다.

치지직 내부 UI/API가 바뀌면 인식하지 못할 수 있다. 공개 소스 확인과 가짜 DOM/응답 기반 검증을 마쳤으며, 실제 로그인 환경에서의 동작 확인은 별도로 필요하다.

## 플랫폼 연결 계약

`shared/rewards.js`는 `globalThis.DeskRewards`와 CommonJS `module.exports`를 제공한다. 확장과 데스크톱은 같은 런타임을 이용한다.

```js
const watcher = DeskRewards.createWatcher({
  document,
  location,
  enabled: false,
  fetchBalance: async (channelId, { signal }) => {
    // 플랫폼이 자신의 로그인 환경으로 고정 GET 경로를 읽는다.
    // raw { code: 200, content: { amount, claims } } 또는 parseSnapshot 결과.
  },
  onStatus: status => { /* 앱 또는 확장 패널에 전달 */ }
});
watcher.start();
watcher.setEnabled(true);
watcher.setEnabled(false);
watcher.stop();
```

- `start()` 후 자동 수령을 꺼도 보유량은 60초마다 읽는다. `setEnabled(false)`는 예약된 클릭, 결과 확인, DOM 감시를 즉시 취소한다. `stop()`은 읽기까지 모두 중단한다.
- URL은 `https://chzzk.naver.com/live/{32자리 채널 ID}` 및 같은 채널의 `/chat`만 허용한다. 채널 이동 시 진행 중 조회 결과와 클릭을 폐기한다.
- 상태는 `{ channelId, balance, status, lastClaimAt, message }`다. 확인하지 못한 보유량은 `null`이며 0으로 바꾸지 않는다. 상태/보유량에 계정 정보는 포함하지 않는다.
- `status`는 `disabled`, `watching`, `claiming`, `claimed`, `unavailable` 중 하나다. 버튼 클릭 자체는 성공으로 기록하지 않는다. 사전에 확인한 시청 보상 ID가 사라지고, 보유량이 해당 보상 이상 증가하고, 수령 버튼도 사라진 경우에만 결과 확인 상태로 바뀐다. 결과를 확인하지 못하면 직접 확인하라는 안내를 표시한다.
- 로그인 실패, 조회 실패, 8초 초과 응답은 보유량을 비우고 자동 클릭을 보류한다. 조회가 다시 성공하면 다음 확인 주기에 재개한다.
- 수령은 확인된 네이티브 DOM 버튼만 누른다. 보유량 조회 외 API 요청, 시청 시간 조작, 팔로우, 후원, 예측, 베팅, 구매는 구현하지 않는다.
- 감시는 채팅 영역에 한정하고 2초로 합친다. 채널/채팅 영역 확인은 5초마다 수행하며 페이지 전체 DOM 감시는 하지 않는다.

## 테스트

`node --test browser-extension/tests/rewards.test.cjs`는 실제 화면을 조작하지 않는다. 구조가 비슷한 버튼 거부, 중복 렌더, 실패·지연 응답, 채널 이동, 설정 해제, 보유량/보상 갱신을 가짜 DOM과 타이머로 검증한다.
