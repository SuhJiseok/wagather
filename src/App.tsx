import { useEffect, useMemo, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  CirclePause,
  Clapperboard,
  Copy,
  Crown,
  Hand,
  Link as LinkIcon,
  MessageCircle,
  Play,
  Send,
  ShieldCheck,
  SmilePlus,
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
  participants: Participant[];
  messages: ChatMessage[];
};

type RemoteCommand = {
  sourceId: string;
  action: "play" | "pause" | "seek";
  playback: RoomState["playback"];
};

type SlowPrompt = {
  nickname: string;
  seconds: number;
};

const STORAGE_NICKNAME = "watchme:nickname";
const STORAGE_PARTICIPANT = "watchme:participant";
const DRIFT_THRESHOLD = 3;

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

function getRoomIdFromPath() {
  const match = window.location.pathname.match(/^\/room\/([^/]+)/);
  return match?.[1] || null;
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
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ youtubeUrl, nickname })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "방을 만들 수 없습니다.");
      localStorage.setItem(STORAGE_NICKNAME, nickname.trim());
      window.location.href = data.inviteUrl;
    } catch (error) {
      setError(error instanceof Error ? error.message : "다시 시도해 주세요.");
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
  const [copied, setCopied] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "people">("chat");

  const socketRef = useRef<Socket | null>(null);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const participantIdRef = useRef(getParticipantId());
  const applyingRemoteRef = useRef(false);
  const suppressCommandRef = useRef(false);
  const waitHoldTimeRef = useRef<number | null>(null);
  const roomRef = useRef<RoomState | null>(null);
  const localModeRef = useRef<LocalMode>("synced");

  const selfId = participantIdRef.current;
  const self = room?.participants.find((participant) => participant.id === selfId) || null;
  const canControl = Boolean(self?.canControl && localMode !== "freeplay");
  const inviteUrl = `${window.location.origin}/room/${roomId}`;

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  useEffect(() => {
    localModeRef.current = localMode;
  }, [localMode]);

  useEffect(() => {
    if (!joined || !nickname) return;

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

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [joined, nickname, roomId, selfId]);

  useEffect(() => {
    if (!room?.videoId) return;
    let cancelled = false;

    loadYouTubeApi().then(() => {
      if (cancelled || !window.YT?.Player) return;
      if (typeof playerRef.current?.destroy === "function") playerRef.current.destroy();
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
              player.seekTo(playback.time, true);
              if (playback.state === "playing") player.playVideo();
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
    if (applyingRemoteRef.current || suppressCommandRef.current) return;
    if (!canControl) return;

    const player = playerRef.current;
    const time = hasPlayerApi(player) ? player.getCurrentTime() : 0;
    if (data === window.YT.PlayerState.PLAYING) {
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "play", time });
    }
    if (data === window.YT.PlayerState.PAUSED) {
      socketRef.current?.emit("playback-command", { roomId, participantId: selfId, action: "pause", time });
    }
  }

  function applyRemoteCommand(command: RemoteCommand) {
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

  function updateLocalMode(mode: LocalMode) {
    setLocalMode(mode);
    localModeRef.current = mode;
    socketRef.current?.emit("sync-choice", { roomId, participantId: selfId, mode });
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
    socketRef.current?.emit("chat-message", {
      roomId,
      participantId: selfId,
      text,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
    setMessageText("");
  }

  function sendEmoji(emoji: string) {
    socketRef.current?.emit("emoji-reaction", {
      roomId,
      participantId: selfId,
      emoji,
      videoTime: hasPlayerApi(playerRef.current) ? playerRef.current.getCurrentTime() : localTime
    });
  }

  function grantControl(targetId: string) {
    socketRef.current?.emit("grant-control", { roomId, participantId: selfId, targetId });
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
    <main className="room-shell">
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
            <div className={`mode-pill ${localMode}`}>
              {localMode === "synced" && "같이 보는 중"}
              {localMode === "waiting" && "잠깐 쉬는 중"}
              {localMode === "freeplay" && "먼저 보는 중"}
            </div>
          </div>
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

          <div className="mobile-tabs">
            <button className={mobileTab === "chat" ? "active" : ""} onClick={() => setMobileTab("chat")}>
              <MessageCircle size={16} />
              채팅
            </button>
            <button className={mobileTab === "people" ? "active" : ""} onClick={() => setMobileTab("people")}>
              <UsersRound size={16} />
              참여자
            </button>
          </div>

          <section className={`sidebar-section chat-section ${mobileTab === "chat" ? "mobile-active" : ""}`}>
            <div className="section-title">
              <MessageCircle size={18} />
              <h2>채팅</h2>
            </div>
            <div className="message-list">
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
                placeholder="지금 장면에 반응하기"
                maxLength={240}
              />
              <button type="submit" aria-label="메시지 보내기">
                <Send size={18} />
              </button>
            </form>
          </section>

          <section className={`sidebar-section people-section ${mobileTab === "people" ? "mobile-active" : ""}`}>
            <div className="section-title">
              <UsersRound size={18} />
              <h2>참여자</h2>
            </div>
            <div className="participant-list">
              {sortedParticipants.map((participant) => (
                <article className="participant" key={participant.id}>
                  <div className="participant-main">
                    <div className="avatar">{participant.nickname.slice(0, 1)}</div>
                    <div>
                      <p>
                        {participant.nickname}
                        {participant.isHost && <Crown size={14} />}
                        {participant.canControl && <Hand size={14} />}
                      </p>
                      <span>{participantStatus(participant)}</span>
                    </div>
                  </div>
                  {self?.isHost && !participant.canControl && (
                    <button onClick={() => grantControl(participant.id)}>권한 주기</button>
                  )}
                </article>
              ))}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

function participantStatus(participant: Participant) {
  if (participant.localMode === "waiting") return "잠깐 쉬는 중";
  if (participant.localMode === "freeplay") return "먼저 보는 중";
  if (Math.abs(participant.drift) < DRIFT_THRESHOLD) return "같이 보는 중";
  if (participant.drift < 0) return `${participant.nickname}님이 ${Math.abs(Math.floor(participant.drift))}초 뒤쳐져 있어요`;
  return `${participant.nickname}님이 ${Math.floor(participant.drift)}초 앞서 있어요`;
}
