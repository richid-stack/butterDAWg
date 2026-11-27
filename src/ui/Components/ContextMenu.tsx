import { globals, React } from "../../globals";

export const CONTEXT_MENU_SPACER = "[spacer]";

export class ContextMenu {

    element: HTMLElement;
    id: number;
    items: Array<string>;
    raw_items: Array<string>;
    parent_buffer: ContextMenu;
    /** remove the menu from the page as soon as it closes (menus built for a single right-click) */
    disposeOnClose = false;
    private onDocumentClick: (e: MouseEvent) => void;

    constructor(items: Array<string>, listeners: Array<Function>) {
        this.element = null;
        this.id = Math.round(Date.now() * Math.random());

        // items is a list of strings representing the items of the context menu
        // a string called "[spacer]" will act as a spacer
        this.items = items.filter(value => {return value!==CONTEXT_MENU_SPACER;});
        this.raw_items = items;

        // this will be set to the parent context menu to also toggle
        // it if this context menu gets toggled
        this.parent_buffer = null;

        this.createElement();
        this.addToDocument();
        this.addEventListeners(listeners);
    }

    createElement() {
        /*this.element = <div></div> as any;
        this.raw_items.forEach(item => {
            if (item !== CONTEXT_MENU_SPACER) {
                this.element.appendChild(<div className="context_item">{item}</div> as any);
            } else {
                this.element.appendChild(<div className="context_spacer"></div> as any);
            }
        });
        this.element.id = this.id.toString();*/
        let b = document.createElement("div");
        b.classList.add("context_menu");
        b.id = this.id.toString();
        // the items are text (a channel's name can come from a project file), never markup
        this.raw_items.forEach(item => {
            const row = document.createElement("div");
            if (item !== "[spacer]") {
                row.className = "context_item";
                row.textContent = item;
            } else {
                row.className = "context_spacer";
            }
            b.appendChild(row);
        });
        this.element = b;
    }

    addToDocument() {
        let temp_this = this;
        document.body.appendChild(this.element);
        this.onDocumentClick = (e: MouseEvent) => {
            if (temp_this.element.style.display==="block" && (e.target as HTMLElement).offsetParent !== this.element &&
                !(e.target as HTMLElement).parentElement?.classList.contains("context_menu")) {
                temp_this.toggle();
            }
        };
        document.addEventListener("click", this.onDocumentClick);
    }

    /** takes the menu out of the page for good */
    destroy() {
        document.removeEventListener("click", this.onDocumentClick);
        this.element.remove();
        const at = globals.context_menus.indexOf(this);
        if (at !== -1) globals.context_menus.splice(at, 1);
    }

    toggle(e?: MouseEvent) {
        // e is the event that triggered the context menu popup
        // it will provide the location the menu should be displayed
        if (this.element.style.display === "block" || e === undefined) {
            this.element.style.display = "none";
            if (this.disposeOnClose) this.destroy();
        } else {
            // if this is a submenu, aka the clicked element is a context_item, spawn
            // the context menu offset by the parents position on the screen. Else just
            // spawn it at the mouse cursor
            if ((e.target as HTMLElement).classList.contains("context_item")) {
                this.element.style.top = (e.target as HTMLElement).offsetTop + ((e.target as HTMLElement).offsetParent as HTMLElement).offsetTop + "px";
                this.element.style.left = (e.target as HTMLElement).offsetLeft + ((e.target as HTMLElement).offsetParent as HTMLElement).offsetLeft + (e.target as HTMLElement).offsetParent.clientWidth+ "px";
            } else {
                this.element.style.top = e.clientY + "px";
                this.element.style.left = e.clientX + "px";
            }
            this.element.style.display = "block";
            if (!globals.context_menus.includes(this)) globals.context_menus.push(this);
        }
    }

    addEventListeners(listeners: Array<Function>) {
        // listeners should return true, if the context menu window should be closed after clicking
        for (let i = 0, j = 0; i < this.raw_items.length; i++, j+=this.raw_items[i]==="[spacer]"?0:1) {
            if (this.raw_items[i] === "[spacer]" || listeners[j] === null) {continue;}

            let item = this.element.querySelector(".context_item:nth-child(" + (i+1) + ")");
            item.addEventListener("click", (e) => {
                if (listeners[j](e)) {
                    // (a copy: menus that dispose themselves leave the list while it is walked)
                    [...globals.context_menus].forEach(element => {
                        element.toggle();
                    });
                }
            });
        }
    }
}