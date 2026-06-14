# WatchMe 프론트엔드 문서

> 이 문서는 현재 코드(`src/`) 기준입니다. 다음 작업자가 구조와 핵심 동작을 빠르게 파악하도록 작성했습니다. 라인 번호 대신 함수/파일/CSS 클래스 이름으로 참조합니다.

## 1. 개요

프론트엔드는 라우팅 라이브러리 없이 동작하는 React 19 SPA입니다. 빌드는 Vite를 사용하고, 실시간 통신은 `socket.io-client`로 합니다. 거의 모든 화면 로직이 `src/App.tsx` 한 파일에 들어 있습니다.

- 빌드 도구: Vite 6
- UI: React 19 + 아이콘 `lucide-react`
- 실시간: Socket.IO 클라이언트
- 영상: YouTube IFrame Player API

## 2. 실행 / 확인

```bash
npm install
npm run dev        # node server/index.mjs (개발: Vite 미들웨어 + Socket.IO)
```

접속: `http://localhost:3000`

- 클라이언트 코드(`src/*`)는 새로고침/HMR로 반영됩니다.
- 서버 코드(`server/index.mjs`)를 바꾸면 **서버 프로세스 재시작이 필요**합니다(자동 리로드 없음).

## 3. 주요 파일

- `src/main.tsx` — 앱 진입점. `React.StrictMode`로 렌더(개발 모드에서 effect가 두 번 실행되는 점 유의).
- `src/App.tsx` — 라우팅, 모든 페이지, 그리고 `RoomPage`(플레이어 + 동기화 + 컨트롤 + 소셜) 전체.
- `src/styles.css` — 전체 디자인/반응형/애니메이션.
- `src/vite-env.d.ts` — `window.YT`와 `YouTubePlayer` 타입 정의.

## 4. 라우팅 & 화면 구성

라우팅은 `usePath()` 훅이 `popstate`로 `location.pathname`을 추적하고, `navigate(to)`가 `history.pushState` 후 `popstate`를 디스패치하는 방식입니다. 경로별:

- `/` → `HomePage`
- `/popular` → `PopularPage`
- `/chats` → `ChatsPage`
- `/room/:roomId` → `RoomPage`

`AppShell`(좌측 사이드 내비 + 모바일 탭바)은 방을 제외한 페이지를 감싸고, `RoomPage`는 셸 밖에서 전체화면 몰입형으로 렌더됩니다. `NAV_ITEMS`로 홈/인기영상/채팅방 메뉴를 정의합니다. 로그인은 `LoginModal`(카카오/네이버/구글/애플 버튼 UI만 있는 플레이스홀더, 현재 비기능).

### 페이지별
- **HomePage** — 히어로 CTA, "참여 중인 채팅방" 레일(`useMyRooms`), "인기 영상" 레일(카테고리 필터). `startWatchTogether()`는 닉네임이 있으면 바로 방 생성/입장, 없으면 `CreateRoomModal`을 엽니다.
- **PopularPage** — 인기 영상 그리드. 카테고리/`?duration=short` 필터를 URL 쿼리와 동기화하고, `IntersectionObserver` 센티넬로 무한 스크롤(`loadMore`가 `nextPageToken`으로 다음 페이지 fetch). 결과는 페이지 누적 시 dedupe.
- **ChatsPage** — 참여한 방 목록. `useMyRooms()`가 `localStorage`의 참여 방 목록을 읽고 `/api/rooms/summary`를 **5초마다 폴링**(포커스/가시성 변경 시 즉시 갱신). `playbackState === 'playing'`이면 라이브 링 애니메이션.
- **CreateRoomModal** — 유튜브 링크 + 닉네임 폼. `createRoomRequest()`가 `POST /api/rooms` 호출. 서버가 JSON이 아닌 응답(예: 정적 호스팅)을 주거나 실패하면, videoId만 추출해 **정적 미리보기 모드**(`STATIC_ROOM_PREFIX` localStorage)로 폴백.

## 5. 클라이언트 저장소 (localStorage)

| 키 | 내용 |
|---|---|
| `watchme:nickname` | 닉네임(최대 20자) |
| `watchme:participant` | 참가자 UUID(`crypto.randomUUID`, 세션 간 신원 유지) |
| `watchme:joined-rooms` | 참여한 방 배열 `{roomId, videoId?, lastJoinedAt, isPreview?}` (최대 30개, 최신순) |
| `watchme:resume-points` | 영상별 이어보기 지점 `{videoId: {time, savedAt}}` (최대 50개) |
| `watchme:static-room:<id>` | 정적 미리보기 방 데이터 |

