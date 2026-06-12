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
const VIDEO_METADATA_CACHE_TTL = 24 * 60 * 60 * 1000;
const videoMetadataCache = new Map();

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

function normalizeParticipantId(participantId) {
  return String(participantId || "").trim().slice(0, 80);
}

function normalizeVideoTitle(title) {
  const normalized = String(title || "").trim();
  return normalized ? normalized.slice(0, 180) : null;
}

async function fetchYouTubeVideoMetadata(videoId) {
  const cached = videoMetadataCache.get(videoId);
  const now = Date.now();
  if (cached && now - cached.fetchedAt < VIDEO_METADATA_CACHE_TTL) {
    return cached.metadata;
  }

  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`, {
      signal: controller.signal
    });
    if (!response.ok) {
      console.warn(`YouTube metadata request failed for ${videoId}: ${response.status}`);
      return null;
    }
    const data = await response.json();
    const title = normalizeVideoTitle(data.title);
    if (!title) return null;
    const metadata = {
      title,
      author: normalizeVideoTitle(data.author_name)
    };
    videoMetadataCache.set(videoId, { fetchedAt: now, metadata });
    return metadata;
  } catch (error) {
    console.warn(
      `YouTube metadata request failed for ${videoId}:`,
      error instanceof Error ? error.message : String(error)
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function createVideoHistoryItem(videoId, addedAt, addedBy, title = null) {
  return {
    videoId,
    title: normalizeVideoTitle(title),
    addedAt,
    addedBy
  };
}

function compactVideoHistory(history) {
  const latestByVideo = new Map();
  for (const item of Array.isArray(history) ? history : []) {
    if (!item?.videoId || !Number.isFinite(item.addedAt)) continue;
    const current = latestByVideo.get(item.videoId);
    if (!current || item.addedAt >= current.addedAt) {
      latestByVideo.set(
        item.videoId,
        createVideoHistoryItem(item.videoId, item.addedAt, item.addedBy || null, item.title || current?.title || null)
      );
    }
  }

  return [...latestByVideo.values()].sort((a, b) => a.addedAt - b.addedAt).slice(-30);
}

function appendVideoHistory(history, item) {
  return compactVideoHistory([...(Array.isArray(history) ? history : []), item]);
}

function roomVideoHistory(room) {
  if (Array.isArray(room.videoHistory) && room.videoHistory.length) {
    return compactVideoHistory(room.videoHistory);
  }

  return [createVideoHistoryItem(room.videoId, room.createdAt, null)];
}

function serializeRoom(room) {
  const playback = normalizedPlayback(room);
  const participants = [...room.participants.values()].map((participant) => ({
    id: participant.id,
    nickname: participant.nickname,
    isHost: participant.id === room.hostId,
    canControl: participant.id === room.hostId,
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
    videoHistory: roomVideoHistory(room),
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

function clampRatio(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0.5;
  return Math.min(1, Math.max(0, number));
}

function getRoomOrError(roomId, socket) {
  const room = rooms.get(roomId);
  if (!room) socket.emit("room-error", "방을 찾을 수 없습니다.");
  return room;
}

function getSocketParticipant(room, socket, participantId) {
  const id = normalizeParticipantId(participantId);
  if (!id || socket.data.roomId !== room.id || socket.data.participantId !== id) return null;
  return room.participants.get(id) || null;
}

app.post("/api/rooms", async (req, res) => {
  const videoId = extractYouTubeId(String(req.body.youtubeUrl || ""));
  const nickname = String(req.body.nickname || "").trim().slice(0, 20);
  const hostId = normalizeParticipantId(req.body.participantId);

  if (!videoId) {
    res.status(400).json({ message: "유튜브 링크를 확인해 주세요." });
    return;
  }

  if (!nickname) {
    res.status(400).json({ message: "닉네임을 입력해 주세요." });
    return;
  }

  if (!hostId) {
    res.status(400).json({ message: "방장 정보를 확인할 수 없습니다." });
    return;
  }

  let id = makeRoomId();
  while (rooms.has(id)) id = makeRoomId();

  const now = Date.now();
  const videoMetadata = await fetchYouTubeVideoMetadata(videoId);
  rooms.set(id, {
    id,
    videoId,
    hostId,
    controlId: hostId,
    createdAt: now,
    lastActivity: now,
    playback: {
      state: "paused",
      time: 0,
      updatedAt: now
    },
    hasShownInitialCountdown: false,
    countdownTimer: null,
    videoHistory: [createVideoHistoryItem(videoId, now, nickname, videoMetadata?.title)],
    participants: new Map(),
    members: new Map([[hostId, nickname]]),
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
      memberCount: Math.max(room.members?.size ?? 0, room.participants.size),
      participants: [...room.participants.values()]
        .slice(0, 6)
        .map((participant) => ({ id: participant.id, nickname: participant.nickname })),
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
        const metadata = await fetchYouTubeVideoMetadata(videoId);
        if (!metadata) return null;
        return {
          videoId,
          title: metadata.title,
          author: metadata.author || "",
          thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
        };
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

    const id = normalizeParticipantId(participantId);
    if (!id) {
      socket.emit("room-error", "참여자 정보를 확인할 수 없습니다.");
      return;
    }

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
    if (!room.members) room.members = new Map();
    room.members.set(id, displayName);
    if (!room.hostId) room.hostId = id;
    room.controlId = room.hostId;
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
    const participant = getSocketParticipant(room, socket, participantId);
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
    const participant = getSocketParticipant(room, socket, participantId);
    if (!participant || room.hostId !== participant.id) return;
    if (!["play", "pause", "seek"].includes(action)) return;

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
        sourceId: participant.id,
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
      sourceId: participant.id,
      action,
      playback: normalizedPlayback(room)
    });
    emitRoom(room);
  });

  socket.on("change-video", async ({ roomId, participantId, youtubeUrl }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;

    const participant = getSocketParticipant(room, socket, participantId);
    const canChangeVideo = participant && room.hostId === participant.id;
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
    const videoMetadata = await fetchYouTubeVideoMetadata(videoId);
    const history = roomVideoHistory(room);
    room.videoId = videoId;
    room.playback = { state: "paused", time: 0, updatedAt: now };
    room.hasShownInitialCountdown = false;
    room.videoHistory = appendVideoHistory(
      history,
      createVideoHistoryItem(videoId, now, participant.nickname, videoMetadata?.title)
    );
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
    const participant = getSocketParticipant(room, socket, participantId);
    if (!participant) return;
    participant.localMode = mode === "freeplay" ? "freeplay" : mode === "waiting" ? "waiting" : "synced";
    participant.updatedAt = Date.now();
    emitRoom(room);
  });

  socket.on("chat-message", ({ roomId, participantId, text, videoTime }) => {
    const room = getRoomOrError(roomId, socket);
    if (!room) return;
    const participant = getSocketParticipant(room, socket, participantId);
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
    const participant = getSocketParticipant(room, socket, participantId);
    const isEmojiLike =
      typeof emoji === "string" && emoji.length > 0 && emoji.length <= 8 && !/[\p{L}\p{N}\s]/u.test(emoji);
    const reaction = isEmojiLike ? emoji : "👏";
    if (!participant) return;

    const reactionMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "emoji",
      authorId: participant.id,
      author: participant.nickname,
      text: reaction,
      videoTime: Number.isFinite(videoTime) ? Math.max(0, Number(videoTime)) : 0,
      createdAt: Date.now()
    };
    room.lastActivity = Date.now();
    io.to(roomId).emit("emoji-burst", reactionMessage);
  });

  socket.on("cursor-chat", ({ roomId, participantId, text, x, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const participant = getSocketParticipant(room, socket, participantId);
    if (!participant) return;

    room.lastActivity = Date.now();
    socket.to(roomId).emit("cursor-chat", {
      participantId: participant.id,
      nickname: participant.nickname,
      text: String(text || "").slice(0, 80),
      x: clampRatio(x),
      y: clampRatio(y),
      at: Date.now()
    });
  });

  socket.on("tap-ping", ({ roomId, participantId, x, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const participant = getSocketParticipant(room, socket, participantId);
    if (!participant) return;

    room.lastActivity = Date.now();
    socket.to(roomId).emit("tap-ping", {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      participantId: participant.id,
      nickname: participant.nickname,
      x: clampRatio(x),
      y: clampRatio(y)
    });
  });

  socket.on("disconnect", () => {
    const { roomId, participantId } = socket.data;
    const room = roomId ? rooms.get(roomId) : null;
    if (!room || !participantId) return;

    const participant = room.participants.get(participantId);
    room.participants.delete(participantId);
    room.controlId = room.hostId;
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
