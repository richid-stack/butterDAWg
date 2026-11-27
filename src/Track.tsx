import { Track } from "./core/Track";
import { cumulativeOffset, globals, React } from "./globals";
import { ContextMenu, CONTEXT_MENU_SPACER } from "./ui/Components/ContextMenu";
import { Color } from "./ui/misc/Color";
import { WindowType } from "./ui/misc/window";
import { ColorPicker } from "./ui/windows/ColorPicker";
import { PlaylistWindow } from "./ui/windows/PlaylistWindow";
import { windowTypeOpen } from "./util/Header";
import * as edit from "./project/edit";
import { editText } from "./ui/misc/editText";

const DEFAULT_TRACK_COLOUR = "#646e73";

export class TrackComponent {

	private element: HTMLElement;
	private track: Track;
	private resize_locked: boolean = false

	constructor(track: Track) {
		this.track = track;
		
		this.createElement();
		
        globals.tracks.push(this);
	}

	createElement() {
		this.element =
			<div className="track" id="replace_this_id">
				<div id="track_wrap">
					<div className="description">
						<p id="track_title">track_name</p>
						<i className="fa-solid fa-ellipsis"></i>
						<div className="radio_btn">
							<div className="radio_btn_green"></div>
						</div>
						<div id="track_resize"></div>
					</div>
					<div className="track_play_indicator"></div>
				</div>
			</div> as any;

		// the title is text, never markup (it can come from a project file)
		this.element.querySelector("#track_title").textContent = this.track.title;
		this.element.querySelector("#track_title").addEventListener("dblclick", () => {
			editText(this.element.querySelector("#track_title") as HTMLElement, this.track.title, (title) => edit.renameTrack(this.track, title));
		});

		let channel_context = new ContextMenu(
			globals.mixer.getChannels().map(channel => channel.getName()),
			globals.mixer.getChannels().map(channel => () => {
				edit.routeTrack(this.track, channel);
				return true;
			})
		);

		let context_menu = new ContextMenu([
			"Rename, color and icon...",
			"Change color...",
			"Change icon...",
			"Auto name",
			"Auto name clips",
			CONTEXT_MENU_SPACER,
			"Track mode",
			"Performance settings",
			CONTEXT_MENU_SPACER,
			"Size",
			"Lock to this size",
			"[spacer]",
			"Group with above track",
			"Auto color group",
			CONTEXT_MENU_SPACER,
			"Current clip source",
			"Lock to content",
			"Merge pattern clips",
			"Consolidate this clip",
			"Mute all clips",
			CONTEXT_MENU_SPACER,
			"Insert one",
			"Delete one",
			CONTEXT_MENU_SPACER,
			"Move up",
			"Move down"
		], [
			(e: MouseEvent) => {
				// rename: the same as double clicking the title
				editText(this.element.querySelector("#track_title") as HTMLElement, this.track.title, (title) => edit.renameTrack(this.track, title));
				return true;
			},
			() => {
				// (the picker gets a copy: it must not change the track's colour while it is open)
				new ColorPicker(new Color(this.track.color.color), (result: Color) => {
					edit.setTrackColor(this.track, result.color);
				}).toFront();
				return true;
			},
			null,
			null,
			null,
			(e: MouseEvent) => {
				channel_context.toggle(e);
				return false;
			},
			null,
			null,
			() => {
				this.resize_locked = !this.resize_locked;
				return true;
			},
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
			null,
		]);

		this.element.querySelector(".description").addEventListener("contextmenu", (e: any) => {
			e.preventDefault();
			if (e.target === this.element.querySelector(".description")) {
				context_menu.toggle(e);
			}
		});

		this.element.querySelector(".description").addEventListener("mouseenter", () => {
			globals.header_help_text.textContent = this.track.title;
		});

		(this.element.querySelector(".radio_btn") as HTMLElement).addEventListener("click", (e: MouseEvent) => {
			e.preventDefault();
			if (e.button === 0) {
				edit.setTracksActive([[this.track, !this.track.isActive()]]);
			}
		});

		(this.element.querySelector(".radio_btn") as HTMLElement).addEventListener("contextmenu", (e: MouseEvent) => {
			e.preventDefault();
			// solo: only this track plays; solo again and every track plays
			const tracks = globals.tracks;
			const others_on = tracks.some(track => track !== this && track.isEnabled());
			if (!others_on && this.isEnabled()) {
				edit.setTracksActive(tracks.map(track => [track.getTrack(), true] as [Track, boolean]), "Unsolo");
			} else {
				edit.setTracksActive(tracks.map(track => [track.getTrack(), track === this] as [Track, boolean]), "Solo track");
			}
		});

		this.initializeResizing();
		this.refresh();
		}

	getElement() {
		return this.element;
	}

	lockResize() {
		this.resize_locked = true;
	}

	unlockResize() {
		this.resize_locked = false;
	}

	getHeight() {
		return this.element.clientHeight;
	}

	/** shows the track as it is now: its title, colour and whether it plays */
	refresh() {
		const title = this.element.querySelector("#track_title") as HTMLElement;
		if (!title.querySelector("input")) title.textContent = this.track.title;

		const light = this.element.querySelector(".radio_btn_green") as HTMLElement;
		const description = this.element.querySelector(".description") as HTMLElement;
		const plain = this.track.isActive() && this.track.color.color === DEFAULT_TRACK_COLOUR;
		if (plain) {
			// untouched: the look comes from the style sheet
			for (const p of ["background-color", "background", "color", "border-right-color", "border-left-color"]) description.style.removeProperty(p);
			light.style.backgroundColor = "";
		} else if (this.track.isActive()) {
			light.style.backgroundColor = globals.green;
			description.style.backgroundColor = this.track.color.color;
			description.style.color = "";
			description.style.borderRightColor = this.track.color.lighten(10);
			description.style.background = this.track.color.color;
		} else {
			light.style.backgroundColor = globals.grey;
			description.style.backgroundColor = this.track.color.darken(20);
			description.style.color = "#ffffff45";
			description.style.borderRightColor = this.track.color.darken(20);
			description.style.borderLeftColor = this.track.color.darken(20);
			description.style.background = "repeating-linear-gradient(45deg, transparent, transparent 2px, #0000000a 2px, #0000000a 4px) " + this.track.color.darken(20);
		}
	}

	/** the track this component shows */
	getTrack() {
		return this.track;
	}

	isEnabled() {
		return this.track.isActive()
	}

	private initializeResizing() {
		let resize_handle = this.element.querySelector("#track_resize") as HTMLElement;
		let resizing_track: HTMLElement = null;
		let temp_this = this;
		let mouse_down_y = 0;
		let mouse_down_height = 0;
		function movefunc(e: MouseEvent) {
			if (resizing_track === null || temp_this.resize_locked) {
				return false;
			}
			const new_height = mouse_down_height + e.clientY - mouse_down_y;
			resizing_track.style.height = new_height + "px";

			// notify the playlist canvas about the new track size
			if (windowTypeOpen(WindowType.Playlist)) {
				const playlist = globals.windows.find(window => window.getType() === WindowType.Playlist);
				if (playlist instanceof PlaylistWindow) {
					playlist.updatePlaylist();
				}
			}
		}
		resize_handle.onmousedown = function (e) {
			document.addEventListener("mousemove", movefunc);
			if (temp_this.resize_locked) { return false; }
			resizing_track = temp_this.getElement();
			mouse_down_y = e.clientY;
			mouse_down_height = resizing_track.clientHeight;
			return false;
		};
		document.addEventListener("mouseup", () => {
			document.removeEventListener("mousemove", movefunc);
		});
	}
}