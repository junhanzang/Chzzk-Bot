# 팔로우한 채널 조회 근거

2026-11-06 공개 소스 확인. 실제 계정·쿠키·인증된 치지직 API 호출 없이 구현했다.

- [치지직 공식 웹 JavaScript 번들](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BcgE118t.js): `ul` 조회 함수는 `/channels/followings`에 `page`(기본 0), `size`, `sortType`(기본 `FOLLOW`)를 전달한다. 결과의 `followingList`, `totalPage`를 사용하며, 팔로우한 오프라인 채널의 필터에서 `streamer.openLive`를 직접 읽는다. 번들 파일은 공개 CDN에서 인증 없이 메모리로만 읽어 확인했다.
- [CHZZK View 공개 구현](https://greasyfork.org/en/scripts/598933-%EC%B9%98%EC%A7%80%EC%A7%81-%EB%B7%B0-chzzk-view/code)의 `cleFollowPage`·`cleLoadFollowings`: `/service/v1/channels/followings?page=0&size=100&sortType=FOLLOW`, `content.followingList`, `content.totalPage`, 0부터 증가하는 페이지 번호를 사용한다.
- [팔로우 방송 알림 공개 구현](https://gist.github.com/skfnbsadfkjbsdf/469a36d8a565a187364137d37f6cf3d4)의 팔로잉 라이브 조회: 행의 `channelId`, `channel.channelName`, `streamer.openLive`, `liveInfo.liveTitle`을 읽는다. 채널 객체 자체에 `openLive`가 있는 응답도 처리한다.
- [CloudStream 제공자의 캡처 기반 API 기록](https://github.com/ouor/cloudstream-chzzk/blob/master/API.md): 전체 팔로잉과 현재 라이브 팔로잉 경로가 별도이며 로그인 세션이 필요하다는 점을 교차 확인했다.

이 경로는 공식 OpenAPI의 보장된 계약이 아니라 웹 서비스가 사용하는 비공식 조회 경로다. 필드·페이지 구조가 달라지면 부분 결과나 비로그인을 빈 목록으로 오인하지 않고 오류를 표시한다. 실제 계정의 최신 동작은 사용자 확인이 필요하다.

`FollowingService`는 인증정보를 직접 읽거나 저장하지 않는다. 앱은 기존 Electron 세션의 fetch를, 확장은 자신의 Chrome 세션을 사용하는 fetch를 주입한다. 앱 어댑터만 기존 로그인 상태 조회와 동일한 치지직 `Origin`·`Referer`를 설정한다. 요청은 고정된 HTTPS 경로의 GET이며 credentials를 포함하고 리디렉션은 거절한다. 목록은 매번 비운 뒤 최대 20페이지·2000채널을 원자적으로 갱신한다. 전체 요청 제한시간은 기본 10초다. 계정 확인·변경·로그아웃 때 `clear()`하여 이전 요청과 목록을 무효화한다.
