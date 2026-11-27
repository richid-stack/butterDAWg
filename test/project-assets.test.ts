import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AssetBook,
    baseName,
    classify,
    defaultMeta,
    libraryMeta,
    normalizePath,
    parseLicenceManifest,
    safeAssetName,
    toAbsolute,
} from "../src/project/assets";

const roots = { appRoot: "/opt/butterDAWg", projectDir: "/home/me/Beats/Night Drive" };

test("paths: one slash style, no trailing slash", () => {
    assert.equal(normalizePath("C:\\Users\\me\\Beats\\"), "C:/Users/me/Beats");
    assert.equal(normalizePath("/a/b//"), "/a/b");
    assert.equal(normalizePath("/"), "/");
    assert.equal(baseName("/a/b/kick.wav"), "kick.wav");
    assert.equal(baseName("C:\\a\\snare.wav"), "snare.wav");
});

test("classify: project assets, app library and everything else", () => {
    assert.deepEqual(classify("/home/me/Beats/Night Drive/assets/kick.wav", roots), { location: "project", path: "assets/kick.wav" });
    assert.deepEqual(classify("/opt/butterDAWg/files/samples/kick.wav", roots), { location: "app", path: "files/samples/kick.wav" });
    assert.deepEqual(classify("/home/me/Downloads/vox.wav", roots), { location: "external", path: "/home/me/Downloads/vox.wav" });
});

test("classify: only the assets folder counts as the project's own", () => {
    // project.json's neighbours are not assets
    assert.equal(classify("/home/me/Beats/Night Drive/notes/x.wav", roots).location, "external");
    // a folder that merely starts with the same letters is not inside
    assert.equal(classify("/opt/butterDAWg-old/files/x.wav", roots).location, "external");
    assert.equal(classify("/home/me/Beats/Night Drive 2/assets/x.wav", roots).location, "external");
});

test("classify: before the project has a folder, nothing is a project asset", () => {
    const unsaved = { appRoot: roots.appRoot, projectDir: null };
    assert.equal(classify("/home/me/Beats/Night Drive/assets/kick.wav", unsaved).location, "external");
    assert.equal(classify("/opt/butterDAWg/files/a.wav", unsaved).location, "app");
});

test("classify: Windows paths", () => {
    const win = { appRoot: "C:\\Program Files\\butterDAWg", projectDir: "D:\\Beats\\Night Drive" };
    assert.deepEqual(classify("D:\\Beats\\Night Drive\\assets\\kick.wav", win), { location: "project", path: "assets/kick.wav" });
    assert.deepEqual(classify("C:\\Program Files\\butterDAWg\\files\\x.wav", win), { location: "app", path: "files/x.wav" });
});

test("toAbsolute: the inverse of classify, and it follows a moved project folder", () => {
    for (const file of ["/home/me/Beats/Night Drive/assets/kick.wav", "/opt/butterDAWg/files/samples/kick.wav", "/home/me/Downloads/vox.wav"]) {
        const { location, path } = classify(file, roots);
        assert.equal(toAbsolute({ location, path }, roots), file);
    }
    const moved = { appRoot: "/opt/butterDAWg", projectDir: "/mnt/usb/Night Drive" };
    assert.equal(toAbsolute({ location: "project", path: "assets/kick.wav" }, moved), "/mnt/usb/Night Drive/assets/kick.wav");
    // the app can be installed somewhere else too
    assert.equal(toAbsolute({ location: "app", path: "files/a.wav" }, { appRoot: "/Applications/butterDAWg", projectDir: null }), "/Applications/butterDAWg/files/a.wav");
});

test("toAbsolute: a project asset has no place until the project has a folder", () => {
    assert.equal(toAbsolute({ location: "project", path: "assets/kick.wav" }, { appRoot: "/x", projectDir: null }), null);
});

test("AssetBook: remembers by path, however the slashes are written", () => {
    const book = new AssetBook();
    book.remember("C:\\a\\b.wav", { source: { kind: "imported", from: "b.wav" }, licence: "CC0" });
    assert.equal(book.get("C:/a/b.wav")?.licence, "CC0");
    assert.equal(book.get("C:/a/other.wav"), undefined);
});

test("AssetBook: remember copies what it is given", () => {
    const book = new AssetBook();
    const meta = { source: { kind: "generated" as const }, licence: null };
    book.remember("/a.wav", meta);
    meta.licence = "changed" as any;
    assert.equal(book.get("/a.wav")?.licence, null);
});