이어보기 지점은 `RESUME_MIN_SECONDS`(10초) 이상일 때만 저장됩니다. 시청 히스토리는 `compactVideoHistory()`로 videoId당 최신 1건만 유지(최대 30개).

## 6. RoomPage 개요

`RoomPage`는 두 모드로 동작합니다.
1. **일반 모드** — Socket.IO로 서버와 동기화.
2. **정적 미리보기 모드**(`isStaticPreview`) — `?preview=1` + localStorage에 videoId가 있을 때. 소켓 연결 없이 모든 상태가 로컬에만 존재(채팅/이모지/영상변경 모두 로컬). 서버 미사용 데모/폴백용.

입장 전(`!joined`)에는 닉네임 입력 폼만 보이고, `handleJoin()`이 닉네임을 저장한 뒤 `joined=true`가 되면 소켓이 `join-room`을 보냅니다. 본인 식별은 `getParticipantId()`(localStorage UUID)로 하고, `self.isHost`로 방장 여부(`canControl`, `canChangeVideo`)를 판단합니다.

## 7. 유튜브 플레이어 수명주기

- `loadYouTubeApi()` — IFrame API 스크립트를 한 번만 로드(전역 `onYouTubeIframeAPIReady` 사용). 이미 로드돼 있으면 즉시 resolve.
- **플레이어 초기화 effect** — `room.videoId`가 생기면 실행. 기존 플레이어 destroy → 매번 새 타깃 div(고유 id) 생성(YouTube가 타깃 노드를 iframe으로 치환하기 때문) → `new YT.Player(...)`.
- **`playerVars`(중요, coarsePointer 분기)**:
  - `autoplay:0`, `enablejsapi:1`, `origin`, `playsinline:1`, `rel:0`, `modestbranding:1`
  - `controls`: 터치 기기는 `1`(네이티브), PC는 `0`(커스텀 컨트롤 사용)
  - `disablekb`: PC는 `1`, 터치는 `0`
  - `fs`: 터치는 `1`(네이티브 전체화면), PC는 `0`(커스텀 전체화면 버튼)
- **콜백**: `onReady`(아래), `onStateChange`→`handlePlayerStateChange`, `onError`(준비 상태 해제).
- **2단계 준비 상태**: `playerReady`(UI용, 생성 직후 즉시 true) vs `playerConfirmedReady`(onReady 시 true). 명령 실행은 `playerConfirmedReadyRef`를 확인하고, 준비 전 도착한 명령은 큐잉 후 flush.
- **5초 워치독**: `onReady`가 5초 안에 안 오면 `playerRetryKey`를 올려 한 번 재시도, 두 번째 실패 시 포기하고 `playerReady`만 true 처리.
- **initialPlayGuard**: 로드 직후 YouTube가 임의로 PLAYING이 되는 것을 막는 가드. 가드 중 PLAYING이 뜨면 즉시 pause시키고 일정 시간 뒤 해제.

### onReady의 위치 복원(중요)
`onReady`는 방의 현재 재생 지점으로 플레이어를 맞추되 **자동으로 재생하지 않습니다**.
- 방이 **일시정지**거나 `time>0.3`이면 `cueVideoById(videoId, time)`로 해당 위치에 **cued(포스터)** 상태로 둠 → 검은 버퍼링 프레임 대신 썸네일이 보이고 `getCurrentTime()`도 유지됨.
- 방이 **재생 중**이면 `needsResume=true`로 두어 "이어보기" 오버레이를 띄움(아래 9절).

## 8. 재생 동기화

원칙: **방장이 방 전체 재생을 주도**하고, 일반 참여자는 `synced`로 따라가거나 `freeplay`로 본인만 따로 봅니다.

