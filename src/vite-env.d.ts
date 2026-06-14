/// <reference types="vite/client" />

interface Window {
  YT?: {
    Player: new (
      elementId: string,
      options: {
        videoId: string;
        playerVars?: Record<string, unknown>;
        events?: Record<string, (event: unknown) => void>;
      }
    ) => YouTubePlayer;
    PlayerState: {
      UNSTARTED: -1;
      ENDED: 0;
      PLAYING: 1;
      PAUSED: 2;
      BUFFERING: 3;
      CUED: 5;
    };
  };
  onYouTubeIframeAPIReady?: () => void;
}

interface YouTubePlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  cueVideoById: (videoId: string, startSeconds?: number) => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getPlayerState: () => number;
  getDuration: () => number;
  mute: () => void;
  unMute: () => void;
  isMuted: () => boolean;
  setVolume: (volume: number) => void;
  getVolume: () => number;
  destroy: () => void;
}
