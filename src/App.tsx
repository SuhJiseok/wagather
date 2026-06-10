import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  ChevronRight,
  CirclePause,
  Clapperboard,
  Copy,
  Flame,
  Home,
  Link as LinkIcon,
  MessageCircle,
  MessagesSquare,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Smile,
  UserRound,
  UsersRound,
  X
} from "lucide-react";

type PlaybackState = "playing" | "paused";
type LocalMode = "synced" | "waiting" | "freeplay";

type Participant = {
  id: string;
  nickname: string;
  isHost: boolean;
  canControl: boolean;
  localMode: LocalMode;
  playerState: PlaybackState;
  currentTime: number;
  drift: number;
  updatedAt: number;
};

type ChatMessage = {
  id: string;
  type: "chat" | "emoji";
  authorId: string;
  author: string;
  text: string;
  videoTime: number;
  createdAt: number;
};

type RoomState = {
  id: string;
  videoId: string;
  hostId: string | null;
  controlId: string | null;
  playback: {
    state: PlaybackState;
    time: number;
    updatedAt: number;
  };
  hasShownInitialCountdown: boolean;
  participants: Participant[];
  messages: ChatMessage[];
};

type RemoteCommand = {
  sourceId: string;
  action: "play" | "pause" | "seek";
  playback: RoomState["playback"];
};

type CountdownCommand = {
  sourceId: string;
  playback: RoomState["playback"];
  playAt: number;
};

type SlowPrompt = {
  nickname: string;
  seconds: number;
};

type JoinedRoomEntry = {
  roomId: string;
  videoId: string | null;
  lastJoinedAt: number;
  isPreview?: boolean;
  peers?: string[];
};

type PopularVideo = {
  videoId: string;
  title: string;
  author: string;
  thumbnail: string;
};

type RoomSummary = {
  id: string;
  active: boolean;
  videoId?: string;
  participantCount?: number;
  participants?: { id: string; nickname: string }[];
  playbackState?: PlaybackState;
  lastMessage?: { author: string; text: string; type: "chat" | "emoji"; createdAt: number } | null;
  lastActivity?: number;
};

const STORAGE_NICKNAME = "watchme:nickname";
const STORAGE_PARTICIPANT = "watchme:participant";
const STORAGE_JOINED_ROOMS = "watchme:joined-rooms";
const STATIC_ROOM_PREFIX = "watchme:static-room:";
const DRIFT_THRESHOLD = 3;
const SEEK_COMMAND_THRESHOLD = 1.5;
const ROOM_VISUAL_HEIGHT_VAR = "--room-visual-height";
const ROOM_KEYBOARD_INSET_VAR = "--room-keyboard-inset";
const ROOM_VIEWPORT_OFFSET_VAR = "--room-viewport-offset";

function syncRoomViewportVars() {
  if (typeof window === "undefined") return;

  const viewport = window.visualViewport;
  const height = viewport?.height || window.innerHeight;
  const offsetTop = viewport?.offsetTop || 0;
  const keyboardInset = Math.max(0, window.innerHeight - height - offsetTop);

  const root = document.documentElement;
  const nextHeight = `${Math.round(height)}px`;
  const nextInset = `${Math.round(keyboardInset)}px`;
  const nextOffset = `${Math.round(offsetTop)}px`;
  if (root.style.getPropertyValue(ROOM_VISUAL_HEIGHT_VAR) !== nextHeight) {
    root.style.setProperty(ROOM_VISUAL_HEIGHT_VAR, nextHeight);
  }
  if (root.style.getPropertyValue(ROOM_KEYBOARD_INSET_VAR) !== nextInset) {
    root.style.setProperty(ROOM_KEYBOARD_INSET_VAR, nextInset);
  }
  if (root.style.getPropertyValue(ROOM_VIEWPORT_OFFSET_VAR) !== nextOffset) {
    root.style.setProperty(ROOM_VIEWPORT_OFFSET_VAR, nextOffset);
  }
}

function clearRoomViewportVars() {
  if (typeof document === "undefined") return;

  document.documentElement.style.removeProperty(ROOM_VISUAL_HEIGHT_VAR);
  document.documentElement.style.removeProperty(ROOM_KEYBOARD_INSET_VAR);
  document.documentElement.style.removeProperty(ROOM_VIEWPORT_OFFSET_VAR);
}

function loadJoinedRooms(): JoinedRoomEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_JOINED_ROOMS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is JoinedRoomEntry => Boolean(item && typeof item.roomId === "string"));
  } catch {
    return [];
  }
}

function saveJoinedRooms(entries: JoinedRoomEntry[]) {
  localStorage.setItem(STORAGE_JOINED_ROOMS, JSON.stringify(entries.slice(0, 30)));
}

function rememberJoinedRoom(entry: JoinedRoomEntry) {
  const rest = loadJoinedRooms().filter((item) => item.roomId !== entry.roomId);
  saveJoinedRooms([entry, ...rest]);
}

function joinedRoomPath(entry: JoinedRoomEntry) {
  if (entry.isPreview && entry.videoId) {
    return `/room/${entry.roomId}?video=${encodeURIComponent(entry.videoId)}&preview=1`;
  }
  return `/room/${entry.roomId}`;
}

function videoThumbnail(videoId: string | null | undefined) {
  return videoId ? `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg` : null;
}

function formatRelativeTime(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;
  return `${Math.floor(diff / 86_400_000)}일 전`;
}

const FALLBACK_POPULAR: PopularVideo[] = (
  [
    ["9bZkp7q19f0", "PSY - GANGNAM STYLE(강남스타일) M/V", "officialpsy"],
    ["gdZLi9oWNZg", "BTS (방탄소년단) 'Dynamite' Official MV", "HYBE LABELS"],
    ["WMweEpGlu_U", "BTS (방탄소년단) 'Butter' Official MV", "HYBE LABELS"],
    ["IHNzOHi8sJs", "BLACKPINK - '뚜두뚜두 (DDU-DU DDU-DU)' M/V", "BLACKPINK"],
    ["ioNng23DkIM", "BLACKPINK - 'How You Like That' M/V", "BLACKPINK"],
    ["XqZsoesa55w", "Baby Shark Dance | 상어가족", "Pinkfong Baby Shark"],
    ["kJQP7kiw5Fk", "Luis Fonsi - Despacito ft. Daddy Yankee", "Luis Fonsi"],
    ["JGwWNGJdvx8", "Ed Sheeran - Shape of You (Official Music Video)", "Ed Sheeran"],
    ["OPf0YbXqDm0", "Mark Ronson - Uptown Funk ft. Bruno Mars", "Mark Ronson"],
    ["fJ9rUzIMcZQ", "Queen - Bohemian Rhapsody (Official Video)", "Queen Official"],
    ["60ItHLz5WEA", "Alan Walker - Faded", "Alan Walker"],
    ["dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up (Official Video)", "Rick Astley"]
  ] as const
).map(([videoId, title, author]) => ({
  videoId,
  title,
  author,
  thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
}));

function navigate(to: string) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePath() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  return path;
}

