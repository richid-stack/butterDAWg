import { globals, Draggable, sidebar_folder_colors, insertAfter } from "./globals";
import { files } from "./platform/files";
import { isAudioFile } from "./engine/AudioLoader";
import { SampleSource } from "./core/Sample";

// One row of the sidebar: a folder, an audio file or some other file. Folders
// list their contents when they are opened, so a big library costs nothing
// until you look inside it. Audio files can be dragged onto the playlist.

export class Item extends Draggable implements SampleSource {
	/** where the file or folder is */
	readonly path: string;
	readonly isDirectory: boolean;
	readonly isAudio: boolean;
	active: boolean;
	indent: number;
	children: Array<Item>;
	title: string;
	private opening = false;

	constructor(title: string, path: string, isDirectory: boolean, indent = 0) {
		super();
		this.path = path;
		this.isDirectory = isDirectory;
		this.isAudio = !isDirectory && isAudioFile(title);
		this.active = false;
		this.indent = indent;
		this.children = [];
		this.title = title;

		// construct container
		var a = document.createElement("div");
		a.classList.add("sidebar_item_lvl1");
		var dedicated_color = sidebar_folder_colors[title];
		a.style.color = dedicated_color === undefined ? "var(--bg-light)" : dedicated_color;
		a.style.paddingLeft = indent * globals.palette_indent_width + "px";
		this.element = a;
		// add icon
		var type_icon = document.createElement("i");
		if (this.isAudio) {
			type_icon.classList.add("fa-solid");
			type_icon.classList.add("fa-file-audio");
			this.initializeDragListener();
			// start reading and decoding the file when the mouse goes down on it,
			// so that it is ready by the time it is dropped on the playlist
			a.addEventListener("mousedown", () => {
				globals.engine.samples.load(this.path).catch((err) => console.error("could not load " + this.path, err));
			});
		} else if (isDirectory) {
			type_icon.classList.add("fa-regular");
			type_icon.classList.add("fa-folder");
		} else {
			type_icon.classList.add("fa-solid");
			type_icon.classList.add("fa-file");
		}
		a.appendChild(type_icon);
		// add text object
		var b = document.createElement("div");
		b.classList.add("sidebar_item_lvl1_text");
		b.textContent = title;
		a.appendChild(b);

		this.initializeEventListeners();
	}

	initializeEventListeners() {
		this.element.addEventListener("click", () => {
			if (!this.isDirectory) { return; }
			if (this.active) {
				this.active = false;
				this.close();
			} else {
				this.active = true;
				this.open();
			}
		});
	}

	getDragElement() {
		return this.element.children[1];
	}

	close() {
		this.children.forEach(item => {
			item.close();
			item.remove();
		});
		this.children = [];
	}

	/** lists the folder and adds a row for each file in it that is worth showing */
	async open() {
		if (!this.isDirectory || this.opening) { return; }
		this.opening = true;
		try {
			const entries = await files.list(this.path);
			// the folder may have been closed again while it was being listed
			if (!this.active) { return; }
			// each row goes after the previous one, so the folder's order is kept
			let previous = this.element;
			for (const entry of entries) {
				// hidden files (".DS_Store", ".gitkeep") are not for the user
				if (entry.name[0] === ".") { continue; }
				const item = new Item(entry.name, this.path + "/" + entry.name, entry.isDirectory, this.indent + 1);
				item.appendAfter(previous);
				previous = item.element;
				this.children.push(item);
			}
		} catch (err) {
			console.error("could not open " + this.path, err);
		} finally {
			this.opening = false;
		}
	}

	remove() {
		this.element.remove();
	}

	appendToSidebar() {
		globals.sidebar.appendChild(this.element);
	}

	appendAfter(element: HTMLElement) {
		this.element.style.color = element.style.color;
		insertAfter(this.element, element);
	}
}
