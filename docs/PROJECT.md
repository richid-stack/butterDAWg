# Projects

How a beat is saved, reopened and undone. The code is in `src/project/` (the model, history,
files) with the file access in `projects-main.js` (main process) and the menus in `src/ui/Menus.ts`.

## A project is a folder

```
My Beat/
  project.json        the project (schema below)
  project.json.bak    the version before the last save
  assets/             audio files the project owns (after "Save as" or "Collect and save")
```

The folder can be moved, zipped or synced. Nothing in `project.json` is an absolute path to the
user's computer, except for files that live somewhere else on purpose (see *Assets*).

## The file

`src/project/schema.ts` is the definition. In short:

| Field | What it holds |
| --- | --- |
| `format`, `version`, `appVersion`, `savedAt`, `name` | what the file is, which schema, who saved it |
| `tempo.points`, `loop` | tempo steps (in beats) and the loop region |
| `assets[]` | every audio file the clips use: id, location, path, name, `sha256`, `source`, `licence`, `credit` |
| `tracks[]` | title, colour, enabled (not muted), `route` (master, a channel, or nowhere), `clips[]` (asset id, start beat, name) |
| `mixer` | master and channels: name, volume, panning, active, and the 10 plugin slots (path, bypassed, parameter values) |
| `view.xsnap` | the horizontal zoom (optional) |

Opening a file goes through `parseProject`: it must be valid JSON, carry the project marker, not be newer
than the app, be migrated to the current version, and then pass `validateProject`, which checks every
value and names the first wrong one (`mixer.channels[0].volume: must be a number`). A file that fails is
refused with that message and the open project is left alone. Asset paths that leave the project folder
(`..`, absolute paths in a project location) are refused.

### Versions

- Adding an optional field needs no new version.
- Anything else is a new version: raise `CURRENT_VERSION` and add a migration to `MIGRATIONS` in
  `schema.ts` that turns the old JSON into the new JSON. Old files must keep opening.
- A project saved by a newer app is refused with a message that says so, never opened half-understood.

There is only version 1 so far, so `MIGRATIONS` is empty. The tests run a migration chain with test
migrations, so the mechanism is covered before the first real one is needed.

## Assets, source and licence

An asset's `location` says how to find the file again:

- `project`: inside this project's `assets/` folder. Follows the folder when it is moved.
- `app`: in the app's own library (`files/…`), by a path relative to the app folder, so it survives
  an update or a different install folder.
- `external`: anywhere else on the computer, as an absolute path. Saving keeps it as it is;
  **Collect and save** copies it into `assets/` and rewrites the record. If an external file is gone on
  reopening, the project still opens, the clip is kept, and the missing file is named in a message.

Every asset records where it came from (`source`: library, imported, generated, chopped from another
asset with its time range) and its `licence` (a short text, or `null` when it is not known). Files in the
app's library get theirs from `files/licences.json`: one entry per folder, the longest matching path wins.
A file with no entry is recorded as an *unknown* licence, never guessed. For an imported file only its
name is stored, so a project does not carry the user's folder names around. Collecting records the
`sha256` of the copy; a different file with the same name gets `name-2.ext`, an identical one is reused.

The starter samples in `files/samples/` are recorded with an unknown licence for now. They have to be
replaced or documented before anything ships (see BUILD_ORDER, open items).

## Editing and undo

The live project is the set of objects the engine already plays (`globals.mixer`, `globals.playlist`,
the transport). `capture()` reads them into a `ProjectData`; `restore()` builds new ones from a
`ProjectData` and swaps them in (the old ones are disposed 250 ms later so a sounding tail is not cut).
capture of a restored project is the same data again, which is what the tests compare.

Every edit the user can make goes through `src/project/edit.ts`, in two forms:

- **an action** (mute, rename, add a plugin, route a track): `history.execute({label, redo, undo})`
- **a gesture** (a fader drag, a clip drag, a plugin knob): `gesture(label, read, apply)` remembers the
  value at the start and compares at the end, so one drag is one undo step, and a drag that ends where
  it began adds nothing.

Commands hold the live objects they changed (the same clip, the same plugin instance), so undoing a
deletion brings back that very clip. For that reason the history is cleared when a project is opened or
created. The Edit menu names the next undo and redo ("Undo Change volume"). Shortcuts: Ctrl/Cmd+Z,
Ctrl/Cmd+Shift+Z or Ctrl+Y, and not while a text box has focus.

Edits that are covered: add, move (along and across tracks) and delete clips, mute, solo, rename and
colour a track, route a track, volume, panning, mute and rename a channel, add, remove and bypass a
plugin, change a plugin's settings, change the tempo.

