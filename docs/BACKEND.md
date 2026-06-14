# WatchMe 백엔드 문서

> 이 문서는 현재 코드(`server/index.mjs`) 기준입니다. 라인 번호 대신 함수/엔드포인트/이벤트 이름으로 참조합니다.

## 1. 개요

백엔드는 단일 파일 `server/index.mjs`(ES 모듈)입니다. Express로 방 생성/조회 REST API와 웹앱(또는 Vite 개발 미들웨어)을 제공하고, Socket.IO로 실시간 입장·재생 동기화·채팅·반응·커서를 처리합니다. 방 데이터는 **서버 메모리에만** 저장되며 DB가 없습니다.

- HTTP/라우팅: Express
- 실시간: Socket.IO (HTTP 서버에 attach, 별도 CORS 설정 없이 동일 출처 기준)
- 개발: Vite `middlewareMode`로 프론트 서빙 / 프로덕션: `dist` 정적 서빙
- 메타데이터: YouTube Data API v3 → oEmbed → 내장 샘플 폴백

## 2. 서버 구성

- `app = express()` + `server = http.createServer(app)` + `io = new Server(server)`. `express.json()` 바디 파서 사용.
- **환경 로딩**: 외부 의존성 없이 프로젝트 루트 `.env`를 직접 파싱하는 자체 로더(`KEY=VALUE`, 주석/빈 줄 무시, 이미 설정된 값은 덮어쓰지 않음, 따옴표 제거).
- **포트**: `process.env.PORT || 3000`.
- **모드 분기**:
  - 프로덕션(`NODE_ENV==="production"`): `express.static(dist)` + catch-all `*` → `dist/index.html`(SPA).
  - 개발: `createViteServer({ server: { middlewareMode: true }, appType: "spa" })`의 미들웨어 장착(HMR/모듈 서빙).
- **정리 인터벌**: 60초마다 참여자 0명이면서 30분 이상 비활성인 방을 삭제.

## 3. 환경변수

```env
YOUTUBE_API_KEY=...               # 있으면 Data API 사용, 없으면 oEmbed/샘플 폴백
YOUTUBE_CATEGORY_REGION=KR        # mostPopular regionCode (기본 KR)
YOUTUBE_CATEGORY_LANGUAGE=ko      # 카테고리 언어 힌트 hl (기본 ko)
YOUTUBE_POPULAR_MAX_RESULTS=24    # 인기영상 페이지 크기(1~50로 클램프)
```

> 카테고리 목록은 API에서 받지 않고 서버에 한국어로 **고정**되어 있습니다(아래 5절). 따라서 지역/언어는 사실상 KR/ko 기준으로 동작합니다.

## 4. REST API

### POST `/api/rooms` — 방 생성
요청:
```json
{ "youtubeUrl": "https://www.youtube.com/watch?v=...", "nickname": "수민", "participantId": "브라우저별-UUID" }
```
처리: `extractYouTubeId()`로 videoId 추출(watch/`youtu.be`/`shorts`/`embed` 지원), 닉네임(≤20자)·participantId(≤80자) 정규화. 검증 실패 시 400(유튜브 링크/닉네임/방장 정보 메시지). `makeRoomId()`로 6자리 대문자 영숫자 ID 생성(충돌 시 재시도). 생성 시 videoId 메타데이터를 비동기 조회해 시청 히스토리 첫 항목에 포함.

응답:
```json
{ "roomId": "ABC123", "inviteUrl": "/room/ABC123", "nickname": "수민" }
```
초기 방 상태: `playback={state:"paused",time:0}`, `hostId=participantId`, `controlId=hostId`, `hasShownInitialCountdown=false`.

### GET `/api/rooms/summary?ids=A,B,C` — 방 요약(목록용)
쉼표 구분 ID(최대 50개, 대문자 정규화). 각 방에 대해:
```json
{
  "id": "ABC123", "active": true,
  "videoId": "...", "participantCount": 2, "memberCount": 2,
  "participants": [{ "id": "...", "nickname": "..." }],   // 최대 6명
  "playbackState": "playing"|"paused",
  "lastMessage": { "author", "text", "type", "createdAt" } | null,
  "lastActivity": 1700000000000
}
```
없는 방은 `{ id, active: false }`. ChatsPage가 5초마다 폴링.

### GET `/api/videos/popular` — 인기 영상
쿼리: `categoryId`(숫자, "0" 거부), `pageToken`(YouTube 페이지네이션 토큰, `^[A-Za-z0-9_-]{1,256}$`), `maxDurationSeconds`(1~43200으로 클램프).

응답:
```json
{
  "videos": [{ "videoId","title","author","categoryId","categoryTitle","durationSeconds","durationLabel","viewCount","viewCountLabel","thumbnail" }],
  "categories": [{ "id","title" }],
  "source": "youtube" | "fallback",
  "regionCode": "KR", "categoryId": "10"|"all", "maxDurationSeconds": 600|null,
  "nextPageToken": "..."|"", "hasMore": true|false
}
```
응답은 `category:duration:page` 키로 15분 캐시(빈 응답은 캐시 안 함).

## 5. YouTube 메타데이터

폴백 체인: **Data API → oEmbed → 내장 샘플**.

- **Data API**(`fetchYouTubeMostPopularVideos`): `videos?chart=mostPopular&part=snippet,contentDetails,statistics&regionCode&hl&maxResults&[videoCategoryId]&[pageToken]&key`. duration 필터가 있으면 충분한 결과 확보를 위해 최대 4페이지까지 누적 요청(없으면 1회). 타임아웃 4초, 실패 시 빈 결과.
- **oEmbed**(`fetchYouTubeOEmbedMetadata`): 키가 없거나 특정 videoId 조회 실패 시 폴백. **제목/채널만** 제공(카테고리·길이·조회수·썸네일 없음). 타임아웃 2.5초.
- **내장 샘플**: `FALLBACK_POPULAR_VIDEO_IDS`(12개 고정). Data API가 첫 페이지(pageToken 빈)에서 결과가 없을 때만 사용. `source:"fallback"`, `nextPageToken:""`(폴백은 페이지네이션 없음).
- **카테고리 고정**: `FIXED_YOUTUBE_CATEGORY_TITLES`(ID→한국어 15개). API의 videoCategories는 호출하지 않음.
- **캐시**: 영상 메타데이터 캐시(TTL 24시간), 인기영상 응답 캐시(TTL 15분). 둘 다 메모리, 크기 제한/LRU 없음 → 재시작 시 소실.
- **정규화**: 제목(≤180자), 카테고리(숫자·non-zero, 한국어 제목 ≤80자), 길이(ISO8601 → 초 + `mm:ss`/`h:mm:ss`), 조회수(한국어 "조회수 N만" 포맷), 썸네일(medium>high>standard>default, 없으면 `mqdefault.jpg`).

## 6. 실시간 소켓 이벤트

> 브로드캐스트 규칙: 대부분 `io.to(roomId)`로 **발신자 포함** 전체에 보냅니다. 단, `cursor-chat`/`tap-ping`은 `socket.to(roomId)`로 **발신자 제외**. 상태를 바꾸는 핸들러는 끝에 `emitRoom(room)`으로 `room-state`를 다시 방송합니다.

| 이벤트(수신) | 권한 | 페이로드 | 동작 / 브로드캐스트 |
|---|---|---|---|
| `join-room` | 누구나 | `{roomId, participantId, nickname}` | 참가자 생성/갱신(15초 grace 타이머 해제 포함), `hostId` 없으면 방장 지정. 발신자에게 `room-state`, 신규면 타인에게 `system-message`(입장), `emitRoom`. |
| `heartbeat` | 누구나 | `{roomId, participantId, currentTime, playerState, localMode}` | 참가자 상태만 갱신(브로드캐스트 없음). |
| `playback-command` | 방장만 | `{roomId, participantId, action, time}` | play/pause/seek 처리(아래 7절). |
| `change-video` | 방장만 | `{roomId, participantId, youtubeUrl}` | videoId 교체, playback paused/0 리셋, `hasShownInitialCountdown=false`, 히스토리 추가, 전 참가자 상태 리셋. `countdown-cancelled` + `system-message` + `emitRoom`. 링크 오류 시 발신자에게 `room-error`. |
| `sync-choice` | 누구나 | `{roomId, participantId, mode}` | `participant.localMode` 갱신 후 `emitRoom`. |
| `chat-message` | 누구나 | `{roomId, participantId, text, videoTime}` | text ≤240자, 메시지 저장 후 `chat-message`(전체). |
| `emoji-reaction` | 누구나 | `{roomId, participantId, emoji, videoTime, x?, y?}` | 이모지 검증(아니면 👏), x/y 클램프. **`emoji-burst`**(전체)로 방송(이벤트명 다름, 메시지 로그엔 미저장). |
| `cursor-chat` | 누구나 | `{roomId, participantId, text, x, y}` | text ≤80자. `socket.to`(**발신자 제외**)로 `{participantId, nickname, text, x, y, at}` 방송. |
| `tap-ping` | 누구나 | `{roomId, participantId, x, y}` | `socket.to`(**발신자 제외**)로 `{id, participantId, nickname, x, y}` 방송. |
| `disconnect` | — | — | 15초 grace 후 참가자 제거 + `system-message`(퇴장) + `emitRoom`. 재접속하면 취소. |

`emitRoom`이 보내는 `room-state`(`serializeRoom`)에는 `playback`(실시간 계산된 time), `participants`(각 `isHost/canControl/localMode/playerState/currentTime/drift`), `messages`(최근 60개), `videoHistory`(videoId당 최신, 최대 30개)가 포함됩니다.

## 7. 재생 동기화 & 카운트다운

`playback-command`(방장만, action ∈ {play,pause,seek}):

