// A small modal dialog in the app's own style: a title, a message and buttons.
// Used for "save changes?", the crash-recovery question and error messages.
// Resolves with the index of the button that was pressed.

export interface DialogButton {
    label: string;
    /** the button Enter presses */
    primary?: boolean;
    /** the button Escape presses (and clicking outside the dialog) */
    cancel?: boolean;
}

export interface DialogOptions {
    title: string;
    message: string;
    /** more lines under the message (a list of missing files, for example) */
    details?: string[];
    buttons: DialogButton[];
}

export function showDialog(options: DialogOptions): Promise<number> {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "dialog_overlay";
        const box = document.createElement("div");
        box.className = "dialog_box";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");

        const title = document.createElement("div");
        title.className = "dialog_title";
        title.textContent = options.title;
        const message = document.createElement("div");
        message.className = "dialog_message";
        message.textContent = options.message;
        box.append(title, message);

        if (options.details && options.details.length > 0) {
            const list = document.createElement("div");
            list.className = "dialog_details";
            const shown = options.details.slice(0, 12);
            list.textContent = shown.join("\n") + (options.details.length > shown.length ? "\n…and " + (options.details.length - shown.length) + " more" : "");
            box.append(list);
        }

        const row = document.createElement("div");
        row.className = "dialog_buttons";
        const finish = (index: number) => {
            document.removeEventListener("keydown", onKey, true);
            overlay.remove();
            resolve(index);
        };
        const cancelIndex = options.buttons.findIndex((b) => b.cancel);
        const primaryIndex = options.buttons.findIndex((b) => b.primary);
        options.buttons.forEach((b, i) => {
            const button = document.createElement("button");
            button.className = "dialog_button" + (b.primary ? " dialog_button_primary" : "");
            button.textContent = b.label;
            button.addEventListener("click", () => finish(i));
            row.append(button);
        });
        box.append(row);
        overlay.append(box);

        // keys belong to the dialog while it is open
        const onKey = (e: KeyboardEvent) => {
            e.stopPropagation();
            if (e.key === "Escape" && cancelIndex !== -1) {
                e.preventDefault();
                finish(cancelIndex);
            } else if (e.key === "Enter" && primaryIndex !== -1) {
                e.preventDefault();
                finish(primaryIndex);
            }
        };
        document.addEventListener("keydown", onKey, true);

        document.body.append(overlay);
        (row.children[primaryIndex !== -1 ? primaryIndex : 0] as HTMLElement | undefined)?.focus();
    });
}
