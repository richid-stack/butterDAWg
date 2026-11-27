// Edits a piece of text where it is: the text is swapped for an input, Enter or
// clicking away keeps the new text, Escape puts the old text back.

export function editText(target: HTMLElement, current: string, onCommit: (text: string) => void): void {
    if (target.querySelector("input.inline_edit")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "inline_edit";
    input.value = current;
    input.maxLength = 64;
    const previous = target.textContent;
    target.textContent = "";
    target.appendChild(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (keep: boolean) => {
        if (done) return;
        done = true;
        const text = input.value.trim();
        input.remove();
        target.textContent = previous;
        if (keep && text !== "" && text !== current) onCommit(text);
    };
    input.addEventListener("keydown", (e) => {
        e.stopPropagation(); // typing is not a shortcut
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    // double clicks and drags inside the input must not reach whatever is under it
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("dblclick", (e) => e.stopPropagation());
}
