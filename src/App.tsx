import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  ChevronRight,
  Clapperboard,
  Clock3,
  Copy,
  Flame,
  History,
  Home,
  Link as LinkIcon,
  LogIn,
  Menu,
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

type VideoHistoryItem = {
  videoId: string;
  title: string | null;
  categoryId?: string | null;
  categoryTitle?: string | null;
  addedAt: number;
  addedBy: string | null;
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
  videoHistory: VideoHistoryItem[];
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

type EmojiBurstEvent = {
  text: string;
  x?: number;
  y?: number;
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
  y?: number;
  size: number;
  duration: number;
  delay: number;
  drift: number;
  expiresAt: number;
};

type RoomHeaderAction = {
  key: string;
  label: string;
  icon: React.ReactNode;
  onSelect: () => void | Promise<void>;
  tone?: "exit";
};

const QUICK_EMOJIS = ["😂", "😱", "👏", "❤️", "😮", "🔥"];
const EMOJI_BALLOONS_PER_BURST = 6;
const MAX_EMOJI_BALLOONS = 48;

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
  categoryId?: string | null;
  categoryTitle?: string | null;
  durationSeconds?: number | null;
  durationLabel?: string | null;
  viewCount?: number | null;
  viewCountLabel?: string | null;
  thumbnail: string;
};

type DurationFilter = "all" | "short";

type PopularCategory = {
  id: string;
  title: string;
};

type PopularVideosResponse = {
  videos?: PopularVideo[];
  categories?: PopularCategory[];
  maxDurationSeconds?: number | null;
  nextPageToken?: string | null;
  hasMore?: boolean;
};

