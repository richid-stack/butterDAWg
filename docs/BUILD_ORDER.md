# butterDAWg Pro — Build Order

Task-level plan for the eight phases in [BLUEPRINT.md](BLUEPRINT.md). Tick boxes as work lands.

## Rules for every phase

- Work in small commits. Each phase gets its own branch, merged when its *done when* gate passes.
- Use design tokens only (`styles/general.css`). Reuse the window frame in `styles/Window.css`.
- Run the app under a virtual display after each task and save a screenshot to `docs/progress/` named `<phase>-<what>.png`. The baseline is `00-baseline-electron20.png`.
- Every bundled sound or library gets a line in `LICENSES/sounds.md` (source link, licence, date checked) before it is committed.
- The three commands below are what was used to run the app in the sandbox. Phase 1 turns them into `npm` scripts.

```
npm install
npx tsc -p . --watch false          # compile to built/ (TypeScript is not yet a devDependency)
xvfb-run -a -s "-screen 0 1800x1000x24" ./node_modules/.bin/electron . --no-sandbox --disable-gpu
```

## Phase 1: Foundation

Goal: a modern, secure, reproducible base with no visible change.

- [ ] Upgrade `electron` to 45.x and the `@electron-forge/*` packages to current. Fix any API changes in `main.js`.
- [ ] `main.js`: set `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`; add a content security policy.
- [ ] `preload.js`: expose a small bridge (`readFile`, `listDir`, `readPlugin`) and replace direct `require("fs")` in `src/core/Source.ts`, `src/core/Plugin.ts`, `src/index.ts` and any other file that reads from disk.
- [ ] Vendor Font Awesome, jQuery, desvg and Open Sans into `vendor/`; remove the CDN tags in `index.html`.
- [ ] `package.json`: add TypeScript as a devDependency, prune the ~70 direct dependencies to what the code imports (keep `wavefile`, `uuid`, `electron-squirrel-startup`), set `"license": "MIT"` to match `LICENSE`.
- [ ] `tsconfig.json`: remove `watch`, target ES2022; fix the three current type errors (`src/PaletteItem.ts:63`, `src/core/Source.ts:39`, `src/core/Channel.ts:22`).
- [ ] Add a bundler script that outputs `built/`; make `npm start` build then launch.
- [ ] Add `npm run shot`: launch under Xvfb, wait, save a screenshot to `docs/progress/`.
- [ ] Add a CI workflow (GitHub Actions) that runs install, build and `npm run shot`.
- [ ] Move repeated colours into tokens in `styles/general.css` per the blueprint table. No visual change.
- [ ] Confirm whether threads for stem separation need a custom protocol instead of `file://` (see risks in the blueprint).

Done when: the app runs offline on Electron 45 with `contextIsolation` on, CI is green, and the new screenshot matches `00-baseline-electron20.png`.

## Phase 2: Engine core

Goal: timing and signal path you can trust.

- [ ] New `src/engine/Transport.ts`: stopped, playing and paused states; position in beats and seconds; loop region; tempo map. Replace the context suspend/resume logic in `Playlist.play()` and `Playlist.stop()`.
- [ ] New `src/engine/Scheduler.ts`: lookahead timer using `audioContext.currentTime`, scheduling clips and notes just ahead of the playhead. Replace the start-everything-at-once loop in `Track.play()`.
- [ ] Replace millisecond time (`globals.current_time`) with beats; update `pixels_to_ms` and related helpers in `src/globals.ts`.
- [ ] `src/globals.ts`: stop forcing `sampleRate: 44100`; follow the device rate.
- [ ] Rework `src/core/Source.ts` and `src/core/Sample.ts`: decode with the browser decoder, use the real channel count and sample rate, remove the 2× rate hack, support WAV, MP3, FLAC and OGG, cache waveform peaks.
- [ ] `src/core/Mixer.ts` and `src/core/Channel.ts`: route channels into the master channel, then the master into the speakers. Use `StereoPannerNode`. Map faders in dB. Add peak and RMS meters.
- [ ] Rebuild the plugin chain from a list instead of disconnecting and reconnecting neighbours (`Channel.addPlugin`). Add a bypass flag.
- [ ] Offline render path (`OfflineAudioContext`) that builds the same graph, plus a WAV writer for 16-bit, 24-bit and 32-bit float using `wavefile`.
- [ ] Tests: scheduler timing maths, a render-versus-playback null test, and a stereo file test.

Done when: a five-minute loop plays without audible drift, the rendered WAV matches playback, and stereo files at any sample rate play correctly.

