import { test } from "node:test";
import assert from "node:assert/strict";
import { Envelope } from "../src/instruments/envelope";

const near = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} ${a} is not ${b}`);

test("envelope: rises over the attack, then holds the peak", () => {
    const e = new Envelope(10, 0.8, { attack: 0.1, decay: 0, sustain: 1 });
    near(e.level(9), 0);
    near(e.level(10), 0);
    near(e.level(10.05), 0.4);
    near(e.level(10.1), 0.8);
    near(e.level(500), 0.8);
});

test("envelope: the attack is never shorter than a millisecond", () => {
    const e = new Envelope(0, 1, { attack: 0, decay: 0, sustain: 1 });
    near(e.level(0.0005), 0.5);
    near(e.level(0.001), 1);
});

test("envelope: decay falls to the sustain level and stays", () => {
    const e = new Envelope(0, 1, { attack: 0.01, decay: 0.2, sustain: 0.5 });
    near(e.level(0.01), 1);
    near(e.level(0.11), 0.75);
    near(e.level(0.21), 0.5);
    near(e.level(9), 0.5);
});

test("envelope: a sustain level with no decay time is reached by the attack", () => {
    const e = new Envelope(0, 1, { attack: 0.01, decay: 0, sustain: 0.4 });
    near(e.level(0.01), 0.4);
    near(e.level(1), 0.4);
});

test("envelope: release fades from the level the note has when it ends", () => {
    const e = new Envelope(0, 1, { attack: 0.01, decay: 0, sustain: 1 });
    e.release(1, 0.5);
    near(e.level(0.99), 1);
    near(e.level(1), 1);
    near(e.level(1.25), 0.5);
    near(e.level(1.5), 0);
    near(e.level(2), 0);
    assert.equal(e.endsAt, 1.5);
});

test("envelope: a note that ends during its attack or decay releases from where it is", () => {
    const e = new Envelope(0, 1, { attack: 1, decay: 0, sustain: 1 });
    e.release(0.25, 0.1); // the release cannot begin before the attack has finished: the note is held at least that long
    near(e.level(1), 1);
    const d = new Envelope(0, 1, { attack: 0.01, decay: 1, sustain: 0 });
    d.release(0.51, 0.5);
    near(d.level(0.51), 0.5);
    near(d.level(0.76), 0.25);
});

test("envelope: a cut fades from the level the sound has at that moment", () => {
    const e = new Envelope(0, 1, { attack: 0.5, decay: 0, sustain: 1 });
    e.cut(0.25, 0.1); // in the middle of the attack
    near(e.level(0.25), 0.5);
    near(e.level(0.3), 0.25);
    near(e.level(0.35), 0);
    near(e.level(2), 0);
    assert.ok(Math.abs((e.endsAt as number) - 0.35) < 1e-9);
});

test("envelope: a cut during a release, and the earlier cut wins", () => {
    const e = new Envelope(0, 1, { attack: 0.01, decay: 0, sustain: 1 });
    e.release(1, 1);
    e.cut(1.5, 0.1);
    near(e.level(1.5), 0.5);
    near(e.level(1.55), 0.25);
    e.cut(1.8, 0.1); // later than the first cut: nothing changes
    near(e.level(1.55), 0.25);
    e.cut(1.2, 0.1); // earlier: it replaces it
    near(e.level(1.2), 0.8);
    near(e.level(1.25), 0.4);
});

test("envelope: the corner points follow the level (straight lines between them)", () => {
    const e = new Envelope(2, 1, { attack: 0.1, decay: 0.4, sustain: 0.5 });
    e.release(5, 0.5);
    const pts = e.points();
    assert.deepEqual(pts.map((p) => p[0]), [2, 2.1, 2.5, 5, 5.5]);
    // a line through the corners gives the level everywhere
    for (let t = 1.9; t < 6; t += 0.037) {
        let value = 0;
        if (t >= pts[0][0] && t <= pts[pts.length - 1][0]) {
            for (let i = 1; i < pts.length; i++) {
                if (t <= pts[i][0]) {
                    const [t0, v0] = pts[i - 1], [t1, v1] = pts[i];
                    value = v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
                    break;
                }
            }
        }
        near(value, e.level(t), "at " + t);
    }
    // a note cut during its attack stops climbing at the cut
    const c = new Envelope(0, 1, { attack: 1, decay: 0, sustain: 1 });
    c.cut(0.5, 0.1);
    assert.deepEqual(c.points().map((p) => [p[0], Math.round(p[1] * 1000) / 1000]), [[0, 0], [0.5, 0.5], [0.6, 0]]);
});