- **`localMode`**: `synced` / `freeplay` / `waiting`(현재 UI 미사용). `localModeRef`로 클로저에서 항상 최신값 참조.
- **`handlePlayerStateChange`** — 플레이어 상태 변화의 중심 핸들러:
  1. 음소거 자동재생 해제 처리(9절)
  2. initialPlayGuard 처리
  3. `applyingRemoteRef`/`suppressCommandRef`가 true면 조기 return(원격 적용/내부 조작 중 echo 방지)
  4. **비방장**: 재생/일시정지/탐색을 직접 하면 `freeplay`로 전환(본인만)
  5. **방장**: PLAYING이 seek 같으면(`isSeekLikePlaybackStart`, 임계 `SEEK_COMMAND_THRESHOLD`=1.5s) `handleSeekCommand`, 첫 재생이면 카운트다운 요청, 그 외엔 `playback-command` play/pause 전송
- **`applyRemoteCommand`** — 서버 `remote-command`를 로컬에 적용. `applyingRemoteRef`를 잠깐 켜 echo 차단. 시간차 1.2s 초과 또는 seek면 `seekTo`, 재생이면 `safePlay`, 일시정지면 `pauseVideo`. 준비 전이면 `applyOrQueueRemoteCommand`/`flushPendingRemoteCommand`로 큐잉.
- **카운트다운**: 첫 재생 시 서버가 `play-countdown`(playAt = 지금+3초)을 보내면 `startCountdown`이 해당 위치로 seek+pause 후 3초 카운트다운 UI를 보여주고, 서버가 3초 뒤 `remote-command`(`sourceId:"system"`)로 실제 재생을 트리거.
- **`forceSyncedByHostCommand`** — `remote-command`/`play-countdown` 수신 시 `freeplay`였던 시청자를 `synced`로 강제.
- **`rejoinRoomTime`** — 헤더의 "맞추기" 액션. 방 기준 시간으로 seek 후 재생/일시정지, `synced` 복귀.
- **하트비트(0.9초)** — `currentTime/playerState/localMode`를 서버로 전송(동기화 판단용이 아니라, 다른 참여자에게 보일 상태/드리프트 표시용).
- **UI 폴링(0.3초)** — 커스텀 컨트롤바 표시용으로 `getCurrentTime/getDuration/isMuted/getVolume` 폴링(하트비트와 별개). 값 변화가 거의 없으면 setState 생략.

## 9. 자동재생 / 음소거 / 검정화면 대응 (브라우저 정책)

브라우저는 사용자 제스처 없이 **음소거 안 된** 프로그래밍적 재생을 막고, 음소거로 재생 중인 영상을 제스처 없이 `unMute()`하면 다시 멈춥니다. 또 cued 상태에서 `seekTo`는 포스터를 검은 버퍼링 프레임으로 바꿉니다. 이를 우회하는 장치들:

- **`safePlay(player)`** — 프로그래밍적 재생 전 `mute()` 후 `playVideo()`(음소거 재생은 항상 허용), `autoUnmuteRef=true` 설정. `applyRemoteCommand`/`startCountdown`/`rejoinRoomTime`에서 사용.
- **자동 음소거 해제 게이팅** — `handlePlayerStateChange`에서 PLAYING이 되고 `autoUnmuteRef`가 켜져 있으면, `navigator.userActivation.isActive`(살아있는 제스처)일 때만 `unMute()`. 아니면 `needsUnmute=true`로 "🔊 소리 켜기" 버튼 노출.
- **"소리 켜기"(`needsUnmute`)** — 버튼 클릭(제스처) 안에서 `enableSound()`가 안전하게 음소거 해제.
- **"이어보기"(`needsResume`)** — 새로고침/입장 시 방이 재생 중이면 노출. 탭하면 `resumeAfterRefresh()`가 그 제스처 안에서 방 위치로 seek 후 소리 있는 재생 시작(iframe `allow="autoplay"` 위임 덕분). 자동 음소거 재생 대신 한 번의 탭으로 소리까지 켜는 방식.
- **`cueVideoById`(일시정지 새로고침)** — 8절 `onReady` 참고. 검정 대신 포스터.

> 첫 재생(방장)은 카운트다운 경로를 거치며, 카운트다운 종료 시점엔 클릭 후 ~3초가 지나 제스처가 만료될 수 있어 음소거 재생 + "소리 켜기"가 뜰 수 있습니다.

## 10. 커스텀 플레이어 컨트롤 + 커서 추적 레이어 (PC 전용)