## Phase 3: Project model

Goal: save, reopen, undo.

- [ ] New `src/project/`: a versioned `Project` model (tempo map, tracks, clips, patterns, channels, plugins, assets). The engine builds from it; the UI edits it.
- [ ] Command bus with undo and redo. Route every existing edit (move clip, rename, colour, volume, pan, add plugin) through it.
- [ ] Serializer: JSON plus an `assets/` folder, with a migrate function per version.
- [ ] File menu: New, Open, Save, Save As, Recent. Hook into the existing menu bar.
- [ ] Autosave to a recovery file and a crash-recovery prompt on start.
- [ ] "Collect and save": copy used samples into the project's assets folder.

Done when: save, close and reopen restores the playlist, mixer and plugins exactly, and undo and redo work for every edit above.

## Phase 4: Beat core

Goal: make, save and export a trap beat.

- [ ] `src/instruments/Sampler.ts`: zones, velocity ranges, loop points, ADSR, choke groups, streaming loader.
- [ ] SFZ-subset parser: regions, key and velocity ranges, loops, envelopes, round-robin, key switches.
- [ ] A channel rack window in the existing window frame, listing instruments and their patterns.
- [ ] Pattern model and step sequencer UI: 16, 32 and 64 steps, per-step velocity, probability, ratchet, pitch and pan, swing.
- [ ] Piano roll window drawn on canvas like the playlist: note draw, move, resize, velocity lane, quantise, scale highlight, computer-keyboard and Web MIDI input.
- [ ] Hi-hat roll tool and slide notes.
- [ ] Patterns as playlist clips, using the existing PAT and SONG toggle in the header.
- [ ] Export WAV from the File menu using the offline render path from phase 2.

Done when: you can build an eight-bar trap beat with an 808 and hi-hat rolls, save it and export it.

## Phase 5: Sound

Goal: instruments and effects that sound professional.

- [ ] Library manager: on-demand downloads with checksums, a cache folder, and a generated `LICENSES/sounds.md`.
- [ ] Bundle the compact default set (Splendid Grand Piano, Gogodze Phu Vol II, Greg Sullivan E-Pianos) with an in-app credits screen for the CC-BY items.
- [ ] 808 designer instrument; plucked-string model; FM keys.
- [ ] Core effects as `.bdp` plugins: parametric EQ, compressor, limiter, convolution reverb, delay, saturation, bitcrusher. Add presets, bypass and saved state to the `.bdp` format.
- [ ] Sample browser: folder indexing, waveform preview, audition during playback, drag into the rack or playlist.
- [ ] Root-pitch detection on import and keyboard auto-mapping.

Done when: you sign off the default piano, drums and 808 by ear.

## Phase 6: Workflow

Goal: the fast beat-making tools.

- [ ] Automation clips and lanes, and automation recording.
- [ ] Microphone recording, punch-in and takes.
- [ ] Chopper: auto-slice, manual markers, play slices from the keyboard, record chop sequences.
- [ ] Resample: bounce any channel into the sampler.
- [ ] Time-stretch and pitch-shift (confirm the Signalsmith Stretch licence first).
- [ ] Groove templates, kit builder and genre starter projects.
- [ ] Mixer sends, buses, sidechain, kick-ducking macro, and mixer presets.

Done when: you can drop in a song, chop it, play the chops and bounce the result in a few minutes.

## Phase 7: Intelligence and plugins

Goal: assistive features, all running on the user's machine.

- [ ] Stem split in a worker with an optional model download (check the weights' licence first).
- [ ] Audio to MIDI with Basic Pitch; BPM and key detection.
- [ ] Mix analysis (spectrum, LUFS, true peak, phase) and reference A/B.
- [ ] Describe-a-sound: map a typed description to parameters on our own instruments and effects.
- [ ] Project assistant that works only through the phase 3 command bus, with preview and accept or reject.
- [ ] WebCLAP plugin loader alongside `.bdp`.

Done when: each feature runs on a real upload without interrupting playback.

## Phase 8: Release

Goal: a build you can hand to someone.

- [ ] Package with Electron Forge (already configured in `forge.config.js`): installers for Windows, macOS and Linux, plus an auto-updater.
- [ ] Crash recovery polish and a performance pass (CPU meter, worklet budgets, memory use of streamed libraries).
- [ ] Full audit of `LICENSES/sounds.md` and third-party notices.
- [ ] User documentation.

Done when: a clean install on a fresh machine makes and exports a beat.
