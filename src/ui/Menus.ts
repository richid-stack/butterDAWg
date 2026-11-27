// The FILE and EDIT menus in the header, and the keyboard shortcuts that go with
// them. Menus are built when they are opened, so they always show what is true
// now: whether there is anything to undo, and the recent projects.

import { projects } from "../platform/projects";
import * as edit from "../project/edit";
import { session } from "../project/session";

interface MenuItem {
    label?: string;
    shortcut?: string;
    disabled?: boolean;
    action?: () => void;
    sub?: MenuItem[];
    separator?: boolean;
}

const mac = navigator.platform.toLowerCase().includes("mac");
const MOD = mac ? "Cmd+" : "Ctrl+";

async function fileItems(): Promise<MenuItem[]> {
    let recent: Awaited<ReturnType<typeof projects.recent>> = [];
    try {
        recent = await projects.recent();
    } catch (err) {
        console.error("could not read the recent projects", err);
    }
    return [
        { label: "New project", shortcut: MOD + "N", action: () => void session.newProject() },
        { label: "Open…", shortcut: MOD + "O", action: () => void session.openProject() },
        {
            label: "Open recent",
            sub: recent.length
                ? recent.slice(0, 10).map((r) => ({ label: r.name, action: () => void session.openRecent(r.dir) }))
                : [{ label: "(none yet)", disabled: true }],
        },
        { separator: true },
        { label: "Save", shortcut: MOD + "S", action: () => void session.save() },
        { label: "Save as…", shortcut: MOD + "Shift+S", action: () => void session.saveAs() },
        { label: "Collect and save", action: () => void session.collectAndSave() },
    ];
}

async function editItems(): Promise<MenuItem[]> {
    const h = session.history;
    return [
        { label: h.canUndo() ? "Undo " + h.undoLabel() : "Undo", shortcut: MOD + "Z", disabled: !h.canUndo(), action: () => void edit.undo() },
        { label: h.canRedo() ? "Redo " + h.redoLabel() : "Redo", shortcut: MOD + "Shift+Z", disabled: !h.canRedo(), action: () => void edit.redo() },
    ];
}

function buildItems(items: MenuItem[], close: () => void): HTMLElement[] {
    return items.map((item) => {
        const row = document.createElement("div");
        if (item.separator) {
            row.className = "context_spacer";
            return row;
        }
        row.className = "context_item" + (item.disabled ? " disabled" : "") + (item.sub ? " has_sub" : "");
        const label = document.createElement("span");
        label.textContent = item.label ?? "";
        row.append(label);
        if (item.shortcut) {
            const hint = document.createElement("span");
            hint.className = "shortcut";
            hint.textContent = item.shortcut;
            row.append(hint);
        }
        if (item.sub) {
            const sub = document.createElement("div");
            sub.className = "menu_sub";
            sub.append(...buildItems(item.sub, close));
            row.append(sub);
        } else if (item.action && !item.disabled) {
            row.addEventListener("click", (e) => {
                e.stopPropagation();
                close();
                item.action!();
            });
        }
        return row;
    });
}

function attach(headerId: string, items: () => Promise<MenuItem[]>): void {
    const header = document.getElementById(headerId)!;
    let open: HTMLElement | null = null;
    const close = () => {
        open?.remove();
        open = null;
        header.classList.remove("menu_open");
        document.removeEventListener("mousedown", onOutside, true);
        document.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: MouseEvent) => {
        if (open && !open.contains(e.target as Node) && !header.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") close();
    };
    header.addEventListener("click", async () => {
        if (open) return close();
        const menu = document.createElement("div");
        menu.className = "context_menu menu_dropdown";
        menu.id = headerId + "_dropdown";
        menu.append(...buildItems(await items(), close));
        const box = header.getBoundingClientRect();
        menu.style.left = box.left + "px";
        menu.style.top = box.bottom + "px";
        document.body.append(menu);
        open = menu;
        header.classList.add("menu_open");
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKey, true);
    });
}

function isTyping(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

export function installMenus(): void {
    attach("header_menu_file", fileItems);
    attach("header_menu_edit", editItems);

    document.addEventListener("keydown", (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const key = e.key.toLowerCase();
        // in a text box, Ctrl+Z belongs to the text box
        if ((key === "z" || key === "y") && isTyping(e.target)) return;
        let handled = true;
        if (key === "z" && !e.shiftKey) edit.undo();
        else if ((key === "z" && e.shiftKey) || key === "y") edit.redo();
        else if (key === "s" && !e.shiftKey) void session.save();
        else if (key === "s" && e.shiftKey) void session.saveAs();
        else if (key === "o") void session.openProject();
        else if (key === "n") void session.newProject();
        else handled = false;
        if (handled) e.preventDefault();
    });
}
