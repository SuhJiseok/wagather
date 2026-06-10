// 채팅방 리스트 LED 효과 확인용: 재생 중 상태의 테스트 방을 만든다.
// 사용법: node scripts/seed-live-room.mjs [서버주소]
//   예) node scripts/seed-live-room.mjs
//       node scripts/seed-live-room.mjs https://wagather.onrender.com
// 출력된 방 링크를 브라우저에서 한 번 열어 입장하면 채팅방 리스트에 추가되고,
// 영상이 재생 중인 동안 카드 테두리에 LED 효과가 표시된다.
import { io } from "socket.io-client";

const base = process.argv[2] || "http://localhost:3000";
const videoUrl = "https://www.youtube.com/watch?v=9bZkp7q19f0";

const response = await fetch(`${base}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ youtubeUrl: videoUrl, nickname: "LED테스트" })
});
if (!response.ok) {
  console.error("방 생성 실패:", response.status, await response.text());
  process.exit(1);
}
const { roomId } = await response.json();

const socket = io(base);
await new Promise((resolve, reject) => {
  socket.on("connect", resolve);
  socket.on("connect_error", reject);
});
socket.emit("join-room", { roomId, participantId: "led-test-host", nickname: "LED테스트" });
await new Promise((resolve) => setTimeout(resolve, 500));
socket.emit("playback-command", { roomId, participantId: "led-test-host", action: "play", time: 0 });

// 첫 재생은 3초 카운트다운 후 시작된다
await new Promise((resolve) => setTimeout(resolve, 4000));

const summary = await (await fetch(`${base}/api/rooms/summary?ids=${roomId}`)).json();
const state = summary.rooms?.[0]?.playbackState;
socket.disconnect();

console.log(`재생 상태: ${state}`);
console.log(`테스트 방 링크: ${base}/room/${roomId}`);
console.log("위 링크를 한 번 열어 입장한 뒤, 채팅방 리스트에서 LED 테두리를 확인하세요.");
console.log("(방은 마지막 활동 후 30분이 지나면 자동 삭제됩니다)");
process.exit(0);
