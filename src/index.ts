//import { Playlist } from "./PlaylistWindow";
import { globals } from "./globals";
import { loadPalette } from "./util/Palette";
import { session } from "./project/session";
import * as edit from "./project/edit";
import * as beatEdit from "./beat/edit";
import { Instrument, Zone } from "./instruments/Instrument";
import { capture } from "./project/capture";
import { installMenus } from "./ui/Menus";

// (the mixer, the playlist and the tempo are made by session.start() below: a new project is project data like any other)

loadPalette();

//let playlist = new Playlist();
import { MixerWindow } from "./ui/windows/MixerWindow";
import { loadPluginModule, Plugin } from "./core/Plugin";
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

async function boot() {
	// the starting project, then the windows that show it
	await session.start();

	// tmp
	const tmpPlaylist = new PlaylistWindow();
	tmpPlaylist.setPosition(200, 440);
	tmpPlaylist.update();

	const tmpMixer = new MixerWindow();

	installMenus();

	// hooks for the automated tests (only present when the app is started in test mode)
	if (window.bridge.testMode) {
		(window as any).__bdp = { globals, Sample, Plugin, renderProject, encodeWav, session, edit, capture, beatEdit, Instrument, Zone };
	}

	// if the app did not close properly last time, offer to bring the work back
	await session.offerRecovery();
}
boot().catch((err) => console.error("could not start", err));
