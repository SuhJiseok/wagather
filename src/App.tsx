import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  ChevronRight,
  Clapperboard,
  Copy,
  Flame,
  History,
  Home,
  Link as LinkIcon,
  LogIn,
  MessageCircle,
  MessagesSquare,
  Play,
  Plus,
  Pointer,
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

type CursorChatEvent = {
  participantId: string;
  nickname: string;
  text: string;
  x: number;
  y: number;
  at: number;
};

type TapPingEvent = {
  id: string;
  participantId: string;
  nickname: string;
  x: number;
  y: number;
};

type EmojiBalloon = {
  id: string;
  emoji: string;
  x: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
};

const QUICK_EMOJIS = ["😂", "😱", "👏", "❤️", "😮", "🔥"];

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
const STORAGE_RESUME_POINTS = "watchme:resume-points";
const STATIC_ROOM_PREFIX = "watchme:static-room:";
const SEEK_COMMAND_THRESHOLD = 1.5;
const RESUME_MIN_SECONDS = 10;
const RESUME_MAX_ENTRIES = 50;
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

type ResumePoint = { time: number; savedAt: number };

function loadResumePoints(): Record<string, ResumePoint> {
  try {
    const raw = localStorage.getItem(STORAGE_RESUME_POINTS);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, ResumePoint>;
  } catch {
    return {};
  }
}

function getResumePoint(videoId: string): ResumePoint | null {
  const point = loadResumePoints()[videoId];
  if (!point || !Number.isFinite(point.time) || point.time < RESUME_MIN_SECONDS) return null;
  return point;
}

function saveResumePoint(videoId: string, time: number) {
  if (!videoId || !Number.isFinite(time) || time < RESUME_MIN_SECONDS) return;
  const points = loadResumePoints();
  points[videoId] = { time: Math.floor(time), savedAt: Date.now() };
  const trimmed = Object.entries(points)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, RESUME_MAX_ENTRIES);
  localStorage.setItem(STORAGE_RESUME_POINTS, JSON.stringify(Object.fromEntries(trimmed)));
}

function clearResumePoint(videoId: string) {
  const points = loadResumePoints();
  if (!(videoId in points)) return;
  delete points[videoId];
  localStorage.setItem(STORAGE_RESUME_POINTS, JSON.stringify(points));
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
    body: JSON.stringify({ youtubeUrl, nickname, participantId: getParticipantId() })
  });
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) throw new Error("static-preview");
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "방을 만들 수 없습니다.");
  localStorage.setItem(STORAGE_NICKNAME, nickname);
  return data.inviteUrl as string;
}

const CURSOR_COLORS = ["#c9f25f", "#7cc8ff", "#ff9a82", "#c9a0ff", "#ffd166", "#6ee7b7"];

function participantColor(id: string) {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

function clampRatio(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
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
  const [loginOpen, setLoginOpen] = useState(false);

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
        <button className="side-login-button" type="button" onClick={() => setLoginOpen(true)}>
          <LogIn size={18} />
          로그인
        </button>
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

      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} />}
    </div>
  );
}

const SOCIAL_PROVIDERS = [
  { key: "kakao", name: "카카오", label: "카카오로 계속하기" },
  { key: "naver", name: "네이버", label: "네이버로 계속하기" },
  { key: "google", name: "Google", label: "Google로 계속하기" },
  { key: "apple", name: "Apple", label: "Apple로 계속하기" }
] as const;

