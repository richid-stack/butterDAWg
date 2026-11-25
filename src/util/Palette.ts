import { globals } from "../globals";
import { files } from "../platform/files";
import { Item } from "../PaletteItem";

// palette functionality

export function loadPalette() {
	// event listener for dragging
	var drag_container = document.getElementById("drag_container");
	document.addEventListener("mousemove", (e) => {
		if (globals.current_drag_element === null) { return; }
		if (!drag_container.hasChildNodes()) {
			var clone = (<Item>globals.current_drag_element).getDragElement().cloneNode(true);
			drag_container.appendChild(clone);
			drag_container.style.display = "block";
		}
		drag_container.style.left = (e.clientX - drag_container.clientWidth / 2) + "px";
		drag_container.style.top = e.clientY + "px";

		// angle container for visual appeal
		drag_container.style.transform = "rotateZ(" + e.movementX + "deg)";
	});

	// the top level of the sidebar is the app's own "files" folder; folders
	// below it are listed when they are opened
	const root = files.root + "/files";
	files.list(root).then(
		(entries) => {
			for (const entry of entries) {
				if (entry.name[0] === ".") { continue; }
				new Item(entry.name, root + "/" + entry.name, entry.isDirectory).appendToSidebar();
			}
		},
		(err) => console.error("couldn't read the palette folder", err),
	);
}