## Plugin windows

A plugin's `host.js` builds its controls. If it returns `{ refresh() }`, the app calls that after every
undo, redo or other history change, so the controls show what is sounding. (`Gain` and `SimpleDistortion`
do this.)

## File menu

New project, Open…, Open recent, Save, Save as…, Collect and save (Ctrl/Cmd+N, O, S, Shift+S).
Anything that would drop unsaved work asks first: *Save*, *Don't save*, *Cancel* (New, Open, and closing
the window).

### Saving, exactly

- The text that is written and the history revision it was made at are taken in one step. An edit made
  while the file is being written is not in the file, and the project stays unsaved. (Close, New and Open
  treat that as "not saved" and ask again.)
- Save As that fails (disk full, a folder that cannot be written) leaves the project as it was: the same
  name, the same folder, the clips still pointing at the files they had.
- Collect and save keeps each file's source, licence and credit, including library files in a project
  that was never saved. Two files with the same bytes and name but a different source or licence are
  stored as two files (`kick.wav`, `kick-2.wav`), so the records stay apart.
- A clip whose file cannot be found because its project folder is gone (recovered work) is kept with its
  record and saved again with it.

## Autosave and recovery

Every 30 seconds, if the project has changed since the last autosave, the whole project is written to
`userData/recovery/recovery.json`. It is removed by a successful save, by New/Open, by Discard, and by a
normal exit. If the app finds it on start, the process did not exit normally, and the app offers
**Recover** or **Discard**. Recovered work comes back as unsaved.

A recovery file the session wrote is removed again when the work is undone back to what is saved (it
would bring back what was undone), and one that was found at start is left alone until the user chooses.
A window whose page crashed keeps its recovery file: that is the case it is for.

Autosave never touches `project.json`; only Save does, and Save keeps the previous file as
`project.json.bak` and writes through a temporary file and a rename, so a crash cannot leave half a file.

## What the page may touch

The renderer is sandboxed and has no Node access. File access is the main process's decision
(`main.js`, `projects-main.js`), and it does not trust a path from the page:

- The page can only read or write in a folder the user chose in a dialog (or a project from the recent
  list, or the folder named in the recovery file, both of which this process wrote).
- Reads are limited to the app's `files/` and `plugins/` and the `assets/` folder of each project that was
  opened or saved. `project.json` is not readable by the page; it only gets its text from Open. There is
  no way yet for the user to add a library folder of their own (user libraries come in Phase 4), so
  today a project can only play files from the app's library or its own `assets/`. The `external` location
  is in the format for that day; the tests stand in for it with `BDP_GRANT_READ`.
- Writes are limited to `project.json` and `assets/` of a chosen folder. File names are cleaned, so
  `../../x` cannot leave `assets/`.
- Names that came from a project file (track and channel titles, plugin names) are shown as text, never
  as HTML.

## Tests

| Command | What it covers |
| --- | --- |
| `npm test` | schema validation and migrations, history, asset paths and licences, the main-process store |
| `npm run test:project` | the real app: every edit in the list above is checked for *changes the project*, *one undo step*, *undo restores the exact state*, *redo restores it again*. Save → close → reopen is compared value by value and by a bit-for-bit offline render. Also collect and save, a moved folder with the originals deleted, missing files and plugins, damaged and hostile files, markup in names, the page's file-access limits, the unsaved-changes prompts, autosave and a hard kill followed by recovery. `-- --shots` writes `docs/progress/phase3-*.png` |

The test hooks only exist when the app is started with `BDP_TEST=1`: `BDP_USER_DATA` (a scratch settings
folder), `BDP_GRANT_READ` (extra readable folders), `globalThis.__bdpTestDialogs` (answers for the file
dialogs) and `window.__bdp`. A normal start has none of them.

## Known limits

- The macOS menu bar accelerators (Cmd+Z and so on) go through the same handler as Ctrl on Linux but have
  not been run on a Mac yet.
- The track colour is tested through the command, not by clicking in the colour picker.
- An external file that the app is not allowed to read is kept in the project and reported as missing;
  there is no relink dialog yet.
- Paths are compared case-sensitively, so on Windows the same file written with different capitals counts
  as two.
- The default new project leaves tracks 1 to 14 unrouted (silent), as before; track 0 plays into channel 0.
- Plugins are saved by their parameter values only. A plugin with internal state (a delay's buffer, a
  sampler's zones) needs the `.bdp` state API from Phase 5 and 7.
- The mixer's master strip is still the old static drawing: the master channel is saved and restored but
  edited in Phase 4.
