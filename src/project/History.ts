// Undo and redo.
//
// An edit is a Command: a label for the menu, and two functions that put the
// project in the state after the edit (`redo`) or before it (`undo`). The
// functions change the live project directly, so the history knows nothing
// about tracks or channels and is tested on its own.
//
// Two ways to add an edit:
//   history.execute(cmd)   run `redo()` now and keep the command
//   history.record(cmd)    the change has already been made (a drag that
//                          moved a clip while the mouse was down); only keep it
//
// Commands with the same `coalesce` key that follow each other within
// `coalesceMs` become one step, so turning a knob is one undo, not a hundred.

export interface Command {
    /** what the Edit menu says: "Undo move clip" */
    label: string;
    undo(): void;
    redo(): void;
    /** commands with the same key, made close together, merge into one step */
    coalesce?: string;
}

export interface HistoryOptions {
    /** how many steps to keep */
    limit?: number;
    /** how close in time two commands with the same key must be to merge */
    coalesceMs?: number;
    /** the clock, in milliseconds (replaceable in tests) */
    now?: () => number;
}

export class History {
    private done: Command[] = [];
    private undone: Command[] = [];
    private lastTime = 0;
    // the length of `done` when the project was last saved; -1 if that state can no longer be reached
    private savedAt = 0;
    private forcedDirty = false;
    private listeners = new Set<() => void>();
    private busy = false;
    private readonly limit: number;
    private readonly coalesceMs: number;
    private readonly now: () => number;

    constructor(options: HistoryOptions = {}) {
        this.limit = options.limit ?? 500;
        this.coalesceMs = options.coalesceMs ?? 600;
        this.now = options.now ?? (() => Date.now());
    }

    execute(command: Command): void {
        this.guard();
        this.run(() => command.redo());
        this.push(command);
    }

    record(command: Command): void {
        this.guard();
        this.push(command);
    }

    canUndo(): boolean {
        return this.done.length > 0;
    }

    canRedo(): boolean {
        return this.undone.length > 0;
    }

    undoLabel(): string | null {
        return this.done.length ? this.done[this.done.length - 1].label : null;
    }

    redoLabel(): string | null {
        return this.undone.length ? this.undone[this.undone.length - 1].label : null;
    }

    undo(): boolean {
        this.guard();
        const command = this.done.pop();
        if (!command) return false;
        this.run(() => command.undo());
        this.undone.push(command);
        this.lastTime = 0;
        this.changed();
        return true;
    }

    redo(): boolean {
        this.guard();
        const command = this.undone.pop();
        if (!command) return false;
        this.run(() => command.redo());
        this.done.push(command);
        this.lastTime = 0;
        this.changed();
        return true;
    }

    /** forget everything (a project was opened or started) */
    clear(): void {
        this.done = [];
        this.undone = [];
        this.savedAt = 0;
        this.forcedDirty = false;
        this.lastTime = 0;
        this.changed();
    }

    /** the project was saved: it is clean until something else is done */
    markSaved(): void {
        this.savedAt = this.done.length;
        this.forcedDirty = false;
        this.changed();
    }

    /** a change that cannot be undone was made, so the project differs from the saved one */
    markDirty(): void {
        this.forcedDirty = true;
        this.changed();
    }

    /** true when the project differs from what was last saved (undoing back to the saved state makes it clean again) */
    isDirty(): boolean {
        return this.forcedDirty || this.savedAt !== this.done.length;
    }

    /** the steps, oldest first (for tests and a history list) */
    labels(): string[] {
        return this.done.map((c) => c.label);
    }

    onChange(callback: () => void): () => void {
        this.listeners.add(callback);
        return () => this.listeners.delete(callback);
    }

    private push(command: Command): void {
        const t = this.now();
        const last = this.done[this.done.length - 1];
        const merges =
            last !== undefined &&
            command.coalesce !== undefined &&
            last.coalesce === command.coalesce &&
            t - this.lastTime <= this.coalesceMs &&
            // never merge into a step that was saved: it has to stay a step of its own
            this.savedAt !== this.done.length;
        if (merges) {
            // keep the first command's undo and take the newest redo
            this.done[this.done.length - 1] = { label: command.label, coalesce: command.coalesce, undo: last.undo, redo: command.redo };
        } else {
            if (this.savedAt > this.done.length) this.savedAt = -1; // the saved state was in the redo list that is being dropped
            this.done.push(command);
            if (this.done.length > this.limit) {
                this.done.shift();
                if (this.savedAt >= 0) this.savedAt--;
                if (this.savedAt < 0) this.savedAt = -1;
            }
        }
        this.undone = [];
        this.lastTime = t;
        this.changed();
    }

    // An undo or redo must not start another one, and a command must not edit the history.
    private guard(): void {
        if (this.busy) throw new Error("the history cannot be changed while an undo or redo runs");
    }

    private run(fn: () => void): void {
        this.busy = true;
        try {
            fn();
        } finally {
            this.busy = false;
        }
    }

    private changed(): void {
        this.listeners.forEach((cb) => cb());
    }
}
