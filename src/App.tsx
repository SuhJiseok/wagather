import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  CirclePause,
  Clapperboard,
  Copy,
  Link as LinkIcon,
  MessageCircle,
  Play,
  Send,
  ShieldCheck,
  UserRound,
  UsersRound
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

const STORAGE_NICKNAME = "watchme:nickname";
const STORAGE_PARTICIPANT = "watchme:participant";
const STATIC_ROOM_PREFIX = "watchme:static-room:";
const DRIFT_THRESHOLD = 3;
const SEEK_COMMAND_THRESHOLD = 1.5;

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

function getRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/room\/([^/]+)/);
  return match?.[1] || null;
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
  const roomId = getRoomIdFromPath();
  return roomId ? <RoomPage roomId={roomId} /> : <HomePage />;
}

function HomePage() {
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [nickname, setNickname] = useState(() => localStorage.getItem(STORAGE_NICKNAME) || "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function createRoom(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const trimmedName = nickname.trim();
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl, nickname: trimmedName })
      });
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        throw new Error("static-preview");
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "방을 만들 수 없습니다.");
      localStorage.setItem(STORAGE_NICKNAME, trimmedName);
      window.location.href = data.inviteUrl;
    } catch (error) {
      const videoId = extractYouTubeId(youtubeUrl);
      const trimmedName = nickname.trim();
      if (videoId && trimmedName) {
        const roomId = makeLocalRoomId();
        localStorage.setItem(STORAGE_NICKNAME, trimmedName);
        localStorage.setItem(`${STATIC_ROOM_PREFIX}${roomId}`, JSON.stringify({ videoId, createdAt: Date.now() }));
        window.location.href = `/room/${roomId}?video=${encodeURIComponent(videoId)}&preview=1`;
        return;
      }
      setError(error instanceof Error && error.message !== "static-preview" ? error.message : "유튜브 링크를 확인해 주세요.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="home-shell">
      <section className="home-visual" aria-label="WatchMe 소개">
        <div className="ambient-grid" />
        <div className="brand-mark">
          <Clapperboard size={26} />
          WatchMe
        </div>
        <div className="home-copy">
          <p className="eyebrow">same video, same moment</p>
          <h1>멀리 있어도 같은 장면에서 웃게 해주는 같이 보기 방</h1>
          <p>
            유튜브 링크 하나로 방을 만들고, 채팅과 반응을 영상 옆에서 바로 주고받습니다.
          </p>
        </div>
        <div className="watch-strip" aria-hidden="true">
          <span>0:42</span>
          <div />
          <span>잠깐 쉬는 타임</span>
        </div>
      </section>

      <section className="home-panel" aria-label="방 만들기">
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
              />
            </div>
          </label>
          {error && <p className="error-text">{error}</p>}
          <button className="primary-button" type="submit" disabled={loading}>
            <Play size={18} />
            {loading ? "방 만드는 중" : "같이 보기 시작"}
          </button>
        </form>
      </section>
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

  useEffect(() => {
    const previousScrollY = window.scrollY;
    document.body.classList.add("room-scroll-lock");
    document.documentElement.classList.add("room-scroll-lock");
    window.scrollTo(0, 0);

    const keepRoomPinned = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };

    window.addEventListener("scroll", keepRoomPinned, { passive: true });

    return () => {
      window.removeEventListener("scroll", keepRoomPinned);
      document.body.classList.remove("room-scroll-lock");
      document.documentElement.classList.remove("room-scroll-lock");
      window.scrollTo(0, previousScrollY);
    };
  }, []);

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
  }, [room?.hasShownInitialCountdown, room?.videoId]);

  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

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
        staticHasShownInitialCountdownRef.current = true;
        startCountdown({
          sourceId: selfId,
          playback: { state: "paused", time, updatedAt: Date.now() },
          playAt: Date.now() + 3000
        }, true);
        return;
      }
      initialCountdownRequestedRef.current = true;
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "play", time });
    }
    if (data === window.YT.PlayerState.PAUSED) {
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "pause", time });
    }
  }

  function hasInitialCountdownBeenShown() {
    if (isStaticPreview) return staticHasShownInitialCountdownRef.current;
    return initialCountdownRequestedRef.current || Boolean(roomRef.current?.hasShownInitialCountdown);
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
      return;
    }

    socketRef.current?.emit("change-video", { roomId, participantId: selfId, youtubeUrl: nextVideoUrl });
    setNextVideoUrl("");
  }

  function keepVideoInView() {
    setChatFocused(true);
    window.requestAnimationFrame(() => window.scrollTo(0, 0));
    window.setTimeout(() => window.scrollTo(0, 0), 80);
    window.setTimeout(() => window.scrollTo(0, 0), 220);
  }

  function releaseChatFocus() {
    window.setTimeout(() => {
      setChatFocused(false);
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

  if (!joined) {
    return (
      <main className="join-shell">
        <form className="join-form" onSubmit={handleJoin}>
          <div className="brand-mark compact">
            <Clapperboard size={24} />
            WatchMe
          </div>
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
        <div className="brand-mark compact">
          <Clapperboard size={22} />
          WatchMe
        </div>
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
            <div className="section-title">
              <MessageCircle size={18} />
              <h2>실시간 채팅</h2>
            </div>
            <div className="message-list" ref={messageListRef}>
              {messages.length === 0 && (
                <p className="empty-state">첫 반응을 남겨보세요.</p>
              )}
              {messages.map((message) => (
                <article className={`message ${message.type}`} key={message.id}>
                  <div className="message-meta">
                    <strong>{message.author}</strong>
                    <span>{formatTime(message.videoTime)}</span>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))}
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
                <input
                  value={messageText}
                  onChange={(event) => setMessageText(event.target.value)}
                  onPointerDown={keepVideoInView}
                  onFocus={keepVideoInView}
                  onBlur={releaseChatFocus}
                  placeholder="지금 장면에 반응하기"
                  maxLength={240}
                  enterKeyHint="send"
                />
                <button type="submit" aria-label="메시지 보내기">
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
