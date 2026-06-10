import express from "express";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT || 3000);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

app.get("/favicon.ico", (_, res) => {
  res.status(204).end();
});

const rooms = new Map();

function makeRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function extractYouTubeId(input) {
  try {
    const url = new URL(input.trim());
    if (url.hostname.includes("youtu.be")) {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      if (url.pathname.startsWith("/shorts/")) {
        return url.pathname.split("/").filter(Boolean)[1] || null;
      }
      if (url.pathname.startsWith("/embed/")) {
        return url.pathname.split("/").filter(Boolean)[1] || null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function serializeRoom(room) {
  const playback = normalizedPlayback(room);
  const participants = [...room.participants.values()].map((participant) => ({
    id: participant.id,
    nickname: participant.nickname,
    isHost: participant.id === room.hostId,
    canControl: participant.id === room.controlId,
    localMode: participant.localMode,
    playerState: participant.playerState,
    currentTime: participant.currentTime,
    drift: participant.currentTime - playback.time,
    updatedAt: participant.updatedAt
  }));

  return {
    id: room.id,
    videoId: room.videoId,
    hostId: room.hostId,
    controlId: room.controlId,
    playback,
    hasShownInitialCountdown: room.hasShownInitialCountdown,
    participants,
    messages: room.messages.slice(-60)
  };
}

function normalizedPlayback(room) {
  const now = Date.now();
  const elapsed = room.playback.state === "playing" ? (now - room.playback.updatedAt) / 1000 : 0;
  return {
    state: room.playback.state,
    time: Math.max(0, room.playback.time + elapsed),
    updatedAt: room.playback.updatedAt
  };
}

function emitRoom(room) {
  io.to(room.id).emit("room-state", serializeRoom(room));
}

function clearCountdown(room) {
  if (room.countdownTimer) {
    clearTimeout(room.countdownTimer);
    room.countdownTimer = null;
  }
}

function getRoomOrError(roomId, socket) {
  const room = rooms.get(roomId);
  if (!room) socket.emit("room-error", "방을 찾을 수 없습니다.");
  return room;
}

app.post("/api/rooms", (req, res) => {
  const videoId = extractYouTubeId(String(req.body.youtubeUrl || ""));
  const nickname = String(req.body.nickname || "").trim().slice(0, 20);

  if (!videoId) {
    res.status(400).json({ message: "유튜브 링크를 확인해 주세요." });
    return;
  }

  if (!nickname) {
    res.status(400).json({ message: "닉네임을 입력해 주세요." });
    return;
  }

  let id = makeRoomId();
  while (rooms.has(id)) id = makeRoomId();

  rooms.set(id, {
    id,
    videoId,
    hostId: null,
    controlId: null,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    playback: {
      state: "paused",
      time: 0,
      updatedAt: Date.now()
    },
    hasShownInitialCountdown: false,
    countdownTimer: null,
    participants: new Map(),
    messages: []
  });

  res.json({ roomId: id, inviteUrl: `/room/${id}`, nickname });
});

app.get("/api/rooms/summary", (req, res) => {
  const ids = String(req.query.ids || "")
    .split(",")
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 50);

  const summaries = ids.map((id) => {
    const room = rooms.get(id);
    if (!room) return { id, active: false };

    const lastMessage = room.messages[room.messages.length - 1] || null;
    return {
      id,
      active: true,
      videoId: room.videoId,
      participantCount: room.participants.size,
      participantNames: [...room.participants.values()].map((participant) => participant.nickname).slice(0, 6),
      playbackState: room.playback.state,
      lastMessage: lastMessage
        ? { author: lastMessage.author, text: lastMessage.text, type: lastMessage.type, createdAt: lastMessage.createdAt }
        : null,
      lastActivity: room.lastActivity
    };
  });

  res.json({ rooms: summaries });
});

const POPULAR_VIDEO_IDS = [
  "9bZkp7q19f0",
  "gdZLi9oWNZg",
  "WMweEpGlu_U",
  "IHNzOHi8sJs",
  "ioNng23DkIM",
  "XqZsoesa55w",
  "kJQP7kiw5Fk",
  "JGwWNGJdvx8",
  "OPf0YbXqDm0",
  "fJ9rUzIMcZQ",
  "60ItHLz5WEA",
  "dQw4w9WgXcQ"
];
const POPULAR_CACHE_TTL = 6 * 60 * 60 * 1000;
let popularCache = { fetchedAt: 0, videos: [] };

app.get("/api/videos/popular", async (_, res) => {
  const now = Date.now();
  if (popularCache.videos.length && now - popularCache.fetchedAt < POPULAR_CACHE_TTL) {
    res.json({ videos: popularCache.videos });
    return;
  }

  const videos = (
    await Promise.all(
      POPULAR_VIDEO_IDS.map(async (videoId) => {
        try {
          const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
          const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`);
          if (!response.ok) return null;
          const data = await response.json();
          return {
            videoId,
            title: String(data.title || ""),
            author: String(data.author_name || ""),
            thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
          };
        } catch {
          return null;
        }
      })
    )
  ).filter(Boolean);

  if (videos.length) popularCache = { fetchedAt: now, videos };
  res.json({ videos });
});

io.on("connection", (socket) => {
  socket.on("join-room", ({ roomId, participantId, nickname }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;

    const id = String(participantId || socket.id);
    const displayName = String(nickname || "게스트").trim().slice(0, 20) || "게스트";
    const participant = {
      id,
      socketId: socket.id,
      nickname: displayName,
      currentTime: 0,
      playerState: "paused",
      localMode: "synced",
      updatedAt: Date.now()
    };

    room.participants.set(id, participant);
    if (!room.hostId) room.hostId = id;
    if (!room.controlId) room.controlId = room.hostId;
    room.lastActivity = Date.now();

    socket.data.roomId = roomId;
    socket.data.participantId = id;
    socket.join(roomId);

    socket.emit("room-state", serializeRoom(room));
    socket.to(roomId).emit("system-message", `${displayName}님이 들어왔어요.`);
    emitRoom(room);
  });

  socket.on("heartbeat", ({ roomId, participantId, currentTime, playerState, localMode }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const participant = room.participants.get(String(participantId));
    if (!participant) return;

    participant.currentTime = Number.isFinite(currentTime) ? Number(currentTime) : participant.currentTime;
    participant.playerState = playerState === "playing" ? "playing" : "paused";
    participant.localMode = ["synced", "waiting", "freeplay"].includes(localMode) ? localMode : "synced";
    participant.updatedAt = Date.now();
    room.lastActivity = Date.now();
  });

  socket.on("playback-command", ({ roomId, participantId, action, time }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    const id = String(participantId);
    const participant = room.participants.get(id);
    if (!participant || room.controlId !== id || participant.localMode === "freeplay") return;

    const normalized = normalizedPlayback(room);
    const nextTime = Number.isFinite(time) ? Math.max(0, Number(time)) : normalized.time;

    if (action === "play") {
      clearCountdown(room);
      const now = Date.now();
      if (room.hasShownInitialCountdown) {
        room.playback = { state: "playing", time: nextTime, updatedAt: now };
        room.lastActivity = now;
        io.to(roomId).emit("remote-command", {
          sourceId: "system",
          action: "play",
          playback: normalizedPlayback(room)
        });
        emitRoom(room);
        return;
      }

      const playAt = now + 3000;
      room.hasShownInitialCountdown = true;
      room.playback = { state: "paused", time: nextTime, updatedAt: now };
      io.to(roomId).emit("play-countdown", {
        sourceId: id,
        playback: normalizedPlayback(room),
        playAt
      });
      room.countdownTimer = setTimeout(() => {
        room.playback = { state: "playing", time: nextTime, updatedAt: Date.now() };
        room.countdownTimer = null;
        io.to(roomId).emit("remote-command", {
          sourceId: "system",
          action: "play",
          playback: normalizedPlayback(room)
        });
        emitRoom(room);
      }, 3000);
      room.lastActivity = now;
      emitRoom(room);
      return;
    }

    clearCountdown(room);
    io.to(roomId).emit("countdown-cancelled");

    if (action === "seek") {
      room.playback = { state: normalized.state, time: nextTime, updatedAt: Date.now() };
    }

    if (action === "pause") {
      room.playback = { state: "paused", time: nextTime, updatedAt: Date.now() };
    }

    room.lastActivity = Date.now();
    io.to(roomId).emit("remote-command", {
      sourceId: id,
      action,
      playback: normalizedPlayback(room)
    });
    emitRoom(room);
  });

  socket.on("grant-control", ({ roomId, participantId, targetId }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    if (room.hostId !== String(participantId)) return;
    if (!room.participants.has(String(targetId))) return;

    room.controlId = String(targetId);
    room.lastActivity = Date.now();
    emitRoom(room);
  });

  socket.on("change-video", ({ roomId, participantId, youtubeUrl }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;

    const id = String(participantId);
    const participant = room.participants.get(id);
    const canChangeVideo = participant && (room.hostId === id || room.controlId === id);
    const videoId = extractYouTubeId(String(youtubeUrl || ""));

    if (!canChangeVideo) {
      socket.emit("room-error", "영상 변경 권한이 없습니다.");
      return;
    }

    if (!videoId) {
      socket.emit("room-error", "유튜브 링크를 확인해 주세요.");
      return;
    }

    clearCountdown(room);
    io.to(roomId).emit("countdown-cancelled");

    const now = Date.now();
    room.videoId = videoId;
    room.playback = { state: "paused", time: 0, updatedAt: now };
    room.hasShownInitialCountdown = false;
    room.lastActivity = now;

    for (const viewer of room.participants.values()) {
      viewer.currentTime = 0;
      viewer.playerState = "paused";
      viewer.localMode = "synced";
      viewer.updatedAt = now;
    }

    io.to(roomId).emit("system-message", `${participant.nickname}님이 영상을 변경했어요.`);
    emitRoom(room);
  });

  socket.on("sync-choice", ({ roomId, participantId, mode }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    const participant = room.participants.get(String(participantId));
    if (!participant) return;
    participant.localMode = mode === "freeplay" ? "freeplay" : mode === "waiting" ? "waiting" : "synced";
    participant.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("chat-message", ({ roomId, participantId, text, videoTime }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    const participant = room.participants.get(String(participantId));
    const body = String(text || "").trim().slice(0, 240);
    if (!participant || !body) return;

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "chat",
      authorId: participant.id,
      author: participant.nickname,
      text: body,
      videoTime: Number.isFinite(videoTime) ? Math.max(0, Number(videoTime)) : 0,
      createdAt: Date.now()
    };
    room.messages.push(message);
    room.lastActivity = Date.now();
    io.to(roomId).emit("chat-message", message);
  });

  socket.on("emoji-reaction", ({ roomId, participantId, emoji, videoTime }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    const participant = room.participants.get(String(participantId));
    const allowed = ["ㅋㅋ", "헉", "👏", "❤️", "😮", "🔥"];
    const reaction = allowed.includes(emoji) ? emoji : "👏";
    if (!participant) return;

    const message = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "emoji",
      authorId: participant.id,
      author: participant.nickname,
      text: reaction,
      videoTime: Number.isFinite(videoTime) ? Math.max(0, Number(videoTime)) : 0,
      createdAt: Date.now()
    };
    room.messages.push(message);
    room.lastActivity = Date.now();
    io.to(roomId).emit("chat-message", message);
    io.to(roomId).emit("emoji-burst", message);
  });

  socket.on("disconnect", () => {
    const { roomId, participantId } = socket.data;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !participantId) return;

    const participant = room.participants.get(participantId);
    room.participants.delete(participantId);
    if (room.hostId === participantId) {
      const nextHost = room.participants.values().next().value;
      room.hostId = nextHost?.id || null;
      room.controlId = room.hostId;
    }
    if (room.controlId === participantId) room.controlId = room.hostId;
    room.lastActivity = Date.now();

    if (participant) socket.to(roomId).emit("system-message", `${participant.nickname}님이 나갔어요.`);
    emitRoom(room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.participants.size === 0 && now - room.lastActivity > 30 * 60 * 1000) {
      rooms.delete(id);
    }
  }
}, 60 * 1000);

if (isProduction) {
  app.use(express.static(path.join(root, "dist")));
  app.get("*", (_, res) => res.sendFile(path.join(root, "dist", "index.html")));
} else {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
    root
  });
  app.use(vite.middlewares);
}

server.listen(port, () => {
  console.log(`WatchMe running at http://localhost:${port}`);
});
