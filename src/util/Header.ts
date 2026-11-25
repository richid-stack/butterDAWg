import { globals } from "../globals";
import { PlaylistWindow } from "../ui/windows/PlaylistWindow";
import { MixerWindow } from "../ui/windows/MixerWindow";
import { WindowType } from "../ui/misc/window";
import { AudioGraphWindow } from "../ui/windows/AudioGraphWindow";
import { msToTime } from "./time";

// bpm count drag functionality
var bpm_count = document.querySelector(".bpm");
var bpm_count_text = document.getElementById("bpm_count");
function showBpm() {
	bpm_count_text.textContent = Math.round(globals.bpm).toString();
}
function bpm_drag(e: MouseEvent) {
	// the engine keeps the music in beats, so a tempo change moves the sound but not the clips
	globals.bpm = Math.min(999, Math.max(1, globals.bpm - e.movementY / 4));
	showBpm();
}
bpm_count.addEventListener("mousedown", () => {
	document.addEventListener("mousemove", bpm_drag);
});
document.addEventListener("mouseup", () => {
	document.removeEventListener("mousemove", bpm_drag);
});
showBpm();

// play and stop buttons
const playButton = document.querySelector(".play");
const stopButton = document.querySelector(".reset");
playButton.addEventListener("click", () => {
	globals.engine.toggle().catch((err) => console.error("could not start playback", err));
});
stopButton.addEventListener("click", () => {
	globals.engine.stop();
});

// the time label under the header, and the play button, follow the engine
const timeLabel = document.querySelector(".header_time > label");
const playIcon = playButton.querySelector("i");
let shownTime = "";
let shownPlaying: boolean | null = null;
function frame() {
	const engine = globals.engine;
	const position = engine.transport.isPlaying ? engine.displayPosition() : engine.transport.position;
	const text = msToTime(Math.max(0, engine.transport.tempo.secondsAt(position)) * 1000);
	if (text !== shownTime) {
		shownTime = text;
		timeLabel.textContent = text;
	}
	if (engine.transport.isPlaying !== shownPlaying) {
		shownPlaying = engine.transport.isPlaying;
		playIcon.classList.toggle("fa-play", !shownPlaying);
		playIcon.classList.toggle("fa-pause", shownPlaying);
	}
	requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// header controls scope buttons
var scope_pat = <HTMLElement> document.querySelector(".scope_pat");
var scope_song = document.querySelector(".scope_song");
scope_pat.addEventListener("click", () => {
  if (!scope_pat.classList.contains("scope_pat_clicked")){
    scope_pat.classList.add("scope_pat_clicked");
    scope_song.classList.remove("scope_song_clicked");
  }
});
scope_song.addEventListener("click", () => {
  if (!scope_song.classList.contains("scope_song_clicked")){
    scope_song.classList.add("scope_song_clicked");
    scope_pat.classList.remove("scope_pat_clicked");
  }
});
scope_pat.click();

// mixer
document.querySelector(".header_mixer").addEventListener("click", () => {
  if (windowTypeOpen(WindowType.Mixer)) {
    console.log("mixer window already open");
  } else {
    console.log("open mixer window");
    new MixerWindow();
  }
});

// playlist
document.querySelector(".header_playlist").addEventListener("click", () => {
  if (windowTypeOpen(WindowType.Playlist)) {
    console.log("playlist window already open");
  } else {
    console.log("open playlist window");
    new PlaylistWindow();
  }
});

// audio graph
document.querySelector(".header_audio_graph").addEventListener("click", () => {
    new AudioGraphWindow();
});

export function windowTypeOpen(windowType: WindowType): boolean {
  for (let i = 0; i < globals.windows.length; i++) {
    const type = globals.windows[i].getType();
    if (type !== undefined && type == windowType) {
      return true;
    }
  }
  return false;
}