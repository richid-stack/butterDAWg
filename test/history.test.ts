import { test } from "node:test";
import assert from "node:assert/strict";
import { Command, History } from "../src/project/History";

// a tiny "project": one number, and commands that change it
function setup(coalesceMs = 600) {
    let time = 1000;
    const state = { value: 0, log: [] as string[] };
    const history = new History({ coalesceMs, now: () => time });
    const set = (to: number, label = "set", coalesce?: string): Command => {
        const from = state.value;
        return {
            label,
            coalesce,
            undo: () => { state.value = from; state.log.push("undo " + label); },
            redo: () => { state.value = to; state.log.push("redo " + label); },
        };
    };
    return { state, history, set, wait: (ms: number) => (time += ms) };
}

test("history: execute, undo and redo", () => {
    const { state, history, set } = setup();
    history.execute(set(5, "a"));
    history.execute(set(9, "b"));
    assert.equal(state.value, 9);
    assert.deepEqual(history.labels(), ["a", "b"]);
    assert.equal(history.undoLabel(), "b");
    assert.ok(history.undo());
    assert.equal(state.value, 5);
    assert.equal(history.redoLabel(), "b");
    assert.ok(history.undo());
    assert.equal(state.value, 0);
    assert.ok(!history.undo(), "nothing left to undo");
    assert.ok(history.redo());
    assert.ok(history.redo());
    assert.equal(state.value, 9);
    assert.ok(!history.redo(), "nothing left to redo");
});

test("history: a new edit after an undo drops the redo list", () => {
    const { state, history, set } = setup();
    history.execute(set(1, "a"));
    history.execute(set(2, "b"));
    history.undo();
    history.execute(set(7, "c"));
    assert.ok(!history.canRedo());
    assert.deepEqual(history.labels(), ["a", "c"]);
    history.undo();
    history.undo();
    assert.equal(state.value, 0);
});

test("history: record keeps a change that was already made without running it again", () => {
    const { state, history } = setup();
    state.value = 4; // done by a drag
    history.record({ label: "drag", undo: () => (state.value = 0), redo: () => (state.value = 4) });
    assert.deepEqual(state.log, []);
    history.undo();
    assert.equal(state.value, 0);
    history.redo();
    assert.equal(state.value, 4);
});

test("history: edits with the same key close together become one step", () => {
    const { state, history, set, wait } = setup();
    history.execute(set(1, "volume", "vol"));
    wait(100);
    history.execute(set(2, "volume", "vol"));
    wait(100);
    history.execute(set(3, "volume", "vol"));
    assert.equal(history.labels().length, 1);
    history.undo();
    assert.equal(state.value, 0, "one undo goes back to before the first change");
    history.redo();
    assert.equal(state.value, 3, "and redo goes to the last one");
});

test("history: a pause, a different key, or an undo in between keeps steps apart", () => {
    const { history, set, wait } = setup(600);
    history.execute(set(1, "volume", "vol"));
    wait(700);
    history.execute(set(2, "volume", "vol"));
    assert.equal(history.labels().length, 2, "too long a pause");
    wait(10);
    history.execute(set(3, "pan", "pan"));
    assert.equal(history.labels().length, 3, "a different control");
    wait(10);
    history.undo();
    wait(10);
    history.execute(set(4, "pan", "pan"));
    assert.equal(history.labels().length, 3, "after an undo the new edit is its own step");
});

test("history: dirty follows the saved state, also through undo and redo", () => {
    const { history, set } = setup();
    assert.ok(!history.isDirty());
    history.execute(set(1, "a"));
    assert.ok(history.isDirty());
    history.markSaved();
    assert.ok(!history.isDirty());
    history.execute(set(2, "b"));
    assert.ok(history.isDirty());
    history.undo();
    assert.ok(!history.isDirty(), "back at the saved state");
    history.undo();
    assert.ok(history.isDirty());
    history.redo();
    assert.ok(!history.isDirty());
    // the saved state is gone once a different edit replaces it
    history.undo();
    history.execute(set(9, "c"));
    history.redo;
    history.undo();
    assert.ok(history.isDirty(), "the saved state cannot be reached any more");
    history.markDirty();
    history.markSaved();
    assert.ok(!history.isDirty());
});

test("history: a saved step is never merged into", () => {
    const { history, set, wait } = setup();
    history.execute(set(1, "volume", "vol"));
    history.markSaved();
    wait(10);
    history.execute(set(2, "volume", "vol"));
    assert.equal(history.labels().length, 2);
    history.undo();
    assert.ok(!history.isDirty());
});

test("history: the limit drops the oldest steps and keeps the dirty state right", () => {
    let time = 0;
    const history = new History({ limit: 3, now: () => (time += 1000) });
    const state = { v: 0 };
    const set = (to: number): Command => { const from = state.v; return { label: "s" + to, undo: () => (state.v = from), redo: () => (state.v = to) }; };
    for (let i = 1; i <= 5; i++) history.execute(set(i));
    assert.deepEqual(history.labels(), ["s3", "s4", "s5"]);
    history.markSaved();
    history.execute(set(6));
    assert.deepEqual(history.labels(), ["s4", "s5", "s6"]);
    history.undo();
    assert.ok(!history.isDirty());
});

test("history: clear forgets everything and starts clean", () => {
    const { history, set } = setup();
    history.execute(set(1));
    history.markDirty();
    history.clear();
    assert.ok(!history.canUndo() && !history.canRedo() && !history.isDirty());
});

test("history: a command cannot edit the history while it runs", () => {
    const { history } = setup();
    history.execute({ label: "x", undo: () => {}, redo: () => {} });
    const bad: Command = { label: "bad", undo: () => {}, redo: () => history.undo() };
    assert.throws(() => history.execute(bad), /cannot be changed/);
    assert.equal(history.canUndo(), true);
});

test("history: listeners hear about every change", () => {
    const { history, set } = setup();
    let n = 0;
    const off = history.onChange(() => n++);
    history.execute(set(1));
    history.undo();
    history.redo();
    history.markSaved();
    assert.equal(n, 4);
    off();
    history.execute(set(2));
    assert.equal(n, 4);
});