**왜 존재하는가**: 영상 위에서 `/`를 누르면 커서 위치에 말풍선(커서챗)이 떠야 하는데, 유튜브는 교차 출처 iframe이라 그 위에서의 `mousemove`가 부모로 오지 않아 커서를 추적할 수 없습니다. 그래서 영상 위에 투명 추적 레이어를 깔아야 하고, 그 레이어가 네이티브 컨트롤 클릭을 막으므로 네이티브 컨트롤(`controls:0`)을 끄고 커스텀 컨트롤로 대체합니다. (자세한 도입 이유는 `App.tsx`의 커스텀 컨트롤 섹션 주석 참고)

- **`.player-surface`** — 영상 위 투명 레이어(PC, `playerReady && !coarsePointer`에서만 렌더). `onPointerMove`에서 `playerPointerRef`(0~1 비율, x∈[0.02,0.98]·y∈[0.05,0.9])를 갱신하고 컨트롤바를 표시. 클릭하면 재생/일시정지 토글. 반응(이모지) 타게팅 중에는 `pointer-events:none`.
- **`.player-controls`** — 하단 커스텀 컨트롤바: 재생/일시정지, 탐색(seek) 슬라이더 + 시간, 음소거 토글 + 음량 슬라이더, 전체화면. hover/이동 시 표시되고 2.6초 후 자동 숨김(`revealControls`). 말풍선/이어보기/이어보기 프롬프트/반응 선택 중에는 숨김.
- **탐색**: 드래그 중엔 `scrubTime`으로 표시만 바뀌고, 놓을 때(`commitSeek`) 실제 `seekTo` + (방장이면) seek 명령 전송, (시청자면) `freeplay` 전환.
- **음량/음소거**: `changeVolume`/`toggleMute`가 `setVolume`/`mute`/`unMute`. 0이면 음소거, >0이면 해제.
- **전체화면**: `toggleFullscreen`이 `player-frame`을 `requestFullscreen`/`exitFullscreen`. `fullscreenchange`로 `isFullscreen` 동기화.
- **`coarsePointer`** — `matchMedia("(pointer: coarse)")`로 마운트 시 한 번 결정(이후 안 바뀜). 터치 기기는 추적 레이어/커스텀 컨트롤을 쓰지 않고 네이티브 컨트롤 유지("/" 기능도 PC 전용).

## 11. 소셜 기능

- **커서챗(`/`, PC 전용)** — `/` 누르면 `playerPointerRef`(없으면 `lastMouseRef`, 그래도 없으면 중앙) 위치에 입력 말풍선. 입력할 때마다 `cursor-chat`을 80ms 스로틀로 전송. 4초 무입력/Escape/blur 시 닫히며 빈 텍스트를 보내 상대 화면에서 제거. 원격 말풍선(`remoteBubbles`)은 6초 후 만료.
- **탭 핑(`tap-ping`)** — 수신 시 물결 애니메이션(1.8초). 색은 `participantColor` 해시. (전송 트리거는 현재 UI에 노출돼 있지 않고 수신/렌더만 구현)
- **이모지 버스트** — 두 종류: (1) 좌표가 있는 반응(영상 위, 모바일 반응 피커로 위치 지정), (2) 좌표 없는 반응(채팅 빠른 이모지, 아래에서 위로). 최대 동시 풍선 수 제한(`MAX_EMOJI_BALLOONS`). 보낼 땐 `emoji-reaction`, 받을 땐 `emoji-burst`.
- **반응 피커(모바일)** — 이모지 선택 후 영상 탭 위치로 `emoji-reaction`(x,y 포함) 전송하는 `reaction-touch-overlay`.

## 12. 채팅

`message-list`에 메시지를 렌더하고 새 메시지/포커스 시 바닥으로 스크롤(레이아웃 지연 대비 RAF + setTimeout 다중 호출). 입력은 자동 높이 `textarea`(Enter 전송, Shift+Enter 줄바꿈). 모바일에서는 `visualViewport`로 키보드 높이를 계산해 영상이 키보드에 밀리지 않게 처리하고, 키보드가 닫히면 포커스를 자동 해제. 메시지는 클라이언트에서 최근 80개로 trim(서버는 60개 전송).

## 13. 모바일 / 반응형

`syncRoomViewportVars()`가 리사이즈/회전/포커스/가시성 변경 시 `--room-visual-height`, `--room-keyboard-inset`, `--room-viewport-offset` CSS 변수를 갱신. 방 화면은 데스크톱에서 `position:fixed inset:0`로 스크롤 잠금(`room-scroll-lock`), 모바일(≤640px)은 `100dvh` 플렉스 컬럼 + 하단 탭바. 헤더 액션 시트를 열면 임시로 스크롤 허용 후 700ms 뒤 재잠금.

