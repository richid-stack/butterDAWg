# butterDAWg Pro — Build Order

Task-level plan for the eight phases in [BLUEPRINT.md](BLUEPRINT.md). Tick boxes as work lands.

## Rules for every phase

- Work in small commits. Each phase gets its own branch, merged when its *done when* gate passes.
- Use design tokens only (`styles/general.css`). Reuse the window frame in `styles/Window.css`.
- Run the app under a virtual display after each task and save a screenshot to `docs/progress/` named `<phase>-<what>.png`. The baseline is `00-baseline-electron20.png`.
- Every bundled sound or library gets a line in `LICENSES/sounds.md` (source link, licence, date checked) before it is committed.
- Day-to-day commands (all exist since phase 1):

```
npm install
npm run typecheck       # TypeScript, no output files
npm run build           # bundle the renderer into dist/
npm run start           # build, then launch Electron
npm run smoke           # drive the real app under a virtual display and check it
npm run shot -- name    # screenshot to docs/progress/name.png
```

- CI (`.github/workflows/ci.yml`) runs typecheck, build and the smoke test on every push to `main` and `phase-*` branches and on pull requests, and keeps the screenshot.
- The audio engine, DSP and project model must not import Electron or Node modules. Anything that needs the OS goes behind a service interface, as the preload bridge does, so the browser build stays possible.

## Phase 1: Foundation

Goal: a modern, secure, reproducible base with no visible change.

