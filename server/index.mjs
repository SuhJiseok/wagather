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
    participants: new Map(),
    messages: []
  });

  res.json({ roomId: id, inviteUrl: `/room/${id}`, nickname });
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

    if (action === "seek") {
      room.playback = { state: normalized.state, time: nextTime, updatedAt: Date.now() };
    }

    if (action === "play") {
      room.playback = { state: "playing", time: nextTime, updatedAt: Date.now() };
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