test("AssetBook: moved carries source and licence to the copy and adds the hash", () => {
    const book = new AssetBook();
    book.remember("/ext/kick.wav", { source: { kind: "imported", from: "kick.wav" }, licence: "Royalty free", credit: "Someone" });
    book.moved("/ext/kick.wav", "/proj/assets/kick.wav", { sha256: "abc" });
    assert.deepEqual(book.get("/proj/assets/kick.wav"), { source: { kind: "imported", from: "kick.wav" }, licence: "Royalty free", credit: "Someone", sha256: "abc" });
    // nothing was known about this one: nothing is invented
    book.moved("/ext/unknown.wav", "/proj/assets/unknown.wav");
    assert.equal(book.get("/proj/assets/unknown.wav"), undefined);
    book.clear();
    assert.equal(book.get("/proj/assets/kick.wav"), undefined);
});

const manifest = parseLicenceManifest(JSON.stringify({
    format: "butterdawg-licences",
    entries: [
        { path: "samples", library: "Starter", licence: null, credit: "unknown author" },
        { path: "packs/808", library: "808 pack", licence: "CC0" },
        { path: "packs/808/special", library: "Special", licence: "Custom licence", credit: "Maker" },
    ],
}));

test("licences: the longest matching entry wins", () => {
    assert.deepEqual(libraryMeta("files/packs/808/kick.wav", manifest), { source: { kind: "library", library: "808 pack" }, licence: "CC0" });
    assert.deepEqual(libraryMeta("files/packs/808/special/rim.wav", manifest), {
        source: { kind: "library", library: "Special" }, licence: "Custom licence", credit: "Maker",
    });
});

test("licences: an entry names a folder, not a prefix of a name", () => {
    assert.equal(libraryMeta("files/samples-extra/a.wav", manifest).licence, null);
    assert.equal(libraryMeta("files/samples-extra/a.wav", manifest).source.kind, "library");
    assert.equal((libraryMeta("files/samples-extra/a.wav", manifest).source as any).library, undefined);
});

test("licences: a file with no entry is recorded as unknown, not guessed", () => {
    const meta = libraryMeta("files/mystery/a.wav", manifest);
    assert.equal(meta.licence, null);
    assert.equal(meta.credit, undefined);
    assert.equal(libraryMeta("files/a.wav", null).licence, null);
});

test("licences: a null licence is kept as null, with its note", () => {
    assert.deepEqual(libraryMeta("files/samples/kick.wav", manifest), {
        source: { kind: "library", library: "Starter" }, licence: null, credit: "unknown author",
    });
});

test("licences: the manifest is checked", () => {
    assert.throws(() => parseLicenceManifest("{}"), /entries/);
    assert.throws(() => parseLicenceManifest(JSON.stringify({ entries: [{ licence: "x" }] })), /path/);
    assert.throws(() => parseLicenceManifest(JSON.stringify({ entries: [{ path: "a" }] })), /licence/);
    assert.throws(() => parseLicenceManifest("not json"));
});

test("defaultMeta: library files use the manifest; other files record only their name", () => {
    assert.equal(defaultMeta("/opt/butterDAWg/files/samples/kick.wav", roots, manifest).source.kind, "library");
    const imported = defaultMeta("/home/me/secret folder/vox.wav", roots, manifest);
    assert.deepEqual(imported, { source: { kind: "imported", from: "vox.wav" }, licence: null });
    assert.ok(!JSON.stringify(imported).includes("secret folder"));
});

test("safeAssetName: nothing that can leave the assets folder", () => {
    assert.equal(safeAssetName("../../etc/passwd"), "__.._etc_passwd");
    assert.equal(safeAssetName("a\\b:c*d?.wav"), "a_b_c_d_.wav");
    assert.equal(safeAssetName("..hidden"), "_hidden");
    assert.equal(safeAssetName("   "), "file");
    assert.equal(safeAssetName("x".repeat(300)).length, 120);
});

test("AssetBook: moved uses what is known by default when nothing was remembered", () => {
    const book = new AssetBook();
    const byDefault = { source: { kind: "library" as const, library: "Starter samples" }, licence: null, credit: "unknown author" };
    book.moved("/app/files/samples/kick.wav", "/proj/assets/kick.wav", { sha256: "abc" }, byDefault);
    assert.deepEqual(book.get("/proj/assets/kick.wav"), { ...byDefault, sha256: "abc" });
    // what was remembered wins over the default
    book.remember("/ext/a.wav", { source: { kind: "imported", from: "a.wav" }, licence: "CC0" });
    book.moved("/ext/a.wav", "/proj/assets/a.wav", {}, byDefault);
    assert.equal(book.get("/proj/assets/a.wav")?.licence, "CC0");
});
