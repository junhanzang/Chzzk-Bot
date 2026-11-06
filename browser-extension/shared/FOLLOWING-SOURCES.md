# 팔로우한 채널·게임·카테고리 조회 근거

2026-11-06 공개 소스 확인. 실제 계정·쿠키·인증된 치지직 API 호출 없이 구현했다.

- [치지직 공식 웹 JavaScript 번들](https://ssl.pstatic.net/static/nng/glive/resource/p/static/js/index-BcgE118t.js): `ul` 조회 함수는 `/channels/followings`에 `page`(기본 0), `size`, `sortType`(기본 `FOLLOW`)를 전달한다. 결과의 `followingList`, `totalPage`를 사용하며, 팔로우한 오프라인 채널의 필터에서 `streamer.openLive`를 직접 읽는다. 번들 파일은 공개 CDN에서 인증 없이 메모리로만 읽어 확인했다.
- [CHZZK View 공개 구현](https://greasyfork.org/en/scripts/598933-%EC%B9%98%EC%A7%80%EC%A7%81-%EB%B7%B0-chzzk-view/code)의 `cleFollowPage`·`cleLoadFollowings`: `/service/v1/channels/followings?page=0&size=100&sortType=FOLLOW`, `content.followingList`, `content.totalPage`, 0부터 증가하는 페이지 번호를 사용한다.
- [팔로우 방송 알림 공개 구현](https://gist.github.com/skfnbsadfkjbsdf/469a36d8a565a187364137d37f6cf3d4)의 팔로잉 라이브 조회: 행의 `channelId`, `channel.channelName`, `streamer.openLive`, `liveInfo.liveTitle`을 읽는다. 채널 객체 자체에 `openLive`가 있는 응답도 처리한다.
- [CloudStream 제공자의 캡처 기반 API 기록](https://github.com/ouor/cloudstream-chzzk/blob/master/API.md): 전체 팔로잉과 현재 라이브 팔로잉 경로가 별도이며 로그인 세션이 필요하다는 점을 교차 확인했다.

같은 공식 번들을 현재 치지직 홈의 `<script src>`에서 다시 확인해 게임·카테고리 계약을 조사했다. `g6`는 `GET /service/v1/categories/following`을 호출한다. 팔로잉 화면의 `Jae` 함수는 응답의 `content.followingList`를 카테고리 배열로 사용하고 다음 페이지를 요청하지 않는다. 카테고리 카드 `h6`는 각 행의 `categoryId`, `categoryType`, `categoryValue`를 읽는다. 팔로잉 라이브 카드 `Iae`·`d6`는 `liveInfo.liveCategory`, `liveInfo.categoryType`, `liveInfo.liveCategoryValue`를 사용한다. 전체 채널 팔로잉을 표시하는 `p3` 역시 `liveInfo.liveCategoryValue`를 표시한다.

이 경로는 공식 OpenAPI의 보장된 계약이 아니라 웹 서비스가 사용하는 비공식 조회 경로다. 필드·페이지 구조가 달라지면 부분 결과나 비로그인을 빈 목록으로 오인하지 않고 오류를 표시한다. 실제 계정의 최신 동작은 사용자 확인이 필요하다.

`FollowingService`는 인증정보를 직접 읽거나 저장하지 않는다. 앱은 기존 Electron 세션의 fetch를, 확장은 자신의 Chrome 세션을 사용하는 fetch를 주입한다. 앱 어댑터만 기존 로그인 상태 조회와 동일한 치지직 `Origin`·`Referer`를 설정한다. 요청은 고정된 두 HTTPS 경로의 GET이며 credentials를 포함하고 리디렉션은 거절한다. 채널과 카테고리를 병렬로 조회하고 결과는 각각 갱신한다. 채널은 최대 20페이지·2000채널, 카테고리는 단일 응답 최대 1000개, 각 응답 본문은 최대 1 MiB다. 전체 새로고침의 제한시간은 기본 10초다.

기존 `status`, `channels`, `message`, `updatedAt`은 채널 조회 상태다. `categories`, `categoryStatus`, `categoryMessage`, `categoryUpdatedAt`은 별도 카테고리 조회 상태다. 두 종류의 카테고리는 `{ id, type, name }`으로 정규화하며 `type`만 대문자로 바꾸고 ID 대소문자는 유지한다. 표시 이름이 같아도 유형이나 ID가 다르면 별개다. 라이브 채널의 유효한 현재 카테고리는 선택적 `channel.category`에 넣는다. 이전 응답처럼 카테고리가 없거나 해당 메타데이터만 잘못되어도 채널은 표시한다.

카테고리 요청 실패·시간 초과·로그인 오류는 성공한 채널 목록을 지우지 않는다. 채널 API가 로그아웃을 확인하면 두 목록을 모두 비운다. 계정 확인·변경·로그아웃 시 `clear()`는 두 목록과 이전 요청을 함께 무효화하며, 새로고침도 이전 목록을 비운 상태에서 시작한다. 팔로우 정보는 메모리에만 존재하고 원본 응답, 인증정보, 오류 URL은 저장하거나 UI에 노출하지 않는다.
