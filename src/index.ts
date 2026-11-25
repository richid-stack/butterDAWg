//import { Playlist } from "./PlaylistWindow";
import { Playlist } from "./core/Playlist";
import { globals } from "./globals";
import { loadPalette } from "./util/Palette";
import { Mixer } from "./core/Mixer";

// load the core penis
globals.mixer = new Mixer();
globals.mixer.newChannel();
globals.mixer.newChannel();
globals.mixer.newChannel();
globals.mixer.newChannel();
globals.playlist = new Playlist();
for (let i = 0; i < 15; i++) {
	globals.playlist.newTrack().title = "Track " + i;
}
// the engine plays whatever is on the playlist
globals.engine.setProvider(globals.playlist);

loadPalette();

//let playlist = new Playlist();
import { MixerWindow } from "./ui/windows/MixerWindow";
import { loadPluginModule } from "./core/Plugin";
import { Sample } from "./core/Sample";
import { renderProject } from "./core/renderProject";
import { encodeWav } from "./engine/Wav";
import { discoverPlugins } from "./util/plugins";
import { PlaylistWindow } from "./ui/windows/PlaylistWindow";
window.addEventListener("load", () => {
	// sidebar resizing
	var resizing_sidebar = false;

	(function() {
	var container = document.getElementById("content"),
		left = document.getElementById("sidebar"),
		right = document.getElementById("main_content"),
		handle = document.getElementById("sidebar_resize");

	handle.onmousedown = function(e) {
		resizing_sidebar = true;
		return false;
	};

	document.onmousemove = function(e) {
		// we don't want to do anything if we aren't resizing.
		if (!resizing_sidebar) {
		return;
		}

		var offsetRight = container.clientWidth - (e.clientX - container.offsetLeft);

		left.style.width = container.clientWidth - offsetRight + "px";
		right.style.width = offsetRight + "px";

		for (let i = 0; i < globals.windows.length; i++) {
			if (globals.windows[i].getPosition().x < left.clientWidth) {
				globals.windows[i].setPosition(left.clientWidth, globals.windows[i].getPosition().y);
			}
		}

		return false;
	}

	document.addEventListener("mouseup", () => {
		resizing_sidebar = false;
	});
	})();
});

require("./util/Header");

// find the plugins and load their audio code, in the background; the mixer
// lists them once they are known
discoverPlugins()
	.then((found) => {
		globals.plugins = found;
		return Promise.all(found.map((pluginPath) => loadPluginModule(globals.audiocontext, pluginPath)));
	})
	.catch((err) => console.error("could not load the plugins", err));

// tmp
const tmpPlaylist = new PlaylistWindow();
tmpPlaylist.setPosition(200, 440);
tmpPlaylist.update();

const tmpMixer = new MixerWindow();

globals.playlist.getTracks()[0].connect(globals.mixer.getChannels()[0]);

// hooks for the automated tests (only present when the app is started in test mode)
if (window.bridge.testMode) {
	(window as any).__bdp = { globals, Sample, renderProject, encodeWav };
}