function useMyRooms() {
  const [entries, setEntries] = useState<JoinedRoomEntry[]>(loadJoinedRooms);
  const [summaries, setSummaries] = useState<Record<string, RoomSummary>>({});
  const [loading, setLoading] = useState(() => loadJoinedRooms().some((entry) => !entry.isPreview));

  useEffect(() => {
    const ids = entries.filter((entry) => !entry.isPreview).map((entry) => entry.roomId);
    if (!ids.length) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    fetch(`/api/rooms/summary?ids=${encodeURIComponent(ids.join(","))}`)
      .then((response) => {
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) throw new Error("unavailable");
        return response.json();
      })
      .then((data: { rooms: RoomSummary[] }) => {
        if (cancelled) return;
        const next: Record<string, RoomSummary> = {};
        for (const summary of data.rooms || []) next[summary.id] = summary;
        setSummaries(next);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [entries]);

  function removeEntry(roomId: string) {
    saveJoinedRooms(loadJoinedRooms().filter((item) => item.roomId !== roomId));
    setEntries(loadJoinedRooms());
  }

  return { entries, summaries, loading, removeEntry };
}

async function createRoomRequest(youtubeUrl: string, nickname: string) {
  const response = await fetch("/api/rooms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ youtubeUrl, nickname })
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("static-preview");
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "방을 만들 수 없습니다.");
  localStorage.setItem(STORAGE_NICKNAME, nickname);
  return data.inviteUrl as string;
}

function getParticipantId() {
  const existing = localStorage.getItem(STORAGE_PARTICIPANT);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(STORAGE_PARTICIPANT, id);
  return id;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

function getPlaybackTime(playback: RoomState["playback"]) {
  if (playback.state !== "playing") return playback.time;
  return Math.max(0, playback.time + (Date.now() - playback.updatedAt) / 1000);
}

function extractYouTubeId(input: string) {
  try {
    const url = new URL(input.trim());
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/").filter(Boolean)[1] || null;
      if (url.pathname.startsWith("/embed/")) return url.pathname.split("/").filter(Boolean)[1] || null;
    }
  } catch {
    return null;
  }
  return null;
}

function makeLocalRoomId() {
  return `PREVIEW-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
}

function getStaticRoomVideoId(roomId: string) {
  const params = new URLSearchParams(window.location.search);
  const queryVideo = params.get("video");
  if (queryVideo) return queryVideo;

  try {
    const saved = localStorage.getItem(`${STATIC_ROOM_PREFIX}${roomId}`);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as { videoId?: string };
    return parsed.videoId || null;
  } catch {
    return null;
  }
}

function makeStaticRoomState(roomId: string, videoId: string, participantId: string, nickname: string): RoomState {
  return {
    id: roomId,
    videoId,
    hostId: participantId,
    controlId: participantId,
    playback: {
      state: "paused",
      time: 0,
      updatedAt: Date.now()
    },
    hasShownInitialCountdown: false,
    participants: [
      {
        id: participantId,
        nickname,
        isHost: true,
        canControl: true,
        localMode: "synced",
        playerState: "paused",
        currentTime: 0,
        drift: 0,
        updatedAt: Date.now()
      }
    ],
    messages: []
  };
}

function hasPlayerApi(player: YouTubePlayer | null): player is YouTubePlayer {
  return Boolean(
    player &&
      typeof player.getCurrentTime === "function" &&
      typeof player.getPlayerState === "function" &&
      typeof player.seekTo === "function" &&
      typeof player.playVideo === "function" &&
      typeof player.pauseVideo === "function"
  );
}

function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(script);
    }
  });
}

export function App() {
  const path = usePath();
  const roomMatch = path.match(/^\/room\/([^/]+)/);
  if (roomMatch) return <RoomPage roomId={roomMatch[1]} key={roomMatch[1]} />;

  const active = path.startsWith("/chats") ? "chats" : "home";
  return <AppShell active={active}>{active === "chats" ? <ChatsPage /> : <HomePage />}</AppShell>;
}

const NAV_ITEMS = [
  { key: "home", label: "홈", to: "/", icon: Home },
  { key: "chats", label: "채팅방", to: "/chats", icon: MessagesSquare }
] as const;

function AppShell({ active, children }: { active: "home" | "chats"; children: React.ReactNode }) {
  function go(event: React.MouseEvent, to: string) {
    event.preventDefault();
    navigate(to);
  }

  return (
    <div className="app-shell">
      <header className="mobile-top-bar">
        <a className="brand-mark compact" href="/" onClick={(event) => go(event, "/")}>
          <Clapperboard size={20} />
          WatchMe
        </a>
      </header>

      <aside className="side-nav">
        <a className="brand-mark side-brand" href="/" onClick={(event) => go(event, "/")}>
          <Clapperboard size={24} />
          WatchMe
        </a>
        <nav className="side-menu" aria-label="주 메뉴">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.key}
              href={item.to}
              className={`side-link ${active === item.key ? "active" : ""}`}
              aria-current={active === item.key ? "page" : undefined}
              onClick={(event) => go(event, item.to)}
            >
              <item.icon size={20} />
              <span>{item.label}</span>
            </a>
          ))}
        </nav>
        <p className="side-foot">같은 영상, 같은 순간</p>
      </aside>

      <div className="app-content">{children}</div>

      <nav className="tab-bar" aria-label="주 메뉴">
        {NAV_ITEMS.map((item) => (
          <a
            key={item.key}
            href={item.to}
            className={`tab-link ${active === item.key ? "active" : ""}`}
            aria-current={active === item.key ? "page" : undefined}
            onClick={(event) => go(event, item.to)}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </a>
        ))}
      </nav>
    </div>
  );
}

function CreateRoomModal({ initialUrl, onClose }: { initialUrl?: string; onClose: () => void }) {
  const [youtubeUrl, setYoutubeUrl] = useState(initialUrl || "");
  const [nickname, setNickname] = useState(() => localStorage.getItem(STORAGE_NICKNAME) || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  async function createRoom(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    const trimmedName = nickname.trim();
    try {
      const inviteUrl = await createRoomRequest(youtubeUrl, trimmedName);
      onClose();
      navigate(inviteUrl);
    } catch (error) {
      const videoId = extractYouTubeId(youtubeUrl);
      if (videoId && trimmedName) {
        const roomId = makeLocalRoomId();
        localStorage.setItem(STORAGE_NICKNAME, trimmedName);
        localStorage.setItem(`${STATIC_ROOM_PREFIX}${roomId}`, JSON.stringify({ videoId, createdAt: Date.now() }));
        onClose();
        navigate(`/room/${roomId}?video=${encodeURIComponent(videoId)}&preview=1`);
        return;
      }
      setError(error instanceof Error && error.message !== "static-preview" ? error.message : "유튜브 링크를 확인해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="새 방 만들기" onClick={onClose}>
      <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
        <div className="modal-handle" aria-hidden="true" />
        <button className="modal-close" type="button" aria-label="닫기" onClick={onClose}>
          <X size={17} />
        </button>
        <div className="panel-heading">
          <p>새 방 만들기</p>
          <h2>유튜브 링크를 붙여 주세요</h2>
        </div>
        <form onSubmit={createRoom} className="room-form">
          <label>
            <span>유튜브 링크</span>
            <div className="input-wrap">
              <LinkIcon size={18} />
              <input
                value={youtubeUrl}
                onChange={(event) => setYoutubeUrl(event.target.value)}
                placeholder="https://www.youtube.com/watch?v=..."
                required
                autoFocus={!initialUrl}
              />
            </div>
          </label>
          <label>
            <span>닉네임</span>
            <div className="input-wrap">
              <UserRound size={18} />
              <input
                value={nickname}
                onChange={(event) => setNickname(event.target.value)}
                placeholder="친구들에게 보일 이름"
                maxLength={20}
                required
                autoFocus={Boolean(initialUrl)}
              />
            </div>
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="primary-button" type="submit" disabled={loading}>
            <Play size={18} />
            {loading ? "방 만드는 중" : "같이 보기 시작"}
          </button>
        </form>
      </div>
    </div>
  );
}

function describeRoom(entry: JoinedRoomEntry, summary: RoomSummary | null, loading: boolean) {
  const rememberedTitle = entry.peers?.length ? entry.peers.join(", ") : "";

  if (entry.isPreview) {
    return {
      title: rememberedTitle || "미리보기 방",
      preview: "이 기기에서만 보이는 방이에요.",
      ended: false,
      live: false,
      count: 0
    };
  }
  if (!summary) {
    if (loading) {
      return { title: rememberedTitle || "같이 보기 방", preview: "방 정보를 불러오는 중...", ended: false, live: false, count: 0 };
    }
    return { title: rememberedTitle || "같이 보기 방", preview: "종료된 방이에요.", ended: true, live: false, count: 0 };
  }
  if (!summary.active) {
    return { title: rememberedTitle || "같이 보기 방", preview: "종료된 방이에요.", ended: true, live: false, count: 0 };
  }

  const selfId = getParticipantId();
  const others = (summary.participants || []).filter((participant) => participant.id !== selfId).map((participant) => participant.nickname);
  const title = others.length ? others.join(", ") : rememberedTitle || "비어 있는 방";
  const preview = summary.lastMessage
    ? `${summary.lastMessage.author}: ${summary.lastMessage.text}`
    : "아직 대화가 없어요. 첫 반응을 남겨보세요.";
  return {
    title,
    preview,
    ended: false,
    live: summary.playbackState === "playing",
    count: summary.participantCount || 0
  };
}

function LiveRing() {
  return (
    <svg className="live-ring" aria-hidden="true" focusable="false">
      <rect className="live-ring-track" pathLength={100} />
      <rect className="live-ring-comet" pathLength={100} />
    </svg>
  );
}

function RoomCard({ entry, summary, loading }: { entry: JoinedRoomEntry; summary: RoomSummary | null; loading: boolean }) {
  const info = describeRoom(entry, summary, loading);
  const thumb = videoThumbnail(summary?.videoId ?? entry.videoId);
  const showCount = Boolean(!entry.isPreview && summary?.active);

  return (
    <button
      className={`room-card glass-card ${info.ended ? "ended" : ""} ${info.live ? "live" : ""}`}
      type="button"
      disabled={info.ended}
      onClick={() => navigate(joinedRoomPath(entry))}
    >
      {info.live && <LiveRing />}
      <div className="room-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Clapperboard size={24} />}
      </div>
      <div className="room-card-body">
        <strong>{info.title}</strong>
        <span className="room-card-meta">
          {showCount && (
            <span className="people-chip" aria-label={`참여자 ${info.count}명`}>
              <UsersRound size={13} />
              {info.count}
            </span>
          )}
          ROOM {entry.roomId} · {formatRelativeTime(entry.lastJoinedAt)}
        </span>
      </div>
    </button>
  );
}

function ChatsPage() {
  const { entries, summaries, loading, removeEntry } = useMyRooms();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <main className="chats-page">
      <header className="page-head">
        <div>
          <h1>채팅방</h1>
          <p>참여 중인 같이 보기 방을 이어서 볼 수 있어요.</p>
        </div>
        <button className="icon-button" type="button" aria-label="새 방 만들기" onClick={() => setCreateOpen(true)}>
          <Plus size={20} />
        </button>
      </header>

      {entries.length === 0 ? (
        <div className="empty-card glass-panel">
          <MessagesSquare size={26} />
          <strong>아직 참여한 방이 없어요</strong>
          <p>유튜브 링크 하나로 첫 방을 만들어 보세요.</p>
          <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}>
            <Play size={18} />새 방 만들기
          </button>
        </div>
      ) : (
        <ul className="chat-room-list">
          {entries.map((entry) => {
            const summary = entry.isPreview ? null : summaries[entry.roomId] ?? null;
            const info = describeRoom(entry, summary, loading);
            const thumb = videoThumbnail(summary?.videoId ?? entry.videoId);
            const time = summary?.lastMessage?.createdAt ?? summary?.lastActivity ?? entry.lastJoinedAt;

            return (
              <li
                className={`chat-room-item glass-card ${info.ended ? "ended" : ""} ${info.live ? "live" : ""}`}
                key={entry.roomId}
              >
                {info.live && <LiveRing />}
                <button
                  className="chat-room-link"
                  type="button"
                  disabled={info.ended}
                  onClick={() => navigate(joinedRoomPath(entry))}
                >
                  <div className="chat-thumb">
                    {thumb ? <img src={thumb} alt="" loading="lazy" /> : <Clapperboard size={20} />}
                    {info.live && <span className="chat-live-dot" aria-label="재생 중" />}
                  </div>
                  <div className="chat-room-main">
                    <div className="chat-room-top">
                      <strong>{info.title}</strong>
                      {!entry.isPreview && summary?.active && (
                        <span className="people-chip" aria-label={`참여자 ${info.count}명`}>
                          <UsersRound size={13} />
                          {info.count}
                        </span>
                      )}
                      <time className="chat-room-time">{formatRelativeTime(time)}</time>
                    </div>
                    <p className="chat-room-preview">{info.preview}</p>
                  </div>
                </button>
                <button
                  className="chat-room-remove"
                  type="button"
                  aria-label="목록에서 삭제"
                  onClick={() => removeEntry(entry.roomId)}
                >
                  <X size={15} />
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {createOpen && <CreateRoomModal onClose={() => setCreateOpen(false)} />}
    </main>
  );
}

function HomePage() {
  const [createModalUrl, setCreateModalUrl] = useState<string | null>(null);
  const [popular, setPopular] = useState<PopularVideo[] | null>(null);
  const myRooms = useMyRooms();
  const railRooms = myRooms.entries.slice(0, 8);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/videos/popular")
      .then((response) => {
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) throw new Error("unavailable");
        return response.json();
      })
      .then((data: { videos: PopularVideo[] }) => {
        if (!cancelled) setPopular(data.videos?.length ? data.videos : FALLBACK_POPULAR);
      })
      .catch(() => {
        if (!cancelled) setPopular(FALLBACK_POPULAR);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startWatchTogether(video: PopularVideo) {
    const nickname = (localStorage.getItem(STORAGE_NICKNAME) || "").trim();
    const youtubeUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
    if (!nickname) {
      setCreateModalUrl(youtubeUrl);
      return;
    }
    try {
      navigate(await createRoomRequest(youtubeUrl, nickname));
    } catch {
      setCreateModalUrl(youtubeUrl);
    }
  }

  return (
    <main className="home-page">
      <section className="home-hero glass-panel" aria-label="WatchMe 소개">
        <div className="hero-copy">
          <p className="eyebrow">same video, same moment</p>
          <h1>친구와 같은 장면에서 웃는 같이 보기</h1>
          <p>유튜브 링크 하나로 방을 만들고, 초대 링크를 보내면 끝이에요.</p>
        </div>
        <button className="primary-button hero-cta" type="button" onClick={() => setCreateModalUrl("")}>
          <Play size={18} />새 방 만들기
        </button>
      </section>

      <section className="home-rooms" aria-label="참여 중인 채팅방">
        <div className="rail-head">
          <h2>
            <MessagesSquare size={20} />
            참여 중인 채팅방
          </h2>
          {railRooms.length > 0 && (
            <button className="rail-more" type="button" onClick={() => navigate("/chats")}>
              전체 보기
              <ChevronRight size={16} />
            </button>
          )}
        </div>
        {railRooms.length === 0 ? (
          <div className="empty-card glass-panel">
            <MessagesSquare size={26} />
            <strong>아직 참여한 방이 없어요</strong>
            <p>새 방을 만들어 친구에게 초대 링크를 보내보세요.</p>
            <button className="primary-button" type="button" onClick={() => setCreateModalUrl("")}>
              <Play size={18} />새 방 만들기
            </button>
          </div>
        ) : (
          <div className="room-rail">
            {railRooms.map((entry) => (
              <RoomCard
                key={entry.roomId}
                entry={entry}
                summary={entry.isPreview ? null : myRooms.summaries[entry.roomId] ?? null}
                loading={myRooms.loading}
              />
            ))}
          </div>
        )}
      </section>

      <section className="home-rooms" aria-label="지금 인기 있는 영상">
        <div className="rail-head">
          <h2>
            <Flame size={20} />
            지금 인기 있는 영상
          </h2>
        </div>
        {popular !== null && popular.length === 0 ? (
          <div className="empty-card glass-panel">
            <Flame size={26} />
            <strong>추천 영상을 불러오지 못했어요</strong>
            <p>잠시 후 다시 시도하거나, 새 방 만들기로 직접 유튜브 링크를 붙여보세요.</p>
          </div>
        ) : (
          <div className="video-grid">
            {popular === null
              ? Array.from({ length: 8 }, (_, index) => (
                  <div className="video-card glass-card skeleton" key={index}>
                    <div className="room-thumb" />
                    <div className="video-card-body">
                      <span className="skeleton-bar" style={{ width: "86%" }} />
                      <span className="skeleton-bar" style={{ width: "48%" }} />
                    </div>
                  </div>
                ))
              : popular.map((video) => (
                  <button
                    className="video-card glass-card"
                    type="button"
                    key={video.videoId}
                    onClick={() => startWatchTogether(video)}
                  >
                    <div className="room-thumb">
                      <img src={video.thumbnail} alt="" loading="lazy" />
                      <span className="watch-overlay" aria-hidden="true">
                        <span>
                          <Play size={14} />
                          같이 보기
                        </span>
                      </span>
                    </div>
                    <div className="video-card-body">
                      <strong>{video.title}</strong>
                      <span>{video.author}</span>
                    </div>
                  </button>
                ))}
          </div>
        )}
      </section>

      {createModalUrl !== null && <CreateRoomModal initialUrl={createModalUrl} onClose={() => setCreateModalUrl(null)} />}
    </main>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const staticVideoId = useMemo(() => getStaticRoomVideoId(roomId), [roomId]);
  const isStaticPreview = Boolean(staticVideoId);
  const [nickname, setNickname] = useState(() => localStorage.getItem(STORAGE_NICKNAME) || "");
  const [joinName, setJoinName] = useState(nickname);
  const [joined, setJoined] = useState(Boolean(nickname));
  const [room, setRoom] = useState<RoomState | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [systemNote, setSystemNote] = useState("");
  const [localMode, setLocalMode] = useState<LocalMode>("synced");
  const [localTime, setLocalTime] = useState(0);
  const [playerReady, setPlayerReady] = useState(false);
  const [slowPrompt, setSlowPrompt] = useState<SlowPrompt | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [chatFocused, setChatFocused] = useState(false);
  const [nextVideoUrl, setNextVideoUrl] = useState("");
  const [videoUrlError, setVideoUrlError] = useState("");
  const [mobileVideoFormOpen, setMobileVideoFormOpen] = useState(false);
  const [initialPlaybackPending, setInitialPlaybackPending] = useState(false);

  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const participantIdRef = useRef(getParticipantId());
  const applyingRemoteRef = useRef(false);
  const suppressCommandRef = useRef(false);
  const waitHoldTimeRef = useRef<number | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const localModeRef = useRef<LocalMode>("synced");
  const countdownActiveRef = useRef(false);
  const countdownIntervalRef = useRef<number | null>(null);
  const countdownTimeoutRef = useRef<number | null>(null);
  const initialPlayGuardRef = useRef(false);
  const initialPlayGuardTimeoutRef = useRef<number | null>(null);
  const staticHasShownInitialCountdownRef = useRef(false);
  const initialCountdownRequestedRef = useRef(false);
  const lastKnownPlayerTimeRef = useRef(0);
  const currentVideoIdRef = useRef<string | null>(null);
  const lastBlockedNoticeRef = useRef(0);

  const selfId = participantIdRef.current;
  const self = room?.participants.find((participant) => participant.id === selfId) || null;
  const canControl = Boolean(self?.canControl && localMode !== "freeplay");
  const canChangeVideo = Boolean((self?.isHost || self?.canControl) && localMode !== "freeplay");
  const inviteUrl = isStaticPreview ? window.location.href : `${window.location.origin}/room/${roomId}`;
  const shouldShowInitialPlayOverlay = Boolean(
    canControl &&
      playerReady &&
      countdown === null &&
      !initialPlaybackPending &&
      room?.playback.state === "paused" &&
      !hasInitialCountdownBeenShown()
  );

  useEffect(() => {
    const previousScrollY = window.scrollY;
    document.body.classList.add("room-scroll-lock");
    document.documentElement.classList.add("room-scroll-lock");
    syncRoomViewportVars();
    window.scrollTo(0, 0);

    const keepRoomPinned = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    window.addEventListener("scroll", keepRoomPinned, { passive: true });

    return () => {
      window.removeEventListener("scroll", keepRoomPinned);
      document.body.classList.remove("room-scroll-lock");
      document.documentElement.classList.remove("room-scroll-lock");
      clearRoomViewportVars();
      window.scrollTo(0, previousScrollY);
    };
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const scheduleSync = () => {
      syncRoomViewportVars();
      window.requestAnimationFrame(syncRoomViewportVars);
    };

    syncRoomViewportVars();
    window.addEventListener("resize", scheduleSync);
    window.addEventListener("orientationchange", scheduleSync);
    window.addEventListener("focus", scheduleSync);
    document.addEventListener("visibilitychange", scheduleSync);
    viewport?.addEventListener("resize", scheduleSync);
    viewport?.addEventListener("scroll", scheduleSync);

    return () => {
      window.removeEventListener("resize", scheduleSync);
      window.removeEventListener("orientationchange", scheduleSync);
      window.removeEventListener("focus", scheduleSync);
      document.removeEventListener("visibilitychange", scheduleSync);
      viewport?.removeEventListener("resize", scheduleSync);
      viewport?.removeEventListener("scroll", scheduleSync);
    };
  }, []);

  useEffect(() => {
    if (!canChangeVideo && mobileVideoFormOpen) {
      setMobileVideoFormOpen(false);
    }
  }, [canChangeVideo, mobileVideoFormOpen]);

  useEffect(() => {
    roomRef.current = room;
    if (room?.hasShownInitialCountdown) {
      initialCountdownRequestedRef.current = true;
    }
  }, [room]);

  useEffect(() => {
    staticHasShownInitialCountdownRef.current = false;
    initialCountdownRequestedRef.current = false;
    lastKnownPlayerTimeRef.current = 0;
    currentVideoIdRef.current = null;
    setInitialPlaybackPending(false);
  }, [roomId]);

  useEffect(() => {
    if (!room?.videoId) return;

    const previousVideoId = currentVideoIdRef.current;
    currentVideoIdRef.current = room.videoId;

    if (!previousVideoId || previousVideoId === room.videoId) return;

    clearCountdown();
    setSlowPrompt(null);
    setLocalMode("synced");
    localModeRef.current = "synced";
    staticHasShownInitialCountdownRef.current = false;
    initialCountdownRequestedRef.current = Boolean(room.hasShownInitialCountdown);
    lastKnownPlayerTimeRef.current = 0;
    setInitialPlaybackPending(false);
  }, [room?.hasShownInitialCountdown, room?.videoId]);

  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

  const joinedVideoId = room?.videoId ?? null;
  useEffect(() => {
    if (!joined || !joinedVideoId) return;
    const existing = loadJoinedRooms().find((item) => item.roomId === roomId);
    rememberJoinedRoom({
      ...existing,
      roomId,
      videoId: joinedVideoId,
      lastJoinedAt: Date.now(),
      isPreview: isStaticPreview
    });
  }, [isStaticPreview, joined, joinedVideoId, roomId]);

  const peersKey = JSON.stringify(
    room?.participants.filter((participant) => participant.id !== selfId).map((participant) => participant.nickname) ?? []
  );
  useEffect(() => {
    const peers = JSON.parse(peersKey) as string[];
    if (!joined || !peers.length) return;
    const entry = loadJoinedRooms().find((item) => item.roomId === roomId);
    if (!entry) return;
    const merged = [...new Set([...peers, ...(entry.peers || [])])].slice(0, 6);
    if (JSON.stringify(merged) === JSON.stringify(entry.peers || [])) return;
    rememberJoinedRoom({ ...entry, peers: merged });
  }, [joined, peersKey, roomId]);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList) return;
    messageList.scrollTop = messageList.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    if (!joined || !nickname) return;
    if (isStaticPreview && staticVideoId) {
      const nextRoom = makeStaticRoomState(roomId, staticVideoId, selfId, nickname);
      setRoom(nextRoom);
      setMessages(nextRoom.messages);
      return;
    }

    const socket = io();
    socketRef.current = socket;
    socket.emit("join-room", { roomId, participantId: selfId, nickname });

    socket.on("room-state", (nextRoom: RoomState) => {
      setRoom(nextRoom);
      setMessages(nextRoom.messages);
    });

    socket.on("chat-message", (message: ChatMessage) => {
      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) return current;
        return [...current, message].slice(-80);
      });
    });

    socket.on("system-message", (note: string) => {
      setSystemNote(note);
      window.setTimeout(() => setSystemNote(""), 2800);
    });

    socket.on("room-error", (message: string) => {
      setSystemNote(message);
    });

    socket.on("remote-command", (command: RemoteCommand) => {
      if (command.sourceId === selfId) return;
      if (localModeRef.current !== "synced") return;
      applyRemoteCommand(command);
    });

    socket.on("play-countdown", (command: CountdownCommand) => {
      if (localModeRef.current !== "synced") return;
      startCountdown(command);
    });

    socket.on("countdown-cancelled", () => {
      clearCountdown();
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [isStaticPreview, joined, nickname, roomId, selfId, staticVideoId]);

  useEffect(() => {
    if (!room?.videoId) return;
    let cancelled = false;

    loadYouTubeApi().then(() => {
      if (cancelled || !window.YT?.Player) return;
      if (typeof playerRef.current?.destroy === "function") playerRef.current.destroy();
      initialPlayGuardRef.current = true;
      playerRef.current = new window.YT.Player("youtube-player", {
        videoId: room.videoId,
        playerVars: {
          autoplay: 0,
          controls: 1,
          enablejsapi: 1,
          origin: window.location.origin,
          playsinline: 1,
          rel: 0
        },
        events: {
          onReady: () => {
            setPlayerReady(true);
            const playback = roomRef.current?.playback;
            const player = playerRef.current;
            if (playback && hasPlayerApi(player)) {
              applyingRemoteRef.current = true;
              if (playback.time > 0.3) player.seekTo(playback.time, true);
              if (playback.state === "playing") {
                initialPlayGuardRef.current = false;
                player.playVideo();
              } else {
                player.pauseVideo();
                releaseInitialPlayGuard(1200);
              }
              window.setTimeout(() => {
                applyingRemoteRef.current = false;
              }, 400);
            }
          },
          onStateChange: (event: unknown) => {
            const data = (event as { data?: number }).data;
            handlePlayerStateChange(data);
          }
        }
      });
    });

    return () => {
      cancelled = true;
      clearInitialPlayGuard();
      if (typeof playerRef.current?.destroy === "function") playerRef.current.destroy();
      playerRef.current = null;
      setPlayerReady(false);
    };
  }, [room?.videoId]);

  useEffect(() => {
    if (!joined) return;
    const interval = window.setInterval(() => {
      const player = playerRef.current;
      const currentTime = hasPlayerApi(player) ? player.getCurrentTime() : localTime;
      const stateCode = hasPlayerApi(player) ? player.getPlayerState() : undefined;
      const playerState = stateCode === window.YT?.PlayerState.PLAYING ? "playing" : "paused";
      setLocalTime(currentTime);
      lastKnownPlayerTimeRef.current = currentTime;
      syncRoomViewportVars();
      enforceRoomPlayback();
      socketRef.current?.emit("heartbeat", {
        roomId,
        participantId: selfId,
        currentTime,
        playerState,
        localMode: localModeRef.current
      });
    }, 900);

    return () => window.clearInterval(interval);
  }, [joined, localTime, roomId, selfId]);

  useEffect(() => {
    if (!room || !playerReady || localMode !== "synced") return;
    if (countdownActiveRef.current) return;
    const player = playerRef.current;
    if (!hasPlayerApi(player) || player.getPlayerState() !== window.YT?.PlayerState.PLAYING) return;

    const delayed = room.participants
      .filter((participant) => participant.id !== selfId && participant.localMode !== "freeplay")
      .map((participant) => ({
        participant,
        gap: localTime - participant.currentTime
      }))
      .filter(({ gap }) => gap >= DRIFT_THRESHOLD)
      .sort((a, b) => b.gap - a.gap)[0];

    if (!delayed || slowPrompt) return;

    suppressCommandRef.current = true;
    player.pauseVideo();
    window.setTimeout(() => {
      suppressCommandRef.current = false;
    }, 300);
    waitHoldTimeRef.current = localTime;
    updateLocalMode("waiting");
    setSlowPrompt({
      nickname: delayed.participant.nickname,
      seconds: Math.floor(delayed.gap)
    });
  }, [localTime, localMode, playerReady, room, selfId, slowPrompt]);

  useEffect(() => {
    if (!room || localMode !== "waiting" || waitHoldTimeRef.current === null) return;
    const holdTime = waitHoldTimeRef.current;
    const waitingFor = room.participants.filter(
      (participant) => participant.id !== selfId && participant.localMode !== "freeplay"
    );
    if (!waitingFor.length) return;
    const caughtUp = waitingFor.every((participant) => participant.currentTime >= holdTime - 1.2);
    if (!caughtUp) return;

    setSlowPrompt(null);
    waitHoldTimeRef.current = null;
    updateLocalMode("synced");
    if (hasPlayerApi(playerRef.current)) playerRef.current.playVideo();
  }, [localMode, room, selfId]);

  function handleJoin(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = joinName.trim();
    if (!trimmed) return;
    localStorage.setItem(STORAGE_NICKNAME, trimmed);
    setNickname(trimmed);
    setJoined(true);
  }

  function handlePlayerStateChange(data: number | undefined) {
    if (!window.YT || data === undefined) return;
    if (initialPlayGuardRef.current) {
      if (data === window.YT.PlayerState.PLAYING) {
        const player = playerRef.current;
        suppressCommandRef.current = true;
        player?.pauseVideo();
        window.setTimeout(() => {
          suppressCommandRef.current = false;
        }, 300);
        releaseInitialPlayGuard(900);
        return;
      }
      if (data === window.YT.PlayerState.PAUSED || data === window.YT.PlayerState.CUED) {
        releaseInitialPlayGuard(500);
      }
    }
    if (applyingRemoteRef.current || suppressCommandRef.current) return;
    if (!canControl) {
      if (!isStaticPreview && localModeRef.current === "synced") {
        showControlBlockedNotice();
        enforceRoomPlayback();
      }
      return;
    }

    const player = playerRef.current;
    const time = hasPlayerApi(player) ? player.getCurrentTime() : 0;
    if (data === window.YT.PlayerState.PLAYING) {
      if (isSeekLikePlaybackStart(time)) {
        handleSeekCommand(time);
        lastKnownPlayerTimeRef.current = time;
        return;
      }

      if (hasInitialCountdownBeenShown()) {
        if (!isStaticPreview) {
          socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "play", time });
        }
        lastKnownPlayerTimeRef.current = time;
        return;
      }

      suppressCommandRef.current = true;
      player?.pauseVideo();
      window.setTimeout(() => {
        suppressCommandRef.current = false;
      }, 300);
      if (isStaticPreview) {
        requestInitialPlaybackCountdown(time);
        return;
      }
      requestInitialPlaybackCountdown(time);
    }
    if (data === window.YT.PlayerState.PAUSED) {
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "pause", time });
    }
  }

  function startInitialPlaybackFromOverlay() {
    if (!canControl || hasInitialCountdownBeenShown()) return;
    const player = playerRef.current;
    const playback = roomRef.current?.playback;
    const time = hasPlayerApi(player) ? player.getCurrentTime() : playback ? getPlaybackTime(playback) : 0;

    if (hasPlayerApi(player)) {
      suppressCommandRef.current = true;
      player.pauseVideo();
      window.setTimeout(() => {
        suppressCommandRef.current = false;
      }, 300);
    }

    requestInitialPlaybackCountdown(time);
  }

  function requestInitialPlaybackCountdown(time: number) {
    const safeTime = Math.max(0, Number.isFinite(time) ? time : 0);

    if (isStaticPreview) {
      staticHasShownInitialCountdownRef.current = true;
      startCountdown({
        sourceId: selfId,
        playback: { state: "paused", time: safeTime, updatedAt: Date.now() },
        playAt: Date.now() + 3000
      }, true);
      return;
    }

    initialCountdownRequestedRef.current = true;
    setInitialPlaybackPending(true);
    socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "play", time: safeTime });
  }

  function hasInitialCountdownBeenShown() {
    if (isStaticPreview) return staticHasShownInitialCountdownRef.current;
    return initialCountdownRequestedRef.current || Boolean(room?.hasShownInitialCountdown || roomRef.current?.hasShownInitialCountdown);
  }

  function isSeekLikePlaybackStart(time: number) {
    const playback = roomRef.current?.playback;
    const roomTime = playback ? getPlaybackTime(playback) : lastKnownPlayerTimeRef.current;
    return (
      Math.abs(time - roomTime) > SEEK_COMMAND_THRESHOLD &&
      Math.abs(time - lastKnownPlayerTimeRef.current) > SEEK_COMMAND_THRESHOLD
    );
  }

  function handleSeekCommand(time: number) {
    const playbackState = roomRef.current?.playback.state || "paused";
    if (!isStaticPreview) {
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "seek", time });
    }

    if (playbackState === "paused" && hasPlayerApi(playerRef.current)) {
      suppressCommandRef.current = true;
      playerRef.current.pauseVideo();
      window.setTimeout(() => {
        suppressCommandRef.current = false;
      }, 300);
    }
  }

  function clearInitialPlayGuard() {
    if (initialPlayGuardTimeoutRef.current) {
      window.clearTimeout(initialPlayGuardTimeoutRef.current);
      initialPlayGuardTimeoutRef.current = null;
    }
    initialPlayGuardRef.current = false;
  }

  function releaseInitialPlayGuard(delay: number) {
    if (initialPlayGuardTimeoutRef.current) {
      window.clearTimeout(initialPlayGuardTimeoutRef.current);
    }
    initialPlayGuardTimeoutRef.current = window.setTimeout(() => {
      initialPlayGuardRef.current = false;
      initialPlayGuardTimeoutRef.current = null;
    }, delay);
  }

  function applyRemoteCommand(command: RemoteCommand) {
    clearCountdown();
    const player = playerRef.current;
    if (!hasPlayerApi(player)) return;
    applyingRemoteRef.current = true;
    const current = player.getCurrentTime();
    if (Math.abs(current - command.playback.time) > 1.2 || command.action === "seek") {
      player.seekTo(command.playback.time, true);
    }
    if (command.playback.state === "playing") player.playVideo();
    if (command.playback.state === "paused") player.pauseVideo();
    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 400);
  }

  function clearCountdown() {
    if (countdownIntervalRef.current) {
      window.clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
    if (countdownTimeoutRef.current) {
      window.clearTimeout(countdownTimeoutRef.current);
      countdownTimeoutRef.current = null;
    }
    countdownActiveRef.current = false;
    setCountdown(null);
  }

  function startCountdown(command: CountdownCommand, playLocally = false, onComplete?: () => void) {
    clearCountdown();
    countdownActiveRef.current = true;
    const player = playerRef.current;
    if (hasPlayerApi(player)) {
      applyingRemoteRef.current = true;
      player.seekTo(command.playback.time, true);
      player.pauseVideo();
      window.setTimeout(() => {
        applyingRemoteRef.current = false;
      }, 400);
    }

    const updateCount = () => {
      const remaining = Math.ceil((command.playAt - Date.now()) / 1000);
      setCountdown(Math.max(1, remaining));
    };

    updateCount();
    countdownIntervalRef.current = window.setInterval(updateCount, 150);
    countdownTimeoutRef.current = window.setTimeout(() => {
      clearCountdown();
      onComplete?.();
      if (playLocally && hasPlayerApi(playerRef.current)) {
        applyingRemoteRef.current = true;
        playerRef.current.playVideo();
        window.setTimeout(() => {
          applyingRemoteRef.current = false;
        }, 500);
      }
    }, Math.max(0, command.playAt - Date.now()));
  }

  function enforceRoomPlayback() {
    const player = playerRef.current;
    const currentRoom = roomRef.current;
    if (
      !hasPlayerApi(player) ||
      !currentRoom ||
      isStaticPreview ||
      localModeRef.current !== "synced" ||
      countdownActiveRef.current
    ) {
      return;
    }

    const currentSelf = currentRoom.participants.find((participant) => participant.id === selfId);
    if (!currentSelf || currentSelf.canControl) return;

    const roomTime = getPlaybackTime(currentRoom.playback);
    const playerTime = player.getCurrentTime();
    const stateCode = player.getPlayerState();
    const shouldPlay = currentRoom.playback.state === "playing";
    const isPlaying = stateCode === window.YT?.PlayerState.PLAYING;
    const isPaused = stateCode === window.YT?.PlayerState.PAUSED;
    const needsSeek = Math.abs(playerTime - roomTime) > 1.1;
    const needsStateFix = shouldPlay ? !isPlaying : !isPaused;

    if (!needsSeek && !needsStateFix) return;

    applyingRemoteRef.current = true;
    if (needsSeek) player.seekTo(roomTime, true);
    if (shouldPlay) player.playVideo();
    if (!shouldPlay) player.pauseVideo();
    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 400);
  }

  function showControlBlockedNotice() {
    const now = Date.now();
    if (now - lastBlockedNoticeRef.current < 2200) return;
    lastBlockedNoticeRef.current = now;
    setSystemNote("방장만 영상을 조작할 수 있어요.");
    window.setTimeout(() => setSystemNote(""), 2200);
  }

  function updateLocalMode(mode: LocalMode) {
    setLocalMode(mode);
    localModeRef.current = mode;
    if (!isStaticPreview) {
      socketRef.current?.emit("sync-choice", { roomId, participantId: selfId, mode });
    }
  }

  function chooseWait() {
    setSlowPrompt(null);
    updateLocalMode("waiting");
  }

  function chooseContinue() {
    setSlowPrompt(null);
    waitHoldTimeRef.current = null;
    updateLocalMode("freeplay");
    if (hasPlayerApi(playerRef.current)) playerRef.current.playVideo();
  }

  function rejoinRoomTime() {
    const playback = roomRef.current?.playback;
    const player = playerRef.current;
    if (!playback || !hasPlayerApi(player)) return;
    applyingRemoteRef.current = true;
    player.seekTo(playback.time, true);
    if (playback.state === "playing") player.playVideo();
    if (playback.state === "paused") player.pauseVideo();
    window.setTimeout(() => {
      applyingRemoteRef.current = false;
    }, 400);
    updateLocalMode("synced");
    setSlowPrompt(null);
  }

  function sendMessage(event: React.FormEvent) {
    event.preventDefault();
    const text = messageText.trim();
    if (!text) return;
    if (isStaticPreview) {
      const message: ChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "chat",
        authorId: selfId,
        author: nickname,
        text,
        videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime,
        createdAt: Date.now()
      };
      setMessages((current) => [...current, message].slice(-80));
      setMessageText("");
      return;
    }
    socketRef.current?.emit("chat-message", {
      roomId,
      participantId: selfId,
      text,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
    setMessageText("");
  }

  function sendEmoji(emoji: string) {
    if (isStaticPreview) {
      const message: ChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        type: "emoji",
        authorId: selfId,
        author: nickname,
        text: emoji,
        videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime,
        createdAt: Date.now()
      };
      setMessages((current) => [...current, message].slice(-80));
      return;
    }
    socketRef.current?.emit("emoji-reaction", {
      roomId,
      participantId: selfId,
      emoji,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
  }

  function changeVideo(event: React.FormEvent) {
    event.preventDefault();
    const videoId = extractYouTubeId(nextVideoUrl);

    if (!videoId) {
      setVideoUrlError("유튜브 링크를 확인해 주세요.");
      return;
    }

    setVideoUrlError("");
    clearCountdown();
    setSlowPrompt(null);
    updateLocalMode("synced");

    if (isStaticPreview) {
      const now = Date.now();
      staticHasShownInitialCountdownRef.current = false;
      initialCountdownRequestedRef.current = false;
      lastKnownPlayerTimeRef.current = 0;
      localStorage.setItem(`${STATIC_ROOM_PREFIX}${roomId}`, JSON.stringify({ videoId, updatedAt: now }));
      setRoom((currentRoom) => {
        if (!currentRoom) return currentRoom;
        return {
          ...currentRoom,
          videoId,
          playback: { state: "paused", time: 0, updatedAt: now },
          hasShownInitialCountdown: false,
          participants: currentRoom.participants.map((participant) => ({
            ...participant,
            currentTime: 0,
            drift: 0,
            localMode: "synced",
            playerState: "paused",
            updatedAt: now
          }))
        };
      });
      setSystemNote("영상이 변경됐어요.");
      window.setTimeout(() => setSystemNote(""), 2200);
      setNextVideoUrl("");
      setMobileVideoFormOpen(false);
      return;
    }

    socketRef.current?.emit("change-video", { roomId, participantId: selfId, youtubeUrl: nextVideoUrl });
    setNextVideoUrl("");
    setMobileVideoFormOpen(false);
  }

  function keepVideoInView() {
    setChatFocused(true);
    const pinRoom = () => {
      syncRoomViewportVars();
      window.scrollTo(0, 0);
      if (messageListRef.current) {
        messageListRef.current.scrollTop = messageListRef.current.scrollHeight;
      }
    };

    window.requestAnimationFrame(pinRoom);
    window.setTimeout(pinRoom, 80);
    window.setTimeout(pinRoom, 240);
  }

  function releaseChatFocus() {
    window.setTimeout(() => {
      setChatFocused(false);
      syncRoomViewportVars();
      window.scrollTo(0, 0);
    }, 120);
  }

  async function copyInvite() {
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  }

  const sortedParticipants = useMemo(() => {
    return [...(room?.participants || [])].sort((a, b) => {
      if (a.isHost !== b.isHost) return a.isHost ? -1 : 1;
      if (a.canControl !== b.canControl) return a.canControl ? -1 : 1;
      return a.nickname.localeCompare(b.nickname, "ko");
    });
  }, [room?.participants]);
  const visibleParticipants = sortedParticipants.slice(0, 8);
  const hiddenParticipantCount = Math.max(0, sortedParticipants.length - visibleParticipants.length);
  const mobileVisibleParticipants = sortedParticipants.slice(0, 4);
  const mobileHiddenParticipantCount = Math.max(0, sortedParticipants.length - mobileVisibleParticipants.length);
  const mobileStatusLabel = isStaticPreview
    ? "미리보기"
    : localMode === "synced"
      ? "같이 보는 중"
      : localMode === "waiting"
        ? "잠깐 쉬는 중"
        : "먼저 보는 중";

  if (!joined) {
    return (
      <main className="join-shell">
        <form className="join-form" onSubmit={handleJoin}>
          <a
            className="brand-mark compact"
            href="/"
            onClick={(event) => {
              event.preventDefault();
              navigate("/");
            }}
          >
            <Clapperboard size={24} />
            WatchMe
          </a>
          <h1>초대받은 방에 들어가기</h1>
          <label>
            <span>닉네임</span>
            <input
              value={joinName}
              onChange={(event) => setJoinName(event.target.value)}
              placeholder="친구들에게 보일 이름"
              maxLength={20}
              required
            />
          </label>
          <button className="primary-button" type="submit">
            <UsersRound size={18} />
            입장하기
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className={`room-shell ${chatFocused ? "chat-focused" : ""}`}>
      <header className="room-header">
        <a
          className="brand-mark compact"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            navigate("/");
          }}
        >
          <Clapperboard size={22} />
          WatchMe
        </a>
        <div className="room-actions">
          {localMode !== "synced" && (
            <button className="ghost-button" onClick={rejoinRoomTime}>
              <ShieldCheck size={17} />
              현재 방 시간으로 맞추기
            </button>
          )}
          <button className="ghost-button" onClick={copyInvite}>
            <Copy size={17} />
            {copied ? "복사됨" : "초대 링크"}
          </button>
          <button className="ghost-button exit-button" onClick={() => navigate("/chats")} aria-label="채팅방 목록으로 나가기">
            <MessagesSquare size={17} />
            목록
          </button>
        </div>
      </header>

      {systemNote && <div className="toast">{systemNote}</div>}
      {countdown !== null && (
        <div className="countdown-layer" role="status" aria-live="polite">
          <div className="countdown-dialog">
            <p>곧 같이 재생돼요</p>
            <strong>{countdown}</strong>
          </div>
        </div>
      )}

      <section className="watch-layout">
        <div className="watch-main">
          <div className="player-frame">
            <div id="youtube-player" className="youtube-player" />
            {!playerReady && (
              <div className="player-loading">
                <Clapperboard size={28} />
                영상을 준비하고 있어요
              </div>
            )}
            {shouldShowInitialPlayOverlay && (
              <button className="initial-play-overlay" type="button" onClick={startInitialPlaybackFromOverlay}>
                <span>
                  <Play size={22} />
                  같이 재생 시작
                </span>
              </button>
            )}
          </div>
          <div className="below-player">
            <div>
              <p className="room-kicker">ROOM {roomId}</p>
              <h1>같이 보기 방</h1>
            </div>
            <div className={`mode-pill ${isStaticPreview ? "preview" : localMode}`}>
              <span className="mode-people" aria-label={`참여자 ${sortedParticipants.length}명`}>
                <span className="people-avatars">
                  {visibleParticipants.slice(0, 5).map((participant) => (
                    <span
                      className={`avatar compact ${participant.isHost ? "host" : ""} ${
                        participant.canControl ? "controller" : ""
                      }`}
                      key={participant.id}
                      title={participant.nickname}
                    >
                      {participant.nickname.slice(0, 1)}
                    </span>
                  ))}
                  {hiddenParticipantCount > 0 && <span className="avatar compact muted">+{hiddenParticipantCount}</span>}
                </span>
                <span className="people-inline-count">{sortedParticipants.length}명</span>
              </span>
              {isStaticPreview && "프론트 미리보기"}
              {!isStaticPreview && localMode === "synced" && "같이 보는 중"}
              {!isStaticPreview && localMode === "waiting" && "잠깐 쉬는 중"}
              {!isStaticPreview && localMode === "freeplay" && "먼저 보는 중"}
            </div>
          </div>
          {canChangeVideo && (
            <form className="video-change-form" onSubmit={changeVideo}>
              <div className="video-change-input">
                <LinkIcon size={17} />
                <input
                  value={nextVideoUrl}
                  onChange={(event) => {
                    setNextVideoUrl(event.target.value);
                    if (videoUrlError) setVideoUrlError("");
                  }}
                  placeholder="새 유튜브 링크"
                  aria-label="새 유튜브 링크"
                />
              </div>
              <button type="submit" disabled={!nextVideoUrl.trim()}>
                변경
              </button>
              {videoUrlError && <p>{videoUrlError}</p>}
            </form>
          )}
        </div>

        <aside className="watch-sidebar">
          {slowPrompt && (
            <section className="pause-prompt" aria-live="polite">
              <div className="prompt-icon">
                <CirclePause size={24} />
              </div>
              <div>
                <p>잠깐 쉬는 타임, 이어보시겠어요?</p>
                <span>
                  {slowPrompt.nickname}님과 약 {slowPrompt.seconds}초 차이가 나고 있어요.
                </span>
              </div>
              <div className="prompt-actions">
                <button onClick={chooseWait}>기다릴게요</button>
                <button onClick={chooseContinue}>이어보기</button>
              </div>
            </section>
          )}

          <section className="sidebar-section chat-section">
            <div className="mobile-chat-handle" aria-hidden="true" />
            <div className="mobile-chat-header">
              <div className="mobile-chat-copy">
                <div className="mobile-chat-title-row">
                  <MessageCircle size={17} />
                  <h2>실시간 채팅</h2>
                </div>
                <div className="mobile-chat-subline">
                  <span className="people-avatars mobile-avatars">
                    {mobileVisibleParticipants.map((participant) => (
                      <span
                        className={`avatar compact ${participant.isHost ? "host" : ""} ${
                          participant.canControl ? "controller" : ""
                        }`}
                        key={participant.id}
                        title={participant.nickname}
                      >
                        {participant.nickname.slice(0, 1)}
                      </span>
                    ))}
                    {mobileHiddenParticipantCount > 0 && (
                      <span className="avatar compact muted">+{mobileHiddenParticipantCount}</span>
                    )}
                  </span>
                  <span className="people-inline-count">{sortedParticipants.length}명</span>
                </div>
              </div>
              <div className="mobile-chat-actions">
                <button
                  className={`mobile-status-pill ${isStaticPreview ? "preview" : localMode}`}
                  type="button"
                  onClick={() => {
                    if (!isStaticPreview && localMode !== "synced") rejoinRoomTime();
                  }}
                >
                  {mobileStatusLabel}
                </button>
                {canChangeVideo && (
                  <button
                    className={`mobile-icon-button ${mobileVideoFormOpen ? "active" : ""}`}
                    type="button"
                    onClick={() => setMobileVideoFormOpen((current) => !current)}
                    aria-controls="mobile-video-change-panel"
                    aria-expanded={mobileVideoFormOpen}
                    aria-label={mobileVideoFormOpen ? "영상 변경 닫기" : "영상 변경 열기"}
                  >
                    <LinkIcon size={17} />
                  </button>
                )}
                <button
                  className="mobile-icon-button"
                  type="button"
                  onClick={copyInvite}
                  aria-label={copied ? "초대 링크 복사됨" : "초대 링크 복사"}
                >
                  <Copy size={17} />
                </button>
              </div>
            </div>
            {canChangeVideo && mobileVideoFormOpen && (
              <form className="mobile-video-change-panel" id="mobile-video-change-panel" onSubmit={changeVideo}>
                <div className="video-change-input">
                  <LinkIcon size={16} />
                  <input
                    value={nextVideoUrl}
                    onChange={(event) => {
                      setNextVideoUrl(event.target.value);
                      if (videoUrlError) setVideoUrlError("");
                    }}
                    placeholder="새 유튜브 링크"
                    aria-label="새 유튜브 링크"
                  />
                </div>
                <button type="submit" disabled={!nextVideoUrl.trim()}>
                  변경
                </button>
                {videoUrlError && <p>{videoUrlError}</p>}
              </form>
            )}
            <div className="section-title">
              <MessageCircle size={18} />
              <h2>실시간 채팅</h2>
            </div>
            <div className="message-list" ref={messageListRef}>
              {messages.length === 0 && (
                <p className="empty-state">첫 반응을 남겨보세요.</p>
              )}
              {messages.map((message) => {
                const mine = message.authorId === selfId;
                return (
                  <article className={`message ${message.type} ${mine ? "mine" : ""}`} key={message.id}>
                    {!mine && <span className="message-author">{message.author}</span>}
                    <div className="message-line">
                      <p className="message-bubble">{message.text}</p>
                      <span className="message-time">{formatTime(message.videoTime)}</span>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="chat-composer">
              <div className="emoji-row" aria-label="빠른 반응">
                {["ㅋㅋ", "헉", "👏", "❤️", "😮", "🔥"].map((emoji) => (
                  <button key={emoji} onClick={() => sendEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </div>
              <form className="chat-form" onSubmit={sendMessage}>
                <span className="composer-avatar" aria-hidden="true">
                  {nickname ? nickname.slice(0, 1) : <UserRound size={18} />}
                </span>
                <div className="chat-input-wrap">
                  <input
                    value={messageText}
                    onChange={(event) => setMessageText(event.target.value)}
                    onPointerDown={keepVideoInView}
                    onFocus={keepVideoInView}
                    onBlur={releaseChatFocus}
                    placeholder="채팅..."
                    maxLength={240}
                    enterKeyHint="send"
                  />
                  <button
                    className="composer-emoji-button"
                    type="button"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => setMessageText((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}😊`)}
                    aria-label="웃는 이모지 추가"
                  >
                    <Smile size={20} />
                  </button>
                </div>
                <button className="send-button" type="submit" aria-label="메시지 보내기" disabled={!messageText.trim()}>
                  <Send size={18} />
                </button>
              </form>
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