## 14. 소켓 이벤트 (클라이언트)

소켓 수명주기 effect는 `joined && !isStaticPreview`일 때만 연결하고 `join-room`을 보냅니다.

**수신(on)**: `room-state`(전체 방 상태 → `setRoom`/`setMessages`), `system-message`(2.8초 후 사라지는 안내), `room-error`(지속 표시), `remote-command`(재생 동기화, `sourceId===selfId`면 무시), `play-countdown`(카운트다운), `countdown-cancelled`, `chat-message`, `emoji-burst`, `cursor-chat`, `tap-ping`.

**전송(emit)**: `join-room`, `heartbeat`(0.9초), `playback-command`(방장: play/pause/seek), `sync-choice`(localMode 변경), `chat-message`, `emoji-reaction`, `cursor-chat`, `change-video`(방장).

## 15. 주요 데이터 타입(클라이언트)

```ts
RoomState   = { id, videoId, hostId, controlId, playback, hasShownInitialCountdown, videoHistory[], participants[], messages[] }
playback    = { state: 'playing'|'paused', time: number, updatedAt: number }
Participant = { id, nickname, isHost, canControl, localMode, playerState, currentTime, drift, updatedAt }
ChatMessage = { id, type: 'chat'|'emoji', authorId, author, text, videoTime, createdAt }
RemoteCommand   = { sourceId, action: 'play'|'pause'|'seek', playback }
CountdownCommand= { sourceId, playback, playAt }
CursorChatEvent = { participantId, nickname, text, x, y, at }
playerUi    = { playing, current, duration, muted, volume }   // 커스텀 컨트롤 표시용
```

`YouTubePlayer`(`vite-env.d.ts`): `playVideo, pauseVideo, cueVideoById, seekTo, getCurrentTime, getPlayerState, getDuration, mute, unMute, isMuted, setVolume, getVolume, destroy`.

## 16. 확인 체크리스트

- 홈/인기영상/채팅방 입력·버튼이 모바일/PC에서 깨지지 않는지
- 방장이 처음 재생 시 3초 카운트다운 후 같이 재생되는지(검정화면 없이)
- 일시정지 후 새로고침 → 포스터가 보이고 재생 시 그 지점에서 이어지는지
- 재생 중 새로고침 → "이어보기" 탭으로 소리까지 바로 재생되는지
- 방장의 재생/일시정지/탐색이 다른 참여자에게 반영되는지
- 시청자의 로컬 조작이 방 전체에 반영되지 않고 `freeplay`로 표시되는지, "맞추기"로 복귀되는지
- (PC) 영상 hover 시 커스텀 컨트롤바가 뜨고 재생/탐색/음량/전체화면이 동작하는지
- (PC) 영상 위 `/` → 커서 위치에 말풍선이 뜨고 상대 화면에도 보이는지
- (모바일) 네이티브 컨트롤이 유지되는지, 채팅 입력 시 영상이 밀리지 않는지

## 17. 알아둘 점(gotchas)

- `coarsePointer`는 마운트 시 1회만 결정 — DevTools로 포인터 모드를 바꿔도 새로고침 전까진 안 바뀝니다.
- `playerPointerRef`는 커서가 영상 위에 있을 때만 갱신 — 영상 밖에서 `/`를 누르면 마지막 위치/중앙으로 뜰 수 있습니다.
- `playerReady`(즉시) ≠ `playerConfirmedReady`(onReady) — 명령 실행은 후자 기준.
- 자동재생/음소거 로직 때문에 새로고침 시 영상이 잠시 음소거로 시작될 수 있고, 소리는 한 번의 탭(제스처)이 필요합니다(브라우저 정책상 자동 불가).
- `applyingRemoteRef`/`suppressCommandRef`는 300~600ms 타임아웃으로 해제 — 버퍼링이 길면 일시적으로 의도치 않은 상태 처리가 생길 수 있습니다.
- 정적 미리보기 모드는 소켓 없이 localStorage만 사용 — 서버 장애 시 자동 진입할 수 있습니다.
- `React.StrictMode`로 개발 중 effect/플레이어 init이 두 번 실행됩니다(프로덕션에선 1회).