- [x] Upgrade `electron` to 45.x. Fix any API changes in `main.js`. *Deferred:* the `@electron-forge/*` packages stay on 7.x until packaging is tested in phase 8 (Forge 8 needs Node 22.13 or later).
- [x] `main.js`: set `contextIsolation: true`, `nodeIntegration: false` (sub-frames keep Electron's default, off), plus `sandbox: true`; add a content security policy.
- [x] `preload.js`: expose a small bridge (`readFile`, `readdir`, `exists`, `isDirectory`, limited to `files/` and `plugins/`) and replace direct `require("fs")` in `src/core/Source.ts`, `src/core/Plugin.ts`, `src/index.ts` and any other file that reads from disk.
- [x] Vendor Font Awesome and desvg into `vendor/`; remove the CDN tags in `index.html`. jQuery and Open Sans were removed instead, because nothing called jQuery and Open Sans was only a fallback font.
- [x] `package.json`: add TypeScript as a devDependency, prune the ~70 direct dependencies to what the code imports (keep `wavefile`, `uuid`, `electron-squirrel-startup`), set `"license": "MIT"` to match `LICENSE`.
- [x] `tsconfig.json`: remove `watch`, target ES2022; fix the three current type errors (`src/PaletteItem.ts:63`, `src/core/Source.ts:39`, `src/core/Channel.ts:22`).
- [x] Add a bundler script (esbuild, outputs `dist/renderer.js`); make `npm start` build then launch.
- [x] Add `npm run shot`: launch under Xvfb, wait, save a screenshot to `docs/progress/`.
- [x] Add a CI workflow (GitHub Actions) that runs install, typecheck, build and the smoke test (`npm run smoke`, which also drives plugins and sample drag-and-drop and checks that nothing leaves the machine).
- [x] Move repeated colours into tokens in `styles/general.css` per the blueprint table. No visual change (start-up screenshots byte-identical). *Left:* hex colours inside `.tsx` files (`Channel.tsx` style strings, `PlaylistWindow.tsx`) are not tokenised yet.
- [ ] Confirm whether threads for stem separation need a custom protocol instead of `file://` (see risks in the blueprint). Still open; decide it once for Electron and the browser build.

Done when: the app runs offline on Electron 45 with `contextIsolation` on, CI is green, and the new screenshot matches `00-baseline-electron20.png`.

Status: **done** on branch `phase-1-foundation`. Typecheck is clean, the smoke test passes 10 of 10 locally and on GitHub Actions, and the screenshots are `01-electron45-isolated.png` and `02-smoke-after-drop.png`. The two open boxes above carry into later phases.

## Phase 2: Engine core

Goal: timing and signal path you can trust.

- [x] New `src/engine/Transport.ts`: stopped, playing and paused states; position in beats and seconds; loop region; tempo map. Replaces the context suspend/resume logic that `Playlist.play()` and `Playlist.stop()` used.
- [x] New `src/engine/Scheduler.ts`: lookahead timer using `audioContext.currentTime`, scheduling clips and notes just ahead of the playhead. Replace the start-everything-at-once loop in `Track.play()`.
- [x] Replace millisecond time (`globals.current_time`) with beats; update `pixels_to_ms` and related helpers in `src/globals.ts`.
- [x] `src/globals.ts`: stop forcing `sampleRate: 44100`; follow the device rate.
- [x] Rework `src/core/Source.ts` and `src/core/Sample.ts`: decode with the browser decoder, use the real channel count and sample rate, remove the 2× rate hack, support WAV, MP3, FLAC and OGG, cache waveform peaks.
- [x] `src/core/Mixer.ts` and `src/core/Channel.ts`: route channels into the master channel, then the master into the speakers. Use `StereoPannerNode`. Map faders in dB. Add peak and RMS meters.
- [x] Rebuild the plugin chain from a list instead of disconnecting and reconnecting neighbours (`Channel.addPlugin`). Add a bypass flag.
- [x] Offline render path (`OfflineAudioContext`) that builds the same graph, plus a WAV writer for 16-bit, 24-bit and 32-bit float using `wavefile`.
- [x] Move the bridge's file reads from synchronous to asynchronous, behind a `FileService` interface that a browser shell can implement later.
- [x] Tests: scheduler timing maths, a render-versus-playback null test, and a stereo file test.

Done when: a five-minute loop plays without audible drift, the rendered WAV matches playback, and stereo files at any sample rate play correctly.

Phase 2 notes (what was built, and what was left on purpose):

- The engine is in `src/engine/` and described in `docs/ENGINE.md`. The Phase 2 gate is checked by `npm test` (unit tests with a fake clock, including a five-minute loop) and `npm run test:engine` (the real app: file decoding, stereo at any rate, render-versus-playback null test, real-time timing, WAV export). `npm run test:engine -- --long` plays a looping click for a real five minutes.
- A mono file is up-mixed to stereo at the same level in both channels (see `engine/nodes.ts`). Before this, a mono clip's level depended on whether a stereo clip was on the same track; the null test found it.
- The pan law is the Web Audio stereo law: centre is unchanged, and a hard-panned stereo file keeps its image. A selectable pan law (0, -3, -4.5, -6 dB) is a mixer setting for Phase 4.
- The master channel exists in the audio graph and is a normal channel, but the Mixer window's master strip is still the old static drawing. It is wired in Phase 4 with the mixer routing work.
- A track that is not routed to a channel is silent. The default project routes track 0 to channel 0 (as before); routing UI comes with the project model in Phase 3.
- Plugins are copied into the offline render by their parameter values only. Plugins with internal state (a delay's buffer, a sampler's zones) need the `.bdp` state API from Phase 5 and 7.
- Waveforms are now drawn from min/max peaks, so they look slightly different from the old sine-warped line.

## Phase 3: Project model

Goal: save, reopen, undo.

- [x] New `src/project/`: a versioned `Project` model (tempo map, tracks, clips, patterns, channels, plugins, assets). The engine builds from it; the UI edits it.
- [x] Command bus with undo and redo. Route every existing edit (move clip, rename, colour, volume, pan, add plugin) through it.
- [x] Serializer: JSON plus an `assets/` folder, with a migrate function per version.
- [x] File menu: New, Open, Save, Save As, Recent. Hook into the existing menu bar.
- [x] Autosave to a recovery file and a crash-recovery prompt on start.
- [x] "Collect and save": copy used samples into the project's assets folder.
- [x] Every asset in a project records its source and licence, so a chop or a generated sample keeps its origin.

Done when: save, close and reopen restores the playlist, mixer and plugins exactly, and undo and redo work for every edit above.

Phase 3 notes (what was built, and what was left on purpose):

- The format, the edit model, recovery and the security rules are in `docs/PROJECT.md`. The gate is checked by `npm test` (schema, migrations, history, asset paths and licences, the main-process store) and `npm run test:project` (the real app: undo and redo of every edit in the list above, save, close and reopen compared by value and by a bit-for-bit render, collect and save, a moved folder, missing files, hostile files, close prompts, autosave and crash recovery). A test that changes the engine's behaviour was checked by mutating the code (restore without plugin settings, a fader edit that is not recorded) to see it fail.
- The project has no patterns yet; they arrive with the pattern model in Phase 4 and are added to the schema as optional fields (no new version needed).
- Plugins are saved by parameter values. State for plugins that have internal state needs the `.bdp` state API (Phase 5 and 7).
- Opening a project that uses a plugin or an audio file that is not there still works: the missing part is named in a message and kept in the project, so saving does not lose it. A relink dialog is not built.
- The starter samples have no recorded licence. They are saved as "unknown" in every project that uses them; `files/licences.json` is where it is recorded once known, and where the user's own libraries get theirs when Phase 4 adds them.
- The tests now start the app with `BDP_TEST=1` and a scratch settings folder, so they never touch the real recent list or recovery file. (The old smoke test did not, and with the new prompts it hung; fixed.)
- macOS menu accelerators and Windows path case are not verified yet (listed in `docs/PROJECT.md`).

## Phase 4: Beat core

Goal: make, save and export a trap beat.

- [ ] `src/instruments/Sampler.ts`: zones, velocity ranges, loop points, ADSR, choke groups, streaming loader.
- [ ] SFZ-subset parser: regions, key and velocity ranges, loops, envelopes, round-robin, key switches.
- [ ] A channel rack window in the existing window frame, listing instruments and their patterns.
- [ ] Pattern model and step sequencer UI: 16, 32 and 64 steps, per-step velocity, probability, ratchet, pitch and pan, swing.
- [ ] Piano roll window drawn on canvas like the playlist: note draw, move, resize, velocity lane, quantise, scale highlight, computer-keyboard and Web MIDI input.
- [ ] Hi-hat roll tool and slide notes.
- [ ] User libraries: point the app at a folder, index it in place (never copied into the repo or installer), map kit folders to the 16-pad rack by name and layout, and mark a library *bundleable* only on your confirmation.
- [ ] Patterns as playlist clips, using the existing PAT and SONG toggle in the header.
- [ ] Export WAV from the File menu using the offline render path from phase 2.

Done when: you can build an eight-bar trap beat with an 808 and hi-hat rolls, save it and export it.

## Phase 5: Sound

Goal: instruments and effects that sound professional.

- [ ] Library manager: on-demand downloads from a manifest (URL, SHA-256, licence, size, credit text) with hash verification, a cache folder, and a generated `LICENSES/sounds.md`. Packs are split under 2 GiB and hosted on GitHub Releases at first, then Cloudflare R2 before launch.
- [ ] Bundle the compact default set (Splendid Grand Piano, Gogodze Phu Vol II, Greg Sullivan E-Pianos) with an in-app credits screen for the CC-BY items.
- [ ] 808 designer instrument; log drum instrument (amapiano and Afrobeat); plucked-string model; FM keys.
- [ ] Kick and 808 layering: phase and polarity alignment, low-end mono check, and tuning the 808 to the project key.
- [ ] Core effects as `.bdp` plugins: parametric EQ, compressor, limiter, convolution reverb, delay, saturation, bitcrusher. Add presets, bypass and saved state to the `.bdp` format.
- [ ] Sample browser: folder indexing, waveform preview, audition during playback, drag into the rack or playlist.
- [ ] Root-pitch detection on import and keyboard auto-mapping.
- [ ] Library search by description and by example sound, over every indexed library.

Done when: you sign off the default piano, drums and 808 by ear.

## Phase 6: Workflow

Goal: the fast beat-making tools.

- [ ] Automation clips and lanes, and automation recording.
- [ ] Microphone recording, punch-in and takes.
- [ ] Chopper: auto-slice, manual markers, play slices from the keyboard, record chop sequences.
- [ ] Resample: bounce any channel into the sampler.
- [ ] Time-stretch and pitch-shift (confirm the Signalsmith Stretch licence first).
- [ ] Groove templates, groove extraction from a loop or song, kit builder, and genre starter projects for trap, drill, R&B, Afrobeat and amapiano.
- [ ] Genre arrangement templates (intro, hook, verse, drop with mute automation) and one-knob transitions (risers, reverse cymbals, tape-stop builds).
- [ ] Mixer sends, buses, sidechain, kick-ducking macro, and mixer presets.
- [ ] Translation check: phone-speaker, earbud and mono previews on the master.
- [ ] Decision point: with latency measured on real hardware, revisit whether a native engine is needed (see Decisions in the blueprint).

Done when: you can drop in a song, chop it, play the chops and bounce the result in a few minutes.

## Phase 7: Intelligence and plugins

Goal: assistive features, all running on the user's machine.

- [ ] Stem split in a worker with an optional model download (check the weights' licence first).
- [ ] Audio to MIDI with Basic Pitch; BPM and key detection.
- [ ] Mix analysis (spectrum, LUFS, true peak, phase) and reference A/B.
- [ ] Describe-a-sound: map a typed description to parameters on our own instruments and effects.
- [ ] Project assistant that works only through the phase 3 command bus, with preview and accept or reject.
- [ ] WebCLAP plugin loader alongside `.bdp`; move `.bdp` hosts into sandboxed iframes so the CSP can drop `'unsafe-eval'`.
- [ ] Sample Lab spike: run Stable Audio 3 Small (SFX) in a worker or helper process, judge drum one-shot quality by ear, measure speed on a laptop, and recheck its licence. Then build text to one-shot, round-robin variants, loop inpainting and fine-tuning on your library behind an experimental switch. Do not use MusicGen (non-commercial) and hold Woosh until its licence is checked.

Done when: each feature runs on a real upload without interrupting playback.

## Phase 8: Release

Goal: a build you can hand to someone.

- [ ] Package with Electron Forge (already configured in `forge.config.js`): installers for Windows, macOS and Linux, plus an auto-updater.
- [ ] Crash recovery polish and a performance pass (CPU meter, worklet budgets, memory use of streamed libraries).
- [ ] Full audit of `LICENSES/sounds.md` and third-party notices.
- [ ] User documentation.

Done when: a clean install on a fresh machine makes and exports a beat.