function SocialIcon({ provider }: { provider: (typeof SOCIAL_PROVIDERS)[number]["key"] }) {
  if (provider === "kakao") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 0C5.373 0 0 4.226 0 9.438c0 3.368 2.245 6.327 5.62 7.999-.247.92-.797 2.973-.912 3.434-.142.571.21.564.441.41.182-.121 2.892-1.964 4.06-2.757.585.087 1.182.131 1.791.131 6.627 0 12-4.226 12-9.438C24 4.226 18.627 0 12 0z"
        />
      </svg>
    );
  }
  if (provider === "naver") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M16.273 12.845 7.376 0H0v24h7.726V11.156L16.624 24H24V0h-7.727v12.845z" />
      </svg>
    );
  }
  if (provider === "google") {
    return (
      <svg viewBox="0 0 18 18" aria-hidden="true">
        <path
          fill="#4285F4"
          d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z"
        />
        <path
          fill="#34A853"
          d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"
        />
        <path
          fill="#FBBC05"
          d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        />
        <path
          fill="#EA4335"
          d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"
      />
    </svg>
  );
}

function LoginModal({ onClose }: { onClose: () => void }) {
  const [notice, setNotice] = useState("");

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

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-label="로그인" onClick={onClose}>
      <div className="modal-card glass-panel login-card" onClick={(event) => event.stopPropagation()}>
        <div className="modal-handle" aria-hidden="true" />
        <button className="modal-close" type="button" aria-label="닫기" onClick={onClose}>
          <X size={17} />
        </button>
        <div className="panel-heading">
          <p>로그인</p>
          <h2>간편하게 시작해 보세요</h2>
        </div>
        <div className="social-login-list">
          {SOCIAL_PROVIDERS.map((provider) => (
            <button
              key={provider.key}
              className={`social-button ${provider.key}`}
              type="button"
              onClick={() => setNotice(`${provider.name} 간편로그인은 연동 준비 중이에요.`)}
            >
              <span className="social-icon">
                <SocialIcon provider={provider.key} />
              </span>
              {provider.label}
            </button>
          ))}
        </div>
        {notice ? (
          <p className="login-notice" role="status">
            {notice}
          </p>
        ) : (
          <p className="login-terms">로그인하면 참여한 방을 어느 기기에서나 이어볼 수 있어요.</p>
        )}
      </div>
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
      <defs>
        <linearGradient id="led-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c9f25f" stopOpacity="0.9" />
          <stop offset="50%" stopColor="#b9ecc9" stopOpacity="0.65" />
          <stop offset="100%" stopColor="#c9f25f" stopOpacity="0.9" />
        </linearGradient>
      </defs>
      <rect className="live-ring-track" pathLength={100} />
      <rect className="live-ring-glow" pathLength={100} />
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
    <main className="page chats-page">
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
    <main className="page home-page">
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
  const [countdown, setCountdown] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [chatFocused, setChatFocused] = useState(false);
  const [nextVideoUrl, setNextVideoUrl] = useState("");
  const [videoUrlError, setVideoUrlError] = useState("");
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [initialPlaybackPending, setInitialPlaybackPending] = useState(false);
  const [cursorChat, setCursorChat] = useState<{ x: number; y: number; text: string } | null>(null);
  const [remoteBubbles, setRemoteBubbles] = useState<Record<string, CursorChatEvent>>({});
  const [pings, setPings] = useState<TapPingEvent[]>([]);
  const [pingMode, setPingMode] = useState(false);
  const [resumePrompt, setResumePrompt] = useState<{ videoId: string; time: number } | null>(null);
  const [emojiBursts, setEmojiBursts] = useState<EmojiBalloon[]>([]);

  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const chatInputRef = useRef<HTMLTextAreaElement | null>(null);
  const participantIdRef = useRef(getParticipantId());
  const applyingRemoteRef = useRef(false);
  const suppressCommandRef = useRef(false);
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
  const playerWrapRef = useRef<HTMLDivElement | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number } | null>(null);
  const cursorChatRef = useRef<{ x: number; y: number; text: string } | null>(null);
  const cursorEmitAtRef = useRef(0);
  const cursorIdleTimeoutRef = useRef<number | null>(null);

  const selfId = participantIdRef.current;
  const self = room?.participants.find((participant) => participant.id === selfId) || null;
  const canControl = Boolean(self?.isHost);
  const canChangeVideo = Boolean(self?.isHost);
  const inviteUrl = isStaticPreview ? window.location.href : `${window.location.origin}/room/${roomId}`;
  const shouldShowInitialPlayOverlay = Boolean(
    canControl &&
      playerReady &&
      countdown === null &&
      !initialPlaybackPending &&
      !resumePrompt &&
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
    if (!canChangeVideo && videoModalOpen) {
      setVideoModalOpen(false);
    }
  }, [canChangeVideo, videoModalOpen]);

  useEffect(() => {
    if (!videoModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setVideoModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [videoModalOpen]);

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

    saveResumePoint(previousVideoId, lastKnownPlayerTimeRef.current);
    setResumePrompt(null);
    clearCountdown();
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

  useEffect(() => {
    if (!playerReady || !canControl || !room?.videoId) return;
    if (hasInitialCountdownBeenShown()) return;

    const playback = roomRef.current?.playback;
    if (!playback || playback.state === "playing" || getPlaybackTime(playback) > 3) return;

    const point = getResumePoint(room.videoId);
    if (!point) return;
    setResumePrompt({ videoId: room.videoId, time: point.time });
  }, [playerReady, canControl, room?.videoId]);

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

  useEffect(() => {
    cursorChatRef.current = cursorChat;
  }, [cursorChat]);

  useEffect(() => {
    if (!joined) return;
    const onMove = (event: MouseEvent) => {
      lastMouseRef.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [joined]);

  useEffect(() => {
    if (!joined) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.repeat) return;
      if (window.matchMedia("(pointer: coarse)").matches) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, [contenteditable]")) return;
      const frame = playerWrapRef.current;
      if (!frame) return;
      event.preventDefault();

      const rect = frame.getBoundingClientRect();
      const mouse = lastMouseRef.current;
      let x = 0.5;
      let y = 0.4;
      if (mouse && rect.width > 0 && rect.height > 0) {
        x = clampRatio((mouse.x - rect.left) / rect.width, 0.02, 0.98);
        y = clampRatio((mouse.y - rect.top) / rect.height, 0.05, 0.9);
      }
      setCursorChat({ x, y, text: "" });
      armCursorIdleTimer();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [joined]);

  useEffect(() => {
    return () => {
      if (cursorIdleTimeoutRef.current) window.clearTimeout(cursorIdleTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!Object.keys(remoteBubbles).length) return;
    const interval = window.setInterval(() => {
      const cutoff = Date.now() - 6000;
      setRemoteBubbles((current) => {
        const alive = Object.entries(current).filter(([, bubble]) => bubble.at > cutoff);
        if (alive.length === Object.keys(current).length) return current;
        return Object.fromEntries(alive);
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [remoteBubbles]);

  useEffect(() => {
    if (!pingMode) return;
    const timeout = window.setTimeout(() => setPingMode(false), 6000);
    return () => window.clearTimeout(timeout);
  }, [pingMode, pings.length]);

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
    const textarea = chatInputRef.current;
    if (!textarea) return;
    const style = window.getComputedStyle(textarea);
    const lineHeight = parseFloat(style.lineHeight) || 22;
    const maxHeight =
      lineHeight * 3 +
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight + 2, Math.round(maxHeight))}px`;
  }, [messageText]);

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
      forceSyncedByHostCommand();
      applyRemoteCommand(command);
    });

    socket.on("play-countdown", (command: CountdownCommand) => {
      forceSyncedByHostCommand();
      startCountdown(command);
    });

    socket.on("countdown-cancelled", () => {
      clearCountdown();
    });

    socket.on("cursor-chat", (event: CursorChatEvent) => {
      setRemoteBubbles((current) => {
        const next = { ...current };
        if (event.text) next[event.participantId] = event;
        else delete next[event.participantId];
        return next;
      });
    });

    socket.on("tap-ping", (event: TapPingEvent) => {
      setPings((current) => [...current.slice(-11), event]);
      window.setTimeout(() => {
        setPings((current) => current.filter((ping) => ping.id !== event.id));
      }, 1800);
    });

    socket.on("emoji-burst", (message: ChatMessage) => {
      spawnEmojiBurst(message.text);
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
    const player = playerRef.current;
    const time = hasPlayerApi(player) ? player.getCurrentTime() : 0;

    if (!canControl) {
      if (
        !isStaticPreview &&
        localModeRef.current !== "freeplay" &&
        (data === window.YT.PlayerState.PLAYING ||
          data === window.YT.PlayerState.PAUSED ||
          data === window.YT.PlayerState.CUED)
      ) {
        updateLocalMode("freeplay");
      }
      lastKnownPlayerTimeRef.current = time;
      return;
    }

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

  function resumeFromSavedPoint() {
    if (!resumePrompt) return;
    const { videoId, time } = resumePrompt;
    clearResumePoint(videoId);
    setResumePrompt(null);
    requestInitialPlaybackCountdown(time);
  }

  function dismissResumePrompt() {
    if (!resumePrompt) return;
    clearResumePoint(resumePrompt.videoId);
    setResumePrompt(null);
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
    setResumePrompt(null);
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
    setResumePrompt(null);
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

  function forceSyncedByHostCommand() {
    if (localModeRef.current === "synced") return;

    setLocalMode("synced");
    localModeRef.current = "synced";
    if (!isStaticPreview) {
      socketRef.current?.emit("sync-choice", { roomId, participantId: selfId, mode: "synced" });
    }
  }

  function updateLocalMode(mode: LocalMode) {
    setLocalMode(mode);
    localModeRef.current = mode;
    if (!isStaticPreview) {
      socketRef.current?.emit("sync-choice", { roomId, participantId: selfId, mode });
    }
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
  }

  function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
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

  function spawnEmojiBurst(emoji: string) {
    const count = 5 + Math.floor(Math.random() * 3);
    const batch: EmojiBalloon[] = Array.from({ length: count }, (_, index) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}-${index}`,
      emoji,
      x: 8 + Math.random() * 84,
      size: 18 + Math.random() * 14,
      duration: 1800 + Math.random() * 1200,
      delay: index * 90 + Math.random() * 120,
      drift: -36 + Math.random() * 72
    }));
    setEmojiBursts((current) => [...current, ...batch].slice(-60));
    const maxLife = Math.max(...batch.map((balloon) => balloon.duration + balloon.delay)) + 200;
    window.setTimeout(() => {
      setEmojiBursts((current) => current.filter((balloon) => !batch.some((item) => item.id === balloon.id)));
    }, maxLife);
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
      spawnEmojiBurst(emoji);
      return;
    }
    socketRef.current?.emit("emoji-reaction", {
      roomId,
      participantId: selfId,
      emoji,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
  }

  function emitCursorChat(x: number, y: number, text: string, force = false) {
    if (isStaticPreview) return;
    const now = Date.now();
    if (!force && now - cursorEmitAtRef.current < 80) return;
    cursorEmitAtRef.current = now;
    socketRef.current?.emit("cursor-chat", { roomId, participantId: selfId, text, x, y });
  }

  function moveCursorChat(event: React.PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clampRatio((event.clientX - rect.left) / rect.width, 0.02, 0.98);
    const y = clampRatio((event.clientY - rect.top) / rect.height, 0.05, 0.9);
    setCursorChat((current) => (current ? { ...current, x, y } : current));
    emitCursorChat(x, y, cursorChatRef.current?.text ?? "");
  }

  function armCursorIdleTimer() {
    if (cursorIdleTimeoutRef.current) window.clearTimeout(cursorIdleTimeoutRef.current);
    cursorIdleTimeoutRef.current = window.setTimeout(() => closeCursorChat(), 4000);
  }

  function updateCursorChatText(text: string) {
    const current = cursorChatRef.current;
    if (!current) return;
    setCursorChat({ ...current, text });
    emitCursorChat(current.x, current.y, text, true);
    armCursorIdleTimer();
  }

  function closeCursorChat() {
    if (cursorIdleTimeoutRef.current) {
      window.clearTimeout(cursorIdleTimeoutRef.current);
      cursorIdleTimeoutRef.current = null;
    }
    const current = cursorChatRef.current;
    setCursorChat(null);
    if (isStaticPreview || !current) return;
    socketRef.current?.emit("cursor-chat", { roomId, participantId: selfId, text: "", x: current.x, y: current.y });
  }

  function sendPingAt(clientX: number, clientY: number) {
    const frame = playerWrapRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = clampRatio((clientX - rect.left) / rect.width);
    const y = clampRatio((clientY - rect.top) / rect.height);
    const ping: TapPingEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      participantId: selfId,
      nickname,
      x,
      y
    };
    setPings((current) => [...current.slice(-11), ping]);
    window.setTimeout(() => setPings((current) => current.filter((item) => item.id !== ping.id)), 1800);
    if (!isStaticPreview) {
      socketRef.current?.emit("tap-ping", { roomId, participantId: selfId, x, y });
    }
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
      setVideoModalOpen(false);
      return;
    }

    socketRef.current?.emit("change-video", { roomId, participantId: selfId, youtubeUrl: nextVideoUrl });
    setNextVideoUrl("");
    setVideoModalOpen(false);
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
        ? "방 시간 맞춤 중"
        : "개인 조작 중";

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
          {canChangeVideo && (
            <button
              className="ghost-button"
              onClick={() => {
                setVideoUrlError("");
                setVideoModalOpen(true);
              }}
            >
              <LinkIcon size={17} />
              영상 변경
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

      {videoModalOpen && canChangeVideo && (
        <div
          className="modal-layer"
          role="dialog"
          aria-modal="true"
          aria-label="영상 변경"
          onClick={() => setVideoModalOpen(false)}
        >
          <div className="modal-card glass-panel" onClick={(event) => event.stopPropagation()}>
            <div className="modal-handle" aria-hidden="true" />
            <button className="modal-close" type="button" aria-label="닫기" onClick={() => setVideoModalOpen(false)}>
              <X size={17} />
            </button>
            <div className="panel-heading">
              <p>영상 변경</p>
              <h2>새 유튜브 링크를 붙여 주세요</h2>
            </div>
            <form className="room-form" onSubmit={changeVideo}>
              <label>
                <span>유튜브 링크</span>
                <div className="input-wrap">
                  <LinkIcon size={18} />
                  <input
                    value={nextVideoUrl}
                    onChange={(event) => {
                      setNextVideoUrl(event.target.value);
                      if (videoUrlError) setVideoUrlError("");
                    }}
                    placeholder="https://www.youtube.com/watch?v=..."
                    required
                    autoFocus
                  />
                </div>
              </label>
              {videoUrlError && <p className="error-text">{videoUrlError}</p>}
              <button className="primary-button" type="submit" disabled={!nextVideoUrl.trim()}>
                <Play size={18} />
                영상 변경
              </button>
            </form>
          </div>
        </div>
      )}

      <section className="watch-layout">
        <div className="watch-main">
          <div className="player-frame" ref={playerWrapRef}>
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

            {resumePrompt && (
              <div className="resume-overlay" role="dialog" aria-label="이어보기 안내">
                <div className="resume-card">
                  <p className="resume-title">
                    <History size={17} />
                    <strong>{formatTime(resumePrompt.time)}</strong>에서 중단한 기록이 있습니다
                  </p>
                  <p className="resume-question">이어 보시겠습니까?</p>
                  <div className="resume-actions">
                    <button className="primary-button" type="button" onClick={resumeFromSavedPoint}>
                      <Play size={17} />
                      이어 보기
                    </button>
                    <button className="ghost-button" type="button" onClick={dismissResumePrompt}>
                      처음부터
                    </button>
                  </div>
                </div>
              </div>
            )}

            {Object.values(remoteBubbles).map((bubble) => (
              <div
                className="cursor-bubble remote"
                key={bubble.participantId}
                style={
                  {
                    left: `${bubble.x * 100}%`,
                    top: `${bubble.y * 100}%`,
                    "--bubble-color": participantColor(bubble.participantId)
                  } as React.CSSProperties
                }
              >
                <span className="cursor-bubble-name">{bubble.nickname}</span>
                <p>{bubble.text}</p>
              </div>
            ))}

            {pings.map((ping) => (
              <div
                className="tap-ping"
                key={ping.id}
                style={
                  {
                    left: `${ping.x * 100}%`,
                    top: `${ping.y * 100}%`,
                    "--bubble-color": participantColor(ping.participantId)
                  } as React.CSSProperties
                }
              >
                <span className="tap-ping-ripple" />
                <span className="tap-ping-name">{ping.nickname}</span>
              </div>
            ))}

            {cursorChat && (
              <div
                className="cursor-chat-overlay"
                onPointerMove={moveCursorChat}
                onPointerDown={(event) => {
                  if (event.target === event.currentTarget) event.preventDefault();
                }}
              >
                <div
                  className="cursor-bubble self"
                  style={
                    {
                      left: `${cursorChat.x * 100}%`,
                      top: `${cursorChat.y * 100}%`,
                      "--bubble-color": participantColor(selfId)
                    } as React.CSSProperties
                  }
                >
                  <span className="cursor-bubble-name">{nickname}</span>
                  <span className="cursor-input-sizer">
                    <span aria-hidden="true">{cursorChat.text || "메시지 입력..."}</span>
                    <input
                      autoFocus
                      size={2}
                      value={cursorChat.text}
                      maxLength={80}
                      placeholder="메시지 입력..."
                      onChange={(event) => updateCursorChatText(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") closeCursorChat();
                      }}
                      onBlur={() => closeCursorChat()}
                    />
                  </span>
                </div>
              </div>
            )}

            {pingMode && (
              <button
                className="ping-overlay"
                type="button"
                aria-label="탭한 위치 포인팅"
                onPointerDown={(event) => sendPingAt(event.clientX, event.clientY)}
              />
            )}
            <button
              className={`ping-toggle ${pingMode ? "active" : ""}`}
              type="button"
              aria-pressed={pingMode}
              aria-label="여기 봐 포인터 모드"
              onClick={() => setPingMode((current) => !current)}
            >
              <Pointer size={16} />
            </button>
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
              {!isStaticPreview && localMode === "waiting" && "방 시간 맞춤 중"}
              {!isStaticPreview && localMode === "freeplay" && "개인 조작 중"}
            </div>
          </div>
        </div>

        <aside className="watch-sidebar">
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
                    className="mobile-icon-button"
                    type="button"
                    onClick={() => {
                      setVideoUrlError("");
                      setVideoModalOpen(true);
                    }}
                    aria-label="영상 변경"
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
                {QUICK_EMOJIS.map((emoji) => (
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
                  <textarea
                    ref={chatInputRef}
                    value={messageText}
                    rows={1}
                    onChange={(event) => setMessageText(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || event.shiftKey) return;
                      if (event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      sendMessage();
                    }}
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

            <div className="emoji-burst-layer" aria-hidden="true">
              {emojiBursts.map((balloon) => (
                <span
                  className="emoji-balloon"
                  key={balloon.id}
                  style={
                    {
                      left: `${balloon.x}%`,
                      fontSize: `${balloon.size}px`,
                      animationDuration: `${balloon.duration}ms`,
                      animationDelay: `${balloon.delay}ms`,
                      "--drift": `${balloon.drift}px`
                    } as React.CSSProperties
                  }
                >
                  {balloon.emoji}
                </span>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}