- **play & `hasShownInitialCountdown===false`(첫 재생)**: `hasShownInitialCountdown=true`, playback은 paused 유지, `play-countdown`(`sourceId: participant.id`, `playAt = now+3000`) 방송. 3초 타이머 후 playback을 playing으로 바꾸고 `remote-command`(**`sourceId:"system"`**) 방송 → 방장 포함 전원이 동시에 재생.
- **play & `hasShownInitialCountdown===true`(재개)**: 즉시 playing 설정 후 `remote-command`(**`sourceId: participant.id`**) 방송.
- **pause / seek**: `countdown-cancelled` 방송 후 playback 갱신(seek는 기존 state 유지), `remote-command`(`sourceId: participant.id`) 방송.

**sourceId 규칙(중요)**: 클라이언트는 `sourceId === selfId`인 `remote-command`를 무시합니다. 따라서
- `sourceId: participant.id` → 발신자(보통 방장)는 자기 명령을 다시 적용하지 않음(이미 로컬에서 했으니까). **재개 시 방장이 자기 명령을 재적용해 음소거되던 버그를 막는 핵심.**
- `sourceId: "system"`(카운트다운 종료만) → 방장 포함 전원이 적용해야 하므로 system으로 보냄.

서버 시간 기준 `playAt`을 쓰므로(클라이언트 시계 아님) 참여자 간 카운트다운 동기가 맞습니다.

## 8. 방 / 상태 모델

- 전역 `rooms = Map<roomId, Room>`.
- **`normalizedPlayback(room)`**: 권위 있는 현재 시간을 즉석 계산 — playing이면 `time + (now - updatedAt)/1000`, 아니면 그대로(≥0). `room.playback.time`은 명령 시점 값이라 항상 이 함수로 보정해서 사용.
- **방장 지정/이전**: 생성 시 생성자가 방장, `hostId` 없는 방에 첫 입장 시 그 사람이 방장. **방장이 나가도 자동 이전 없음**(`hostId` 유지). `controlId`는 항상 `hostId`와 같고 실제 권한 체크는 `hostId`로 함(사실상 미사용 필드).
- **disconnect grace**: 소켓 끊김 시 즉시 제거하지 않고 `PARTICIPANT_DISCONNECT_GRACE_MS`(15초) 후 제거. 그 안에 재접속(같은 participantId)하면 타이머 취소 + 동일 참가자 재사용(끊김 메시지 없음). socketId 불일치면 stale 끊김으로 보고 무시.
- **카운트다운 타이머**: `clearCountdown(room)`이 `room.countdownTimer`를 정리. pause/seek/영상변경 시 진행 중 카운트다운을 취소.
- **메시지**: 서버는 전체 보관, `serializeRoom`에서 최근 60개만 전송.

### 데이터 형태
```ts
Room        = { id, videoId, hostId, controlId, createdAt, lastActivity,
                playback:{state:'playing'|'paused', time, updatedAt},
                hasShownInitialCountdown, countdownTimer,
                videoHistory:[], participants:Map, members:Map, messages:[] }
Participant = { id, socketId, nickname, currentTime,
                playerState:'playing'|'paused',
                localMode:'synced'|'waiting'|'freeplay', updatedAt, disconnectTimer }
Message     = { id, type:'chat'|'emoji', authorId, author, text, videoTime, x?, y?, createdAt }
VideoHistoryItem = { videoId, title, categoryId, categoryTitle, addedAt, addedBy }
```

## 9. 현재 제한 사항

- 서버 재시작 시 모든 방/메시지/캐시가 사라짐(메모리 전용, DB 없음).
- 방장 자동 이전 없음(방장이 나가면 제어 불가 상태가 될 수 있음).
- 방별 최대 인원 제한 없음.
- 캐시에 크기 제한/축출 없음(TTL로만 만료).
- 카테고리/지역/언어 사실상 KR/ko 고정.
- 광고를 감지/제거하지 않음, 유튜브 외 플랫폼 미지원.

## 10. 알아둘 점(gotchas)

- `cursor-chat`/`tap-ping`만 발신자 제외(`socket.to`), 나머지는 발신자 포함(`io.to`).
- 이벤트명 `emoji-reaction`(수신) ↔ `emoji-burst`(방송)로 다릅니다.
- `room-error`는 방 미존재/권한 없음 등에 발신자에게만 보냅니다(지속 표시). `system-message`는 2.8초 후 사라지는 안내.
- `hasShownInitialCountdown`은 방 단위 플래그라, 한 번 카운트다운이 뜬 뒤 누가 재접속해도 다시 카운트다운하지 않습니다(영상 변경 시 false로 리셋).
- 방 ID는 보안용이 아님(`Math.random` 6자리).
- `YOUTUBE_API_KEY`는 `.env`에 평문 저장 + API 쿼리로 전달되므로 커밋 금지(`.env.example` 템플릿 사용).

## 11. 배포

`render.yaml`(루트)로 Render에 Express+Socket.IO 서버 전체가 배포되고, 같은 서버가 빌드된 프론트(`dist`)도 서빙합니다. `main` 브랜치 푸시 시 자동 재배포. 무료 플랜은 15분 비활성 시 슬립(첫 접속 깨어남 지연), 방 데이터는 재시작 시 초기화됩니다. (Vercel은 실시간 서버가 없어 정적 프론트 미리보기 전용 → 방 생성 시 "프론트 미리보기" 모드)