type RoomSummary = {
  id: string;
  active: boolean;
  videoId?: string;
  participantCount?: number;
  memberCount?: number;
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
const SHORT_VIDEO_MAX_SECONDS = 180;

const FIXED_POPULAR_CATEGORIES: PopularCategory[] = [
  { id: "1", title: "영화/애니메이션" },
  { id: "2", title: "자동차" },
  { id: "10", title: "음악" },
  { id: "15", title: "반려동물/동물" },
  { id: "17", title: "스포츠" },
  { id: "19", title: "여행/이벤트" },
  { id: "20", title: "게임" },
  { id: "22", title: "인물/블로그" },
  { id: "23", title: "코미디" },
  { id: "24", title: "엔터테인먼트" },
  { id: "25", title: "뉴스/정치" },
  { id: "26", title: "노하우/스타일" },
  { id: "27", title: "교육" },
  { id: "28", title: "과학/기술" },
  { id: "29", title: "비영리/사회운동" }
];

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

function formatRecentWatchedAt(timestamp: number) {
  const diff = Math.max(0, Date.now() - timestamp);
  if (diff < 60_000) return "방금 전";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}시간 전`;

  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(timestamp));
}

const FALLBACK_POPULAR: PopularVideo[] = (
  [
    ["9bZkp7q19f0", "PSY - GANGNAM STYLE(강남스타일) M/V", "officialpsy", "10", "음악"],
    ["gdZLi9oWNZg", "BTS (방탄소년단) 'Dynamite' Official MV", "HYBE LABELS", "10", "음악"],
    ["WMweEpGlu_U", "BTS (방탄소년단) 'Butter' Official MV", "HYBE LABELS", "10", "음악"],
    ["IHNzOHi8sJs", "BLACKPINK - '뚜두뚜두 (DDU-DU DDU-DU)' M/V", "BLACKPINK", "10", "음악"],
    ["ioNng23DkIM", "BLACKPINK - 'How You Like That' M/V", "BLACKPINK", "10", "음악"],
    ["XqZsoesa55w", "Baby Shark Dance | 상어가족", "Pinkfong Baby Shark", "27", "교육"],
    ["kJQP7kiw5Fk", "Luis Fonsi - Despacito ft. Daddy Yankee", "Luis Fonsi", "10", "음악"],
    ["JGwWNGJdvx8", "Ed Sheeran - Shape of You (Official Music Video)", "Ed Sheeran", "10", "음악"],
    ["OPf0YbXqDm0", "Mark Ronson - Uptown Funk ft. Bruno Mars", "Mark Ronson", "10", "음악"],
    ["fJ9rUzIMcZQ", "Queen - Bohemian Rhapsody (Official Video)", "Queen Official", "10", "음악"],
    ["60ItHLz5WEA", "Alan Walker - Faded", "Alan Walker", "10", "음악"],
    ["dQw4w9WgXcQ", "Rick Astley - Never Gonna Give You Up (Official Video)", "Rick Astley", "10", "음악"]
  ] as const
).map(([videoId, title, author, categoryId, categoryTitle]) => ({
  videoId,
  title,
  author,
  categoryId,
  categoryTitle,
  thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
}));
const KNOWN_VIDEO_TITLE_BY_ID = new Map(FALLBACK_POPULAR.map((video) => [video.videoId, video.title]));

function knownVideoTitle(videoId: string) {
  return KNOWN_VIDEO_TITLE_BY_ID.get(videoId) || null;
}

function categoryToneClassName(categoryId?: string | null) {
  const toneByCategoryId: Record<string, string> = {
    "1": "film",
    "2": "auto",
    "10": "music",
    "15": "animals",
    "17": "sports",
    "19": "travel",
    "20": "gaming",
    "22": "people",
    "23": "comedy",
    "24": "entertainment",
    "25": "news",
    "26": "style",
    "27": "education",
    "28": "science",
    "29": "nonprofit"
  };

  return `category-tone-${toneByCategoryId[String(categoryId || "")] || "default"}`;
}

function categoryPillClassName(categoryId?: string | null) {
  return `category-pill ${categoryToneClassName(categoryId)}`;
}

function mergePopularVideos(current: PopularVideo[], next: PopularVideo[]) {
  const byId = new Map(current.map((video) => [video.videoId, video]));
  for (const video of next) {
    if (!byId.has(video.videoId)) byId.set(video.videoId, video);
  }
  return [...byId.values()];
}

function filterPopularByDuration(videos: PopularVideo[], durationFilter: DurationFilter) {
  if (durationFilter === "all") return videos;
  return videos.filter((video) => {
    if (!Number.isFinite(video.durationSeconds)) return false;
    const durationSeconds = Number(video.durationSeconds);
    return durationSeconds <= SHORT_VIDEO_MAX_SECONDS;
  });
}

function roomActionWidth(label: string) {
  return Math.min(220, Math.max(78, Array.from(label).length * 13 + 34));
}

function navigate(to: string) {
  window.history.pushState({}, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function popularPath(categoryId: string, options: { durationFilter?: DurationFilter } = {}) {
  const params = new URLSearchParams();
  if (categoryId !== "all") params.set("category", categoryId);
  if (options.durationFilter && options.durationFilter !== "all") params.set("duration", options.durationFilter);
  const query = params.toString();
  return query ? `/popular?${query}` : "/popular";
}

function currentPopularCategory() {
  const category = new URLSearchParams(window.location.search).get("category");
  return category?.trim() || "all";
}

function currentPopularDurationFilter(): DurationFilter {
  const duration = new URLSearchParams(window.location.search).get("duration");
  return duration === "short" ? "short" : "all";
}

function useHorizontalWheel<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let target = 0;
    let frame = 0;
    let animating = false;

    const step = () => {
      const distance = target - element.scrollLeft;
      if (Math.abs(distance) < 0.8) {
        element.scrollLeft = target;
        animating = false;
        return;
      }
      element.scrollLeft += distance * 0.22;
      frame = window.requestAnimationFrame(step);
    };

    const onWheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      let delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (!delta) return;
      if (event.deltaMode === 1) delta *= 32;
      event.preventDefault();

      if (!animating) target = element.scrollLeft;
      target = Math.max(0, Math.min(element.scrollWidth - element.clientWidth, target + delta));
      if (!animating) {
        animating = true;
        frame = window.requestAnimationFrame(step);
      }
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
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

function getStaticRoomData(roomId: string): { videoId?: string; videoHistory?: VideoHistoryItem[]; createdAt?: number } | null {
  try {
    const saved = localStorage.getItem(`${STATIC_ROOM_PREFIX}${roomId}`);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as { videoId?: string; videoHistory?: VideoHistoryItem[]; createdAt?: number };
  } catch {
    return null;
  }
}

function getStaticRoomVideoId(roomId: string) {
  const params = new URLSearchParams(window.location.search);
  const queryVideo = params.get("video");
  if (queryVideo) return queryVideo;

  return getStaticRoomData(roomId)?.videoId || null;
}

function makeVideoHistoryItem(
  videoId: string,
  addedAt: number,
  addedBy: string | null,
  title: string | null = knownVideoTitle(videoId),
  categoryId: string | null = null,
  categoryTitle: string | null = null
): VideoHistoryItem {
  return { videoId, title, categoryId, categoryTitle, addedAt, addedBy };
}

function compactVideoHistory(history: VideoHistoryItem[]) {
  const latestByVideo = new Map<string, VideoHistoryItem>();
  for (const item of history) {
    if (!item.videoId || !Number.isFinite(item.addedAt)) continue;
    const current = latestByVideo.get(item.videoId);
    if (!current || item.addedAt >= current.addedAt) {
      latestByVideo.set(item.videoId, {
        videoId: item.videoId,
        title: item.title || current?.title || knownVideoTitle(item.videoId),
        categoryId: item.categoryId || current?.categoryId || null,
        categoryTitle: item.categoryTitle || current?.categoryTitle || null,
        addedAt: item.addedAt,
        addedBy: item.addedBy || null
      });
    }
  }

  return [...latestByVideo.values()].sort((a, b) => a.addedAt - b.addedAt).slice(-30);
}

function visibleVideoHistory(history: VideoHistoryItem[]) {
  return compactVideoHistory(history).sort((a, b) => b.addedAt - a.addedAt);
}

function normalizeVideoHistory(
  history: VideoHistoryItem[] | undefined,
  currentVideoId: string,
  addedAt: number,
  addedBy: string | null
) {
  const validHistory = Array.isArray(history)
    ? history.filter((item) => item.videoId && Number.isFinite(item.addedAt))
    : [];
  if (validHistory.length) return compactVideoHistory(validHistory);
  return [makeVideoHistoryItem(currentVideoId, addedAt, addedBy)];
}

function makeStaticRoomState(roomId: string, videoId: string, participantId: string, nickname: string): RoomState {
  const staticData = getStaticRoomData(roomId);
  const now = Date.now();
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
    videoHistory: normalizeVideoHistory(staticData?.videoHistory, videoId, staticData?.createdAt || now, nickname),
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

  // 키보드/회전으로 보이는 영역이 바뀔 때 모달(바텀시트) 등이 따라가도록 앱 전역에서 추적
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

  const roomMatch = path.match(/^\/room\/([^/]+)/);
  if (roomMatch) return <RoomPage roomId={roomMatch[1]} key={roomMatch[1]} />;

  const active = path.startsWith("/chats") ? "chats" : path.startsWith("/popular") ? "popular" : "home";
  const page = active === "chats" ? <ChatsPage /> : active === "popular" ? <PopularPage /> : <HomePage />;
  return <AppShell active={active}>{page}</AppShell>;
}

const NAV_ITEMS = [
  { key: "home", label: "홈", to: "/", icon: Home },
  { key: "popular", label: "인기영상", to: "/popular", icon: Flame },
  { key: "chats", label: "채팅방", to: "/chats", icon: MessagesSquare }
] as const;

function AppShell({ active, children }: { active: "home" | "popular" | "chats"; children: React.ReactNode }) {
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
      <div className="modal-card glass-panel login-card scroll-area scroll-area-y" onClick={(event) => event.stopPropagation()}>
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
        const now = Date.now();
        localStorage.setItem(STORAGE_NICKNAME, trimmedName);
        localStorage.setItem(
          `${STATIC_ROOM_PREFIX}${roomId}`,
          JSON.stringify({
            videoId,
            createdAt: now,
            videoHistory: [makeVideoHistoryItem(videoId, now, trimmedName)]
          })
        );
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
    <div
      className="modal-layer create-room-modal-layer"
      role="dialog"
      aria-modal="true"
      aria-label="새 방 만들기"
      onClick={onClose}
    >
      <div
        className="modal-card create-room-modal glass-panel scroll-area scroll-area-y"
        onClick={(event) => event.stopPropagation()}
      >
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
      count: 0,
      total: 0
    };
  }
  if (!summary) {
    if (loading) {
      return { title: rememberedTitle || "같이 보기 방", preview: "방 정보를 불러오는 중...", ended: false, live: false, count: 0, total: 0 };
    }
    return { title: rememberedTitle || "같이 보기 방", preview: "종료된 방이에요.", ended: true, live: false, count: 0, total: 0 };
  }
  if (!summary.active) {
    return { title: rememberedTitle || "같이 보기 방", preview: "종료된 방이에요.", ended: true, live: false, count: 0, total: 0 };
  }

  const selfId = getParticipantId();
  const others = (summary.participants || []).filter((participant) => participant.id !== selfId).map((participant) => participant.nickname);
  const title = others.length ? others.join(", ") : rememberedTitle || "비어 있는 방";
  const preview = summary.lastMessage
    ? `${summary.lastMessage.author}: ${summary.lastMessage.text}`
    : "아직 대화가 없어요. 첫 반응을 남겨보세요.";
  const count = summary.participantCount || 0;
  const knownMembers = (entry.peers?.length || 0) + 1;
  return {
    title,
    preview,
    ended: false,
    live: summary.playbackState === "playing",
    count,
    total: Math.max(summary.memberCount || 0, knownMembers, count)
  };
}

type ScrollAreaProps = React.HTMLAttributes<HTMLDivElement> & {
  axis?: "x" | "y";
  bar?: "thin" | "hidden";
  ref?: React.Ref<HTMLDivElement>;
};

function ScrollArea({ axis = "y", bar = "thin", className = "", ...rest }: ScrollAreaProps) {
  const classes = ["scroll-area", `scroll-area-${axis}`, bar === "hidden" ? "scroll-area-hidden" : "", className]
    .filter(Boolean)
    .join(" ");
  return <div {...rest} className={classes} />;
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
            <span className="people-chip" aria-label={`현재 ${info.count}명 접속 중, 전체 ${info.total}명`}>
              <UsersRound size={13} />
              <span className={`people-now ${info.count > 0 ? "active" : ""}`}>{info.count}</span>
              <span className="people-total">/{info.total}</span>
            </span>
          )}
          <span>마지막 참여 {formatRelativeTime(entry.lastJoinedAt)}</span>
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
                        <span className="people-chip" aria-label={`현재 ${info.count}명 접속 중, 전체 ${info.total}명`}>
                          <UsersRound size={13} />
                          <span className={`people-now ${info.count > 0 ? "active" : ""}`}>{info.count}</span>
                          <span className="people-total">/{info.total}</span>
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

function usePopularVideos(categoryId = "all", durationFilter: DurationFilter = "all") {
  const normalizedCategory = categoryId === "all" ? "all" : categoryId;
  const normalizedDurationFilter: DurationFilter =
    durationFilter === "short" ? "short" : "all";
  const categoryRef = useRef(normalizedCategory);
  const durationFilterRef = useRef(normalizedDurationFilter);
  const [state, setState] = useState<{
    videos: PopularVideo[] | null;
    categories: PopularCategory[];
    nextPageToken: string;
    hasMore: boolean;
    loadingMore: boolean;
  }>({
    videos: null,
    categories: FIXED_POPULAR_CATEGORIES,
    nextPageToken: "",
    hasMore: false,
    loadingMore: false
  });

  useEffect(() => {
    let cancelled = false;
    categoryRef.current = normalizedCategory;
    durationFilterRef.current = normalizedDurationFilter;
    const fallbackVideos =
      normalizedCategory === "all" ? FALLBACK_POPULAR : FALLBACK_POPULAR.filter((video) => video.categoryId === normalizedCategory);
    const filteredFallbackVideos = filterPopularByDuration(fallbackVideos, normalizedDurationFilter);
    const params = new URLSearchParams();
    if (normalizedCategory !== "all") params.set("categoryId", normalizedCategory);
    if (normalizedDurationFilter === "short") params.set("maxDurationSeconds", String(SHORT_VIDEO_MAX_SECONDS));
    const query = params.toString() ? `?${params.toString()}` : "";

    setState((current) => ({
      videos: null,
      categories: current.categories.length ? current.categories : FIXED_POPULAR_CATEGORIES,
      nextPageToken: "",
      hasMore: false,
      loadingMore: false
    }));

    fetch(`/api/videos/popular${query}`)
      .then((response) => {
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) throw new Error("unavailable");
        return response.json();
      })
      .then((data: PopularVideosResponse) => {
        if (cancelled) return;
        const nextPageToken = String(data.nextPageToken || "");
        const responseVideos = filterPopularByDuration(data.videos || [], normalizedDurationFilter);
        setState({
          videos: responseVideos.length ? responseVideos : filteredFallbackVideos,
          categories: data.categories?.length ? data.categories : FIXED_POPULAR_CATEGORIES,
          nextPageToken,
          hasMore: Boolean(data.hasMore && nextPageToken),
          loadingMore: false
        });
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            videos: filteredFallbackVideos,
            categories: FIXED_POPULAR_CATEGORIES,
            nextPageToken: "",
            hasMore: false,
            loadingMore: false
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [normalizedCategory, normalizedDurationFilter]);

  const loadMore = useCallback(() => {
    if (!state.hasMore || state.loadingMore || !state.nextPageToken) return;

    const requestCategory = normalizedCategory;
    const requestDurationFilter = normalizedDurationFilter;
    const params = new URLSearchParams();
    if (requestCategory !== "all") params.set("categoryId", requestCategory);
    if (requestDurationFilter === "short") params.set("maxDurationSeconds", String(SHORT_VIDEO_MAX_SECONDS));
    params.set("pageToken", state.nextPageToken);

    setState((current) => ({ ...current, loadingMore: true }));
    fetch(`/api/videos/popular?${params.toString()}`)
      .then((response) => {
        const contentType = response.headers.get("content-type") || "";
        if (!response.ok || !contentType.includes("application/json")) throw new Error("unavailable");
        return response.json();
      })
      .then((data: PopularVideosResponse) => {
        if (categoryRef.current !== requestCategory || durationFilterRef.current !== requestDurationFilter) return;
        const nextPageToken = String(data.nextPageToken || "");
        const responseVideos = filterPopularByDuration(data.videos || [], requestDurationFilter);
        setState((current) => ({
          videos: mergePopularVideos(current.videos || [], responseVideos),
          categories: data.categories?.length ? data.categories : current.categories,
          nextPageToken,
          hasMore: Boolean(data.hasMore && nextPageToken),
          loadingMore: false
        }));
      })
      .catch(() => {
        if (categoryRef.current !== requestCategory || durationFilterRef.current !== requestDurationFilter) return;
        setState((current) => ({ ...current, loadingMore: false, hasMore: false, nextPageToken: "" }));
      });
  }, [normalizedCategory, normalizedDurationFilter, state.hasMore, state.loadingMore, state.nextPageToken]);

  return { ...state, loadMore };
}

function CategoryFilter({
  categories,
  activeCategory,
  onChange,
  mode = "select"
}: {
  categories: PopularCategory[];
  activeCategory: string;
  onChange: (categoryId: string) => void;
  mode?: "select" | "nav";
}) {
  const filterRef = useHorizontalWheel<HTMLDivElement>();
  if (!categories.length) return null;

  return (
    <ScrollArea axis="x" bar="hidden" className="category-filter-row" aria-label="영상 카테고리 필터" ref={filterRef}>
      <button
        className={`category-filter-chip ${mode === "select" && activeCategory === "all" ? "active" : ""}`}
        type="button"
        aria-pressed={mode === "select" ? activeCategory === "all" : undefined}
        onClick={() => onChange("all")}
      >
        전체
      </button>
      {categories.map((category) => (
        <button
          className={`category-filter-chip ${categoryToneClassName(category.id)} ${
            mode === "select" && activeCategory === category.id ? "active" : ""
          }`}
          type="button"
          aria-pressed={mode === "select" ? activeCategory === category.id : undefined}
          key={category.id}
          onClick={() => onChange(category.id)}
        >
          {category.title}
        </button>
      ))}
    </ScrollArea>
  );
}

function PopularVideoCard({
  video,
  onSelect,
  showCategoryBadge
}: {
  video: PopularVideo;
  onSelect: (video: PopularVideo) => void;
  showCategoryBadge: boolean;
}) {
  return (
    <button className="video-card glass-card" type="button" onClick={() => onSelect(video)}>
      <div className="room-thumb">
        <img src={video.thumbnail} alt="" loading="lazy" />
        {showCategoryBadge && video.categoryTitle && (
          <span className={categoryPillClassName(video.categoryId)}>{video.categoryTitle}</span>
        )}
        {video.durationLabel && <span className="video-duration-pill">{video.durationLabel}</span>}
        <span className="watch-overlay" aria-hidden="true">
          <span>
            <Play size={14} />
            같이 보기
          </span>
        </span>
      </div>
      <div className="video-card-body">
        <strong>{video.title}</strong>
        <div className="video-card-meta">
          <span>{video.author}</span>
          {video.viewCountLabel && (
            <>
              <span className="video-meta-separator" aria-hidden="true">
                ·
              </span>
              <span className="video-view-count">{video.viewCountLabel}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function PopularVideoCollection({
  videos,
  variant,
  onSelect,
  showCategoryBadge = true
}: {
  videos: PopularVideo[] | null;
  variant: "rail" | "grid";
  onSelect: (video: PopularVideo) => void;
  showCategoryBadge?: boolean;
}) {
  const skeletonCount = variant === "rail" ? 8 : 12;
  const railRef = useHorizontalWheel<HTMLDivElement>();

  const content =
    videos === null
      ? Array.from({ length: skeletonCount }, (_, index) => (
          <div className="video-card glass-card skeleton" key={index}>
            <div className="room-thumb" />
            <div className="video-card-body">
              <span className="skeleton-bar" style={{ width: "86%" }} />
              <span className="skeleton-bar" style={{ width: "48%" }} />
            </div>
          </div>
        ))
      : videos.map((video) => (
          <PopularVideoCard
            video={video}
            onSelect={onSelect}
            showCategoryBadge={showCategoryBadge}
            key={video.videoId}
          />
        ));

  if (variant === "rail") {
    return (
      <ScrollArea axis="x" className="video-rail" ref={railRef}>
        {content}
      </ScrollArea>
    );
  }

  return <div className="video-grid popular-video-grid">{content}</div>;
}

function HomePage() {
  const [createModalUrl, setCreateModalUrl] = useState<string | null>(null);
  const { videos: popular, categories } = usePopularVideos();
  const myRooms = useMyRooms();
  const railRooms = myRooms.entries.slice(0, 8);
  const roomRailRef = useHorizontalWheel<HTMLDivElement>();

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

      <section className="home-rooms home-rail-section" aria-label="참여 중인 채팅방">
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
          <ScrollArea axis="x" className="room-rail" ref={roomRailRef}>
            {railRooms.map((entry) => (
              <RoomCard
                key={entry.roomId}
                entry={entry}
                summary={entry.isPreview ? null : myRooms.summaries[entry.roomId] ?? null}
                loading={myRooms.loading}
              />
            ))}
          </ScrollArea>
        )}
      </section>

      <section className="home-rooms home-rail-section" aria-label="지금 인기 있는 영상">
        <div className="rail-head">
          <h2>
            <Flame size={20} />
            지금 인기 있는 영상
          </h2>
          <button className="rail-more" type="button" onClick={() => navigate("/popular")}>
            전체 보기
            <ChevronRight size={16} />
          </button>
        </div>
        <CategoryFilter
          categories={categories}
          activeCategory="all"
          mode="nav"
          onChange={(categoryId) => navigate(popularPath(categoryId))}
        />
        {popular !== null && popular.length === 0 ? (
          <div className="empty-card glass-panel">
            <Flame size={26} />
            <strong>추천 영상을 불러오지 못했어요</strong>
            <p>잠시 후 다시 시도하거나, 새 방 만들기로 직접 유튜브 링크를 붙여보세요.</p>
          </div>
        ) : (
          <PopularVideoCollection videos={popular} variant="rail" onSelect={startWatchTogether} />
        )}
      </section>

      {createModalUrl !== null && <CreateRoomModal initialUrl={createModalUrl} onClose={() => setCreateModalUrl(null)} />}
    </main>
  );
}

function PopularPage() {
  const [createModalUrl, setCreateModalUrl] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState(currentPopularCategory);
  const [durationFilter, setDurationFilter] = useState<DurationFilter>(currentPopularDurationFilter);
  const { videos: popular, categories, hasMore, loadingMore, loadMore } = usePopularVideos(
    activeCategory,
    durationFilter
  );
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const syncFilters = () => {
      setActiveCategory(currentPopularCategory());
      setDurationFilter(currentPopularDurationFilter());
    };
    window.addEventListener("popstate", syncFilters);
    return () => window.removeEventListener("popstate", syncFilters);
  }, []);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" }
    );

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, loadMore]);

  function selectCategory(categoryId: string) {
    setActiveCategory(categoryId);
    navigate(popularPath(categoryId, { durationFilter }));
  }

  function toggleShortFilter() {
    const next: DurationFilter = durationFilter === "short" ? "all" : "short";
    setDurationFilter(next);
    navigate(popularPath(activeCategory, { durationFilter: next }));
  }

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
    <main className="page popular-page">
      <header className="page-head popular-page-head">
        <div>
          <h1>인기영상</h1>
          <p>카테고리별로 골라 바로 같이 보기 방을 만들 수 있어요.</p>
        </div>
      </header>

      <CategoryFilter categories={categories} activeCategory={activeCategory} onChange={selectCategory} />
      <div className="popular-filter-tools" aria-label="영상 길이 필터">
        <button
          className={`duration-filter-chip ${durationFilter === "short" ? "active" : ""}`}
          type="button"
          aria-pressed={durationFilter === "short"}
          onClick={toggleShortFilter}
        >
          <Clock3 size={14} />
          Short
        </button>
      </div>

      {activeCategory === "all" && popular !== null && popular.length === 0 ? (
        <div className="empty-card glass-panel">
          <Flame size={26} />
          <strong>추천 영상을 불러오지 못했어요</strong>
          <p>잠시 후 다시 시도하거나, 새 방 만들기로 직접 유튜브 링크를 붙여보세요.</p>
        </div>
      ) : activeCategory !== "all" && popular !== null && popular.length === 0 ? (
        <div className="empty-card glass-panel">
          <Flame size={26} />
          <strong>
            {durationFilter === "all" ? "이 카테고리 영상이 아직 없어요" : "3분 이하 영상이 아직 없어요"}
          </strong>
          <p>{durationFilter === "all" ? "다른 카테고리를 선택해 보세요." : "Short를 끄고 다시 확인해 보세요."}</p>
        </div>
      ) : (
        <PopularVideoCollection
          videos={popular}
          variant="grid"
          onSelect={startWatchTogether}
          showCategoryBadge={activeCategory === "all"}
        />
      )}

      {popular !== null && popular.length > 0 && (hasMore || loadingMore) && (
        <div className="popular-load-more" ref={loadMoreRef} aria-live="polite">
          {loadingMore && (
            <span className="popular-load-status">
              <span className="popular-load-spinner" aria-hidden="true" />
              인기 영상 불러오는 중
            </span>
          )}
        </div>
      )}

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
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [roomMenuOpen, setRoomMenuOpen] = useState(false);
  const [hoveredRoomAction, setHoveredRoomAction] = useState<string | null>(null);
  const [initialPlaybackPending, setInitialPlaybackPending] = useState(false);
  const [cursorChat, setCursorChat] = useState<{ x: number; y: number; text: string } | null>(null);
  const [remoteBubbles, setRemoteBubbles] = useState<Record<string, CursorChatEvent>>({});
  const [pings, setPings] = useState<TapPingEvent[]>([]);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [selectedReactionEmoji, setSelectedReactionEmoji] = useState<string | null>(null);
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
  const chatFocusBaseHeightRef = useRef<number | null>(null);
  const headerScrollRelockTimeoutRef = useRef<number | null>(null);

  function scrollMessagesToBottom() {
    const pin = () => {
      const messageList = messageListRef.current;
      if (!messageList) return;
      messageList.scrollTop = messageList.scrollHeight;
    };

    pin();
    window.requestAnimationFrame(pin);
    window.setTimeout(pin, 80);
    window.setTimeout(pin, 240);
  }
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
      if (document.body.classList.contains("room-header-scroll-open")) return;
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    window.addEventListener("scroll", keepRoomPinned, { passive: true });

    return () => {
      if (headerScrollRelockTimeoutRef.current !== null) {
        window.clearTimeout(headerScrollRelockTimeoutRef.current);
        headerScrollRelockTimeoutRef.current = null;
      }
      window.removeEventListener("scroll", keepRoomPinned);
      document.body.classList.remove("room-scroll-lock");
      document.body.classList.remove("room-header-scroll-open");
      document.documentElement.classList.remove("room-scroll-lock");
      document.documentElement.classList.remove("room-header-scroll-open");
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
    if (!historyModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyModalOpen]);

  useEffect(() => {
    if (!roomMenuOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRoomMenuOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [roomMenuOpen]);

  useEffect(() => {
    if (!roomMenuOpen) setHoveredRoomAction(null);
  }, [roomMenuOpen]);

  useEffect(() => {
    if (!emojiBursts.length) return;

    const now = Date.now();
    const nextExpiry = Math.min(...emojiBursts.map((balloon) => balloon.expiresAt));
    const timeout = window.setTimeout(() => {
      const currentTime = Date.now();
      setEmojiBursts((current) => current.filter((balloon) => balloon.expiresAt > currentTime));
    }, Math.max(80, nextExpiry - now));

    return () => window.clearTimeout(timeout);
  }, [emojiBursts]);

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
    if (!reactionPickerOpen && !selectedReactionEmoji) return;
    const timeout = window.setTimeout(
      () => {
        setReactionPickerOpen(false);
        setSelectedReactionEmoji(null);
      },
      selectedReactionEmoji ? 10000 : 8000
    );
    return () => window.clearTimeout(timeout);
  }, [reactionPickerOpen, selectedReactionEmoji]);

  const peersKey = JSON.stringify(
    room?.participants.filter((participant) => participant.id !== selfId).map((participant) => participant.nickname) ?? []
  );
  const latestMessageId = messages[messages.length - 1]?.id || "";
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
    scrollMessagesToBottom();
  }, [chatFocused, latestMessageId]);

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
    if (!joined || !chatFocused) return;

    const viewport = window.visualViewport;
    const getKeyboardInset = () => {
      if (!viewport) return 0;
      const visualHeight = viewport.height || window.innerHeight;
      const offsetTop = viewport.offsetTop || 0;
      const layoutInset = Math.max(0, window.innerHeight - visualHeight - offsetTop);
      const baseHeight = chatFocusBaseHeightRef.current;
      const visualInset = baseHeight ? Math.max(0, baseHeight - visualHeight - offsetTop) : 0;
      return Math.max(layoutInset, visualInset);
    };
    let hasSeenKeyboard = getKeyboardInset() > 80;
    const releaseIfKeyboardClosed = () => {
      syncRoomViewportVars();
      if (!viewport) return;
      if (!window.matchMedia("(pointer: coarse), (max-width: 640px)").matches) return;

      const keyboardInset = getKeyboardInset();
      if (keyboardInset > 80) {
        hasSeenKeyboard = true;
        return;
      }
      if (!hasSeenKeyboard) return;

      setChatFocused(false);
      chatFocusBaseHeightRef.current = null;
      window.requestAnimationFrame(() => {
        syncRoomViewportVars();
        window.scrollTo(0, 0);
        scrollMessagesToBottom();
      });
    };

    window.addEventListener("resize", releaseIfKeyboardClosed);
    viewport?.addEventListener("resize", releaseIfKeyboardClosed);
    viewport?.addEventListener("scroll", releaseIfKeyboardClosed);
    const checkKeyboardState = window.setInterval(releaseIfKeyboardClosed, 160);

    return () => {
      window.clearInterval(checkKeyboardState);
      window.removeEventListener("resize", releaseIfKeyboardClosed);
      viewport?.removeEventListener("resize", releaseIfKeyboardClosed);
      viewport?.removeEventListener("scroll", releaseIfKeyboardClosed);
    };
  }, [chatFocused, joined]);

  useEffect(() => {
    if (!joined || !nickname) return;
    if (isStaticPreview && staticVideoId) {
      const nextRoom = makeStaticRoomState(roomId, staticVideoId, selfId, nickname);
      setRoom(nextRoom);
      setMessages(nextRoom.messages);
      return;
    }

    const socket = io();
    const joinRoom = () => {
      socket.emit("join-room", { roomId, participantId: selfId, nickname });
    };
    socketRef.current = socket;
    socket.on("connect", joinRoom);
    if (socket.connected) joinRoom();

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

    socket.on("emoji-burst", (message: EmojiBurstEvent) => {
      const point =
        typeof message.x === "number" && typeof message.y === "number"
          ? { x: clampRatio(message.x), y: clampRatio(message.y) }
          : undefined;
      spawnEmojiBurst(message.text, point);
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

  function spawnEmojiBurst(emoji: string, point?: { x: number; y: number }) {
    const now = Date.now();
    setEmojiBursts((current) => {
      const active = current.filter((balloon) => balloon.expiresAt > now);
      const count = point ? 5 : active.length > MAX_EMOJI_BALLOONS * 0.7 ? 3 : EMOJI_BALLOONS_PER_BURST;
      const batch: EmojiBalloon[] = Array.from({ length: count }, (_, index) => {
        const duration = point ? 920 + Math.random() * 460 : 1400 + Math.random() * 900;
        const delay = index * 45 + Math.random() * 80;
        const spreadX = point ? (Math.random() - 0.5) * 11 : 0;
        const spreadY = point ? (Math.random() - 0.5) * 10 : 0;
        return {
          id: `${now}-${Math.random().toString(36).slice(2)}-${index}`,
          emoji,
          x: point ? clampRatio(point.x + spreadX / 100, 0.04, 0.96) * 100 : 8 + Math.random() * 84,
          y: point ? clampRatio(point.y + spreadY / 100, 0.08, 0.88) * 100 : undefined,
          size: point ? 22 + Math.random() * 13 : 17 + Math.random() * 11,
          duration,
          delay,
          drift: point ? -28 + Math.random() * 56 : -34 + Math.random() * 68,
          expiresAt: now + duration + delay + 160
        };
      });

      return [...active, ...batch].slice(-MAX_EMOJI_BALLOONS);
    });
  }

  function sendEmoji(emoji: string, point?: { x: number; y: number }) {
    if (isStaticPreview) {
      spawnEmojiBurst(emoji, point);
      return;
    }
    socketRef.current?.emit("emoji-reaction", {
      roomId,
      participantId: selfId,
      emoji,
      x: point?.x,
      y: point?.y,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
  }

  function toggleReactionPicker() {
    setReactionPickerOpen((current) => {
      if (current) setSelectedReactionEmoji(null);
      return !current;
    });
  }

  function selectReactionEmoji(emoji: string) {
    setReactionPickerOpen(true);
    setSelectedReactionEmoji(emoji);
  }

  function sendSelectedReactionAt(clientX: number, clientY: number) {
    if (!selectedReactionEmoji) return;
    const frame = playerWrapRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const point = {
      x: clampRatio((clientX - rect.left) / rect.width),
      y: clampRatio((clientY - rect.top) / rect.height)
    };
    sendEmoji(selectedReactionEmoji, point);
    setReactionPickerOpen(false);
    setSelectedReactionEmoji(null);
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

  function applyRoomVideoChange(videoId: string | null, youtubeUrl: string) {
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
      const staticData = getStaticRoomData(roomId);
      const currentHistory = normalizeVideoHistory(staticData?.videoHistory, roomRef.current?.videoId || videoId, now, nickname);
      const nextHistory = compactVideoHistory([...currentHistory, makeVideoHistoryItem(videoId, now, nickname)]);
      localStorage.setItem(
        `${STATIC_ROOM_PREFIX}${roomId}`,
        JSON.stringify({ videoId, updatedAt: now, videoHistory: nextHistory })
      );
      setRoom((currentRoom) => {
        if (!currentRoom) return currentRoom;
        return {
          ...currentRoom,
          videoId,
          playback: { state: "paused", time: 0, updatedAt: now },
          hasShownInitialCountdown: false,
          videoHistory: nextHistory,
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

    socketRef.current?.emit("change-video", { roomId, participantId: selfId, youtubeUrl });
    setNextVideoUrl("");
    setVideoModalOpen(false);
  }

  function changeVideo(event: React.FormEvent) {
    event.preventDefault();
    applyRoomVideoChange(extractYouTubeId(nextVideoUrl), nextVideoUrl);
  }

  function playHistoryVideo(videoId: string) {
    if (!canChangeVideo) {
      setSystemNote("방장만 히스토리 영상을 재생할 수 있어요.");
      window.setTimeout(() => setSystemNote(""), 2200);
      return;
    }

    if (roomRef.current?.videoId === videoId) {
      setHistoryModalOpen(false);
      return;
    }

    applyRoomVideoChange(videoId, `https://www.youtube.com/watch?v=${videoId}`);
    setHistoryModalOpen(false);
  }

  function keepVideoInView() {
    if (!chatFocused) {
      chatFocusBaseHeightRef.current = window.visualViewport?.height || window.innerHeight;
    }
    setChatFocused(true);
    const pinRoom = () => {
      syncRoomViewportVars();
      window.scrollTo(0, 0);
      scrollMessagesToBottom();
    };

    window.requestAnimationFrame(pinRoom);
    window.setTimeout(pinRoom, 80);
    window.setTimeout(pinRoom, 240);
    window.setTimeout(pinRoom, 520);
  }

  function releaseChatFocus() {
    window.setTimeout(() => {
      setChatFocused(false);
      chatFocusBaseHeightRef.current = null;
      syncRoomViewportVars();
      window.scrollTo(0, 0);
      scrollMessagesToBottom();
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
  const videoHistory = useMemo(() => {
    return visibleVideoHistory(room?.videoHistory || []);
  }, [room?.videoHistory]);
  const mobileStatusLabel = isStaticPreview
    ? "미리보기"
    : localMode === "synced"
      ? "같이 보는 중"
      : localMode === "waiting"
        ? "방 시간 맞춤 중"
        : "개인 조작 중";
  const roomHeaderActions: RoomHeaderAction[] = [
    ...(localMode !== "synced"
      ? [
          {
            key: "sync",
            label: "현재 방 시간으로 맞추기",
            icon: <ShieldCheck size={17} />,
            onSelect: rejoinRoomTime
          }
        ]
      : []),
    {
      key: "history",
      label: "히스토리",
      icon: <History size={17} />,
      onSelect: () => setHistoryModalOpen(true)
    },
    ...(canChangeVideo
      ? [
          {
            key: "change-video",
            label: "영상 변경",
            icon: <LinkIcon size={17} />,
            onSelect: () => {
              setVideoUrlError("");
              setVideoModalOpen(true);
            }
          }
        ]
      : []),
    {
      key: "invite",
      label: copied ? "복사됨" : "초대 링크",
      icon: <Copy size={17} />,
      onSelect: copyInvite
    },
    {
      key: "chats",
      label: "목록",
      icon: <MessagesSquare size={17} />,
      onSelect: () => navigate("/chats"),
      tone: "exit"
    }
  ];

  function clearHeaderScrollRelockTimer() {
    if (headerScrollRelockTimeoutRef.current === null) return;
    window.clearTimeout(headerScrollRelockTimeoutRef.current);
    headerScrollRelockTimeoutRef.current = null;
  }

  function openHeaderPageScroll() {
    clearHeaderScrollRelockTimer();
    document.body.classList.add("room-header-scroll-open");
    document.documentElement.classList.add("room-header-scroll-open");
    headerScrollRelockTimeoutRef.current = window.setTimeout(() => {
      lockHeaderPageScroll();
    }, 700);
  }

  function lockHeaderPageScroll() {
    clearHeaderScrollRelockTimer();
    document.body.classList.remove("room-header-scroll-open");
    document.documentElement.classList.remove("room-header-scroll-open");
    if (window.scrollY !== 0) window.scrollTo(0, 0);
  }

  function scheduleHeaderPageScrollLock(delay = 140) {
    clearHeaderScrollRelockTimer();
    headerScrollRelockTimeoutRef.current = window.setTimeout(() => {
      lockHeaderPageScroll();
      headerScrollRelockTimeoutRef.current = null;
    }, delay);
  }

  function beginHeaderPageScroll(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return;
    openHeaderPageScroll();
  }

  function keepHeaderPageScroll(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return;
    openHeaderPageScroll();
  }

  function endHeaderPageScroll(event: React.PointerEvent<HTMLElement>) {
    if (event.pointerType === "mouse") return;
    scheduleHeaderPageScrollLock();
  }

  function handleHeaderWheel() {
    openHeaderPageScroll();
    scheduleHeaderPageScrollLock(180);
  }

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
      <header
        className="room-header"
        onPointerDown={beginHeaderPageScroll}
        onPointerMove={keepHeaderPageScroll}
        onPointerUp={endHeaderPageScroll}
        onPointerCancel={endHeaderPageScroll}
        onPointerLeave={endHeaderPageScroll}
        onWheel={handleHeaderWheel}
      >
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
        <div className={`room-actions liquid-room-actions ${roomMenuOpen ? "open" : ""}`}>
          <svg className="room-action-goo" aria-hidden="true" focusable="false">
            <defs>
              <filter id="room-action-goo-filter">
                <feGaussianBlur in="SourceGraphic" stdDeviation="9" result="blur" />
                <feColorMatrix in="blur" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8" result="goo" />
                <feComposite in="SourceGraphic" in2="goo" operator="atop" />
              </filter>
            </defs>
          </svg>
          <div className="liquid-action-layer liquid-action-bg" aria-hidden="true">
            <span className="room-action-bubble main" />
            {roomHeaderActions.map((action, index) => {
              const actionStyle = {
                "--offset": index + 1,
                "--expanded-width": `${roomActionWidth(action.label)}px`
              } as React.CSSProperties;
              return (
                <span
                  className={`room-action-bubble ${action.tone === "exit" ? "is-exit" : ""} ${
                    hoveredRoomAction === action.key ? "is-hovered" : ""
                  }`}
                  key={action.key}
                  style={actionStyle}
                >
                  <span className="room-action-icon">{action.icon}</span>
                  <span className="room-action-label">{action.label}</span>
                </span>
              );
            })}
          </div>
          <div className="liquid-action-layer liquid-action-buttons">
            <button
              className="room-action-bubble main"
              type="button"
              onClick={() => setRoomMenuOpen((open) => !open)}
              aria-label={roomMenuOpen ? "헤더 메뉴 닫기" : "헤더 메뉴 열기"}
              aria-expanded={roomMenuOpen}
            >
              {roomMenuOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            {roomHeaderActions.map((action, index) => {
              const actionStyle = {
                "--offset": index + 1,
                "--expanded-width": `${roomActionWidth(action.label)}px`
              } as React.CSSProperties;
              return (
                <button
                  className={`room-action-bubble ${action.tone === "exit" ? "is-exit" : ""} ${
                    hoveredRoomAction === action.key ? "is-hovered" : ""
                  }`}
                  type="button"
                  key={action.key}
                  onClick={() => {
                    void action.onSelect();
                    setHoveredRoomAction(null);
                    setRoomMenuOpen(false);
                  }}
                  onMouseEnter={() => setHoveredRoomAction(action.key)}
                  onMouseLeave={() => setHoveredRoomAction(null)}
                  onFocus={() => setHoveredRoomAction(action.key)}
                  onBlur={() => setHoveredRoomAction(null)}
                  style={actionStyle}
                  tabIndex={roomMenuOpen ? 0 : -1}
                  aria-label={action.label}
                >
                  <span className="room-action-icon">{action.icon}</span>
                  <span className="room-action-label">{action.label}</span>
                </button>
              );
            })}
          </div>
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
          <div className="modal-card glass-panel scroll-area scroll-area-y" onClick={(event) => event.stopPropagation()}>
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

      {historyModalOpen && (
        <div
          className="modal-layer"
          role="dialog"
          aria-modal="true"
          aria-label="시청 히스토리"
          onClick={() => setHistoryModalOpen(false)}
        >
          <div className="modal-card glass-panel history-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-handle" aria-hidden="true" />
            <button className="modal-close" type="button" aria-label="닫기" onClick={() => setHistoryModalOpen(false)}>
              <X size={17} />
            </button>
            <div className="panel-heading">
              <p>히스토리</p>
              <h2>이 방에서 봤던 영상</h2>
            </div>
            <div className="video-history-list scroll-area scroll-area-y">
              {videoHistory.length === 0 ? (
                <p className="empty-state">아직 기록된 영상이 없습니다.</p>
              ) : (
                videoHistory.map((item) => {
                  const thumb = videoThumbnail(item.videoId);
                  const isCurrent = item.videoId === room?.videoId;
                  const title = item.title || knownVideoTitle(item.videoId) || "제목 확인 중";
                  return (
                    <button
                      className={`video-history-item ${isCurrent ? "is-current" : "is-past"}`}
                      type="button"
                      key={item.videoId}
                      onClick={() => playHistoryVideo(item.videoId)}
                      disabled={!canChangeVideo || isCurrent}
                      aria-current={isCurrent ? "true" : undefined}
                    >
                      <div className="history-thumb">
                        {thumb && <img src={thumb} alt="" loading="lazy" />}
                        {item.categoryTitle && (
                          <span className={categoryPillClassName(item.categoryId)}>{item.categoryTitle}</span>
                        )}
                      </div>
                      <div className="history-copy">
                        <div className="history-title-row">
                          <strong>{title}</strong>
                          {isCurrent && <span>현재 영상</span>}
                        </div>
                        <div className="history-meta-row">
                          <span className="history-watch-date">최근 시청일 · {formatRecentWatchedAt(item.addedAt)}</span>
                        </div>
                        {item.addedBy && <p className="history-added-by">{item.addedBy}님 추가</p>}
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      <section className="watch-layout">
        <div className="watch-main">
          <div
            className={`player-frame ${selectedReactionEmoji ? "reaction-targeting" : ""}`}
            ref={playerWrapRef}
            onPointerDownCapture={(event) => {
              if (!selectedReactionEmoji) return;
              event.preventDefault();
              event.stopPropagation();
              sendSelectedReactionAt(event.clientX, event.clientY);
            }}
          >
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

            {selectedReactionEmoji && (
              <button
                className="reaction-touch-overlay"
                type="button"
                aria-label="선택한 이모지 반응 남기기"
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  sendSelectedReactionAt(event.clientX, event.clientY);
                }}
              />
            )}
            <div className="emoji-burst-layer" aria-hidden="true">
              {emojiBursts.map((balloon) => (
                <span
                  className={`emoji-balloon ${balloon.y === undefined ? "" : "point"}`}
                  key={balloon.id}
                  style={
                    {
                      left: `${balloon.x}%`,
                      top: balloon.y === undefined ? undefined : `${balloon.y}%`,
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
          </div>
          <div className="below-player">
            <div>
              <p className="room-kicker">같이 보는 중</p>
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

        <aside
          className="watch-sidebar"
          onPointerDown={lockHeaderPageScroll}
          onPointerMove={lockHeaderPageScroll}
          onWheel={lockHeaderPageScroll}
        >
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
                  <div className={`mobile-reaction-dock ${reactionPickerOpen ? "open" : ""}`}>
                    <button
                      className={`mobile-reaction-toggle ${selectedReactionEmoji ? "selected" : ""}`}
                      type="button"
                      aria-expanded={reactionPickerOpen}
                      aria-label="화면 이모지 반응"
                      onClick={toggleReactionPicker}
                    >
                      {selectedReactionEmoji || <Pointer size={13} />}
                    </button>
                    <div className="mobile-reaction-options" aria-hidden={!reactionPickerOpen}>
                      {QUICK_EMOJIS.map((emoji) => (
                        <button
                          className={selectedReactionEmoji === emoji ? "selected" : ""}
                          key={emoji}
                          type="button"
                          onClick={() => selectReactionEmoji(emoji)}
                          aria-label={`${emoji} 반응 선택`}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
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
            <ScrollArea className="message-list" ref={messageListRef}>
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
            </ScrollArea>
            <div className="chat-composer">
              <ScrollArea axis="x" bar="hidden" className="emoji-row" aria-label="빠른 반응">
                {QUICK_EMOJIS.map((emoji) => (
                  <button key={emoji} onClick={() => sendEmoji(emoji)}>
                    {emoji}
                  </button>
                ))}
              </ScrollArea>
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
          </section>
        </aside>
      </section>
    </main>
  );
}
