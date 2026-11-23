# butterDAWg Pro — Feature Blueprint

Snapshot of the working doc, 2026-11-23. Companion file: [BUILD_ORDER.md](BUILD_ORDER.md).

## Vision and ground rules

butterDAWg Pro is a beat-making workstation first: every feature below is judged by whether it makes a trap, drill, R&B or Afrobeat beat faster, tighter or better-sounding.

Ground rules for the whole build:

1. **Keep the look.** The fork's existing design language and tokens stay. New panels extend them instead of introducing a new style (see Design language and tokens).
2. **Audio before chrome.** Timing, clean playback and reliable save/load come before new windows. A beat that drifts or clicks has failed, whatever the UI looks like.
3. **Extend, don't rewrite.** The fork already has a Web Audio graph, a mixer, a playlist and a loadable plugin format. Each phase grows those.
4. **Prove it by running it.** Every feature lands with a screenshot of the app running in the sandbox, so progress is visible.
5. **Record every licence.** Each bundled sound, sample set or library is logged with its licence before it ships (see Risks, licensing and open decisions).

**What "pro-grade" means here** is a checklist, not a mood:

- Sample-accurate scheduling, with no audible drift over a five-minute loop.
- Project save and load that restores everything, plus undo/redo and autosave.
- 24-bit and 32-bit float WAV export, stem export and loudness metering.
- Realistic instruments (piano, keys, bass, guitar, drums), not only synth tones.
- A fast beat workflow: hi-hat rolls, 808 slides, chopping and bounce-to-sample in a few clicks.

## Where the code is today

The fork is a working front end on a thin audio core: the engine and Electron shell are about 2,400 lines (UI components excluded), and the README's unchecked boxes match what the code lacks. I ran it in the sandbox and it starts, with the mixer and playlist windows on screen (see `docs/progress/00-baseline-electron20.png`).

| Area | What exists | What blocks pro-grade |
| --- | --- | --- |
| Transport | `Playlist.play()` resumes the AudioContext and starts every clip's buffer at once. `stop()` suspends the context. Time is kept in milliseconds. | No lookahead scheduler, loop region, tempo map or editing during playback. |
| Sample loading | WAV only, read with Node `fs` and `wavefile`, converted to 32-bit float. | Buffers use a hard-coded 2× sample rate and the same data is copied to both channels, so true stereo and other sample rates are mishandled. No MP3, FLAC or OGG. |
| Playlist | 15 tracks of sample clips, drawn on a canvas, with snap-to-grid. | No trim, fade, stretch or split. No patterns or MIDI clips. |
| Mixer | A master object plus a handful of insert channels. Each channel has 10 plugin slots, a gain node, a panner and a level meter. | The master is created but never wired in: every channel connects straight to the speakers. Pan uses a 3D `PannerNode`. No sends, buses or sidechain. |
| Plugins | `.bdp` folders holding an AudioWorklet (`plugin.js`), `host.js` and a `plugin.html` UI. Gain and SimpleDistortion ship as examples. | Chains are rewired by disconnecting and reconnecting nodes, which is fragile. No presets, bypass or saved state. |
| Audio graph editor | A separate 775-line visual node editor in `AudioGraph/`. | I have not traced how it connects to the mixer. A likely base for a routing view. |
| Not found in the code | None of these appear in the sources. | MIDI, instruments, piano roll, step sequencer, automation, recording, save and open, undo and redo, export. |

Signal path today: clip buffer → track gain → channel input analyser → up to 10 worklet plugins → panner → gain → output analyser → speakers.

## Design language and tokens

The UI is a dark slate, FL Studio-style desk: flat blue-grey panels, thin inset black bevels, orange for active transport state and green LEDs for on and off. Only nine tokens exist in `styles/general.css`; most other colours are hard-coded, so the first job is promoting the repeated ones to tokens without changing a pixel. All new work then uses tokens only.

**Existing tokens**

| Token | Value | Use today |
| --- | --- | --- |
| `--bg-darker` | #181e22 | Deepest wells, drag preview (3 uses) |
| `--bg-dark` | #242f35 | Panel wells, scrollbar track (12 uses) |
| `--bg-medium` | #434c51 | Raised controls, scrollbar thumb (13 uses) |
| `--bg-light` | #646b73 | Lightest surface tone (4 uses) |
| `--bg-default` | #656c76 | The desk behind floating windows (1 use) |
| `--track-light`, `--track-dark` | #34444e, #2e3e48 | Defined, but no `var()` use found |
| `--border-color` | #010102aa | 1px inner borders (5 uses) |
| `--text-color` | aliceblue | Default text (6 uses) |
| `--custom` | set from code | Per-element track colour (7 uses) |

**Hard-coded values to promote** (token names are a proposal)

| Proposed token | Value | Seen in |
| --- | --- | --- |
| `--accent-orange` | #f76708 glow, #ffa64a outline | Active transport buttons (`Header.css`), tool outlines (`Playlist.css`) |
| `--led-on` | #5cff5c | Mixer LEDs and meter fill (`Mixer.css`) |
| `--tool-blue` | #7bcefd, #85b3ff | 2px outlines on playlist tool buttons |
| `--tool-red` | #ff5b53 | 2px outline on a playlist tool button |
| `--tool-neutral` | #d2d8dc | Default tool outline and icon fill |
| `--header-bg` | #596267 | Header bar |
| `--channel-bg` | #374045 | Mixer channel strips |
| `--menu-border` | #191f23 | Context-menu borders |

**Geometry and type to match**

- Corners are mostly 2px; toggles and knobs use 10–20px pill radii.
- Depth comes from inset shadows and 1px dark borders, not drop shadows.
- Fader caps use a light grey gradient (`linear-gradient(grey, rgb(242, 241, 241))`).
- Type is the Lucida Sans stack at `font-size: smaller`, with labels around 0.8em or 7–8pt.

**Rules for new panels**

1. Use tokens only, and add a token to `:root` before using a colour twice.
2. Keep orange for active state and green for LEDs and levels, as today.
3. Reuse the existing window frame (`Window.css`) and inset bevel for every new editor.
4. Colour data (notes, waveforms, clips) from the track colour, so the playlist and piano roll agree.
5. Ship icons, jQuery and fonts inside the app. Today they load from the internet at start-up.

## Modernization audit

The platform is far behind: the fork pins Electron 20, which reached end of support on 8 February 2023, while the current stable release is Electron 45 (20 October 2026). Checked on 23 November 2026; each row links the page that was opened.

| Area | In this fork | Current option | Action |
| --- | --- | --- | --- |
| [Electron](https://endoflife.date/electron) | `^20.3.12` | Electron 45 with Chromium M156 and Node 24. Majors 43, 44 and 45 are supported. | Upgrade to 45 in one step, then re-test audio and windows. |
| Renderer security | `nodeIntegration: true`, `contextIsolation: false`, also in subframes (`main.js`). | Isolated renderer with a preload bridge. | Move `fs` reads (samples, plugins) into the main process behind IPC. Add a content security policy. |
| Build | TypeScript is not in `devDependencies`. `tsconfig.json` sets `watch: true` and targets ES5. About 70 direct dependencies, mostly Electron tooling internals. | Current TypeScript reports 3 errors on this code (Buffer typing, one implicit any) but still emits JS. | Add TypeScript, target ES2022, bundle the renderer, prune dependencies to what the code imports. |
| Network at start-up | `index.html` loads the icon kit, jQuery, desvg and Google Fonts from the internet. | Bundled assets. | Vendor them locally. Several toolbar buttons showed no icon in the sandbox screenshot; likely related, to confirm. |
| Audio engine | `AudioContext` fixed at 44.1 kHz; every clip started at once. | AudioWorklet with WebAssembly DSP and an offline render path for export. | Follow the device rate, add a lookahead scheduler, render exports offline. |
| [Browser plugins](https://buttondown.com/opendaw/archive/opendaw-now-runs-webclap-plugins/) | `.bdp` AudioWorklet plugins. | WebCLAP: CLAP plugins compiled to WebAssembly. The browser DAW openDAW already runs them and offers a JUCE porting kit. | Keep `.bdp`. Add a WebCLAP loader after the engine work. |
| Native plugins | None. | The [VST3 SDK](https://steinbergmedia.github.io/vst3_dev_portal/pages/VST+3+Licensing/VST3+License) is MIT-licensed from version 3.8, with no fees. [JUCE](https://raw.githubusercontent.com/juce-framework/JUCE/d60b7a78030661574a615b586d9325ba7a7fa7dd/README.md) is AGPLv3 or a commercial licence and lists VST3, AU, AUv3, AAX and LV2. | Treat VST3 hosting as a later desktop-only helper process, not part of the browser path. |
| [Time-stretch and pitch](https://unpkg.com/signalsmith-stretch@1.3.2/README.md) | None. | Signalsmith Stretch Web: WebAssembly plus AudioWorklet, with time-stretch, pitch-shift and formant controls. Licence not stated on the page. | Use for warping, sample pitching and vocal chops after confirming the licence. |
| [Stem separation](https://stemsplit.github.io/demucs-onnx/browser/) | None. | HTDemucs on ONNX Runtime Web: about 166 MB of fp16 weights, WebAssembly backend, about 2.5 s per 7.8 s chunk with 4 threads on an M4 Pro. Threads need COOP and COEP headers. | Optional download, run in a worker. Check the weights' licence on Hugging Face. |
| [Audio to MIDI](https://github.com/spotify/basic-pitch-ts) | None. | Basic Pitch in TypeScript, Apache-2.0. Works best on one instrument at a time; input is resampled to 22,050 Hz mono. | Use for humming, melody and sample-to-notes conversion. |
| [SoundFont playback](https://github.com/spessasus/spessasynth_lib) | None. | spessasynth_lib, Apache-2.0: SF2, SF3 and DLS through an AudioWorklet synth. SFZ is not mentioned. | Use for SF2 banks. Write our own SFZ-subset sampler, since most free libraries ship as SFZ. |
| [DSP authoring](https://faustdoc.grame.fr/manual/deploying) | Hand-written worklets. | Faust has web targets compiled to WebAssembly, including polyphonic MIDI-controllable nodes. Licence of generated code is not addressed on the page. | Evaluate for synths and effects after checking the licence. |

## Core feature set

Fifteen systems make up the pro-grade core. Priority **Now** means a beat can be made, saved and exported end to end; **Next** makes it sound and feel professional; **Later** is polish and ecosystem.

| System | What to build | In repo today | Priority |
| --- | --- | --- | --- |
| Engine and transport | Lookahead scheduler, loop region, tempo map and time-signature changes, sample-accurate starts, device selection, any sample rate, 24-bit and 32-bit float, offline render, latency compensation. | Partial: clips start at once, fixed 44.1 kHz. | Now |
| Project and history | Versioned JSON project plus an assets folder, save and open, autosave, crash recovery, undo and redo, recent projects, templates. | None. | Now |
| Playlist | Patterns and free audio clips on one timeline. Trim, split, duplicate, fade, clip gain and pitch, reverse, markers, loop regions, track groups and colours, multi-select, zoom, ghost references. | Partial: sample clips on 15 tracks with snap. | Now |
| Piano roll | Draw, move and resize notes; velocity lane; quantise, swing and humanise; scale highlight; chord, strum and legato tools; slide notes; ghost notes; per-note pan and pitch; computer-keyboard and MIDI-keyboard input; note colour groups. | None. | Now |
| Step sequencer and drum rack | 16, 32, 64 and custom steps; per-step velocity, probability, ratchet, pitch and pan; swing and groove templates; flams and rolls; pattern chaining and variations; Euclidean generator; pad input from keyboard or MIDI. | None. | Now |
| Mixer | Wire the master in; inserts, sends, buses, group channels, sidechain; equal-power stereo pan; dB faders; peak, RMS and LUFS meters; solo, mute, bypass; routing matrix; channel and mixer presets. | Partial: insert channels with 10 slots each, no master path. | Now |
| Sampler and drum sampler | Zones, velocity layers, round-robin, loop points, ADSR, filter, pitch and glide, choke groups, one-shot and gate modes, SFZ import. Detail under the sampling pipeline section. | None. | Now |
| Export and mastering | WAV at 16, 24 and 32-bit float first; then MP3, FLAC and OGG, stems, per-track, loop and pattern export, loudness targets, dither, true-peak limiter, reference-track A/B. | None. | Now (WAV), Next (rest) |
| Instruments | Analog, wavetable and FM synths; 808 and sub-bass; piano, keys, organ, bass, guitar, strings; preset browser. | None. | Next |
| Effects | Parametric EQ, compressor, limiter, gate, de-esser, transient shaper, stereo imager, convolution reverb, delay, chorus, phaser, flanger, saturation, bitcrusher, tape, filter, pitch and frequency shifter, glitch and stutter. | Partial: Gain and SimpleDistortion. | Next |
| Automation and modulation | Automation clips with linear, curve and step segments; record automation; LFO and envelope modulators; macros; MIDI controller mapping; per-note automation. | None. | Next |
| Recording and audio editing | Mic and instrument recording, punch-in, loop takes and comping, waveform editor, slicing, normalise, fades and crossfades, time-stretch, pitch-shift, noise gate, silence removal. | None. | Next |
| Sample browser | Local folder indexing, waveform preview, audition during playback, BPM and key tags, favourites, recents, search, drag into playlist or sampler, packs. | Partial: a folder sidebar over `files/samples`. | Next |
| Plugins | Presets, bypass and saved state for `.bdp` plugins; WebCLAP loader; plugin browser, favourites, crash isolation. Native VST3 later through a helper process. | Partial: two example `.bdp` plugins. | Later |
| Workflow and ecosystem | Shortcut editor, command palette, detachable windows and layouts, themes, MIDI controller setup. Later: cloud backup, version history, shared projects, collaboration, sample and preset marketplace. | Partial: floating windows. | Later |

## Beat-production power features

These are additions aimed at trap, drill, R&B and Afrobeat beats. They are what turns a general DAW into a fast beat-making tool.

**808 and bass**

- **808 designer:** a sine or triangle core with a pitch-drop envelope, sub layer, saturation and glide, so a bass is built rather than only loaded.
- **Root-note detection:** find the pitch of any 808 or bass sample on import and map it across the keyboard, so it plays in key.
- **Slide notes:** note-to-note glide in the piano roll with an adjustable curve, for drill-style sliding 808s.
- **Kick sidechain macro:** one knob that ducks the 808 under the kick.

**Hi-hats and drums**

- **Hi-hat roll tool:** draw rolls with ratchet subdivisions, triplets, velocity ramps and small pitch and pan variance, with one-click roll presets.
- **Groove and humanise:** swing templates, triplet shuffle, and per-lane velocity and timing variance.
- **Kit builder:** assign any samples to 16 pads, with choke groups and per-pad envelope, pitch and filter, then save the kit.
- **Fill generator:** propose a drum fill for the last bar of a pattern, which you accept or reject.

**Chopping and sampling**

- **Chopper:** auto-slice on transients or the beat grid, add manual markers, play slices from the keyboard, and record a chop sequence while the sample plays.
- **Flip tools:** reverse, half and double speed, tape-stop, loop crossfade, and pitch shifting with or without formants.
- **Resample:** bounce any channel back into the sampler in one click, to layer and re-chop your own sounds.
- **Split then chop:** separate a song into drums, bass, vocals and other, then chop each stem on its own.

**Vocals and melody**

- **Vocal chop instrument:** slice a vocal and map the slices across the keyboard with formant-preserving pitch shift, so one phrase plays as a melodic instrument.
- **Key helpers:** scale lock, chord stamps, chord suggestions in key, arpeggiator and strum.
- **Hum to MIDI:** sing or whistle a line and get notes in the piano roll.

**Genre starters and workflow**

- **Starter projects** for trap, drill, R&B and Afrobeat with a drum rack, bus chain, tempo and key already set.
- **Afrobeat percussion set:** shakers, congas and a synthesised log drum, built from the free libraries in the next section.
- **Drum, vocal and master chains** as one-knob macros, with a limiter and loudness meter on the master.
- **Drop-a-loop setup:** detect BPM and key from a dropped file and set the project to match.

## Instrument modelling and sampling pipeline

Realism comes from three layers working together: free multisampled instruments for acoustic character, a sampler for anything you upload, and modelled synthesis for sounds that samples handle badly, such as 808s, plucks and pads. Acoustic piano and guitar stay sample-based; modelling them convincingly is a research problem, not a feature.

**Layer 1: free multisampled instruments**

Verified on 23 November 2026 from the library pages. Sizes are the download sizes shown there.

| Sound | Library | Licence | Size | In a shipped product |
| --- | --- | --- | --- | --- |
| Grand piano | [Salamander Grand Piano](https://sfzinstruments.github.io/pianos) | CC-BY-3.0 | 394+ MB | Yes, with credit |
| Grand piano (compact) | [Splendid Grand Piano](https://sfzinstruments.github.io/pianos) | Public domain | 77 MB | Yes |
| Electric pianos | [Greg Sullivan E-Pianos](https://sfzinstruments.github.io/pianos) | CC-BY-3.0 | 21.5 MB | Yes, with credit |
| Rhodes | [jRhodes3c and jRhodes3d](https://sfzinstruments.github.io/pianos) | CC-BY-NC-SA-4.0 and CC-BY-NC-4.0 | 18 MB, 92 MB | No: non-commercial |
| Keys, orchestral, world percussion | [Versilian Community Sample Library](https://versilian-studios.com/vcsl/) | CC0 | about 5 GB, 4,000+ samples | Yes, no credit |
| Drum kits | [Big Rusty, Swirly, Unruly, Frankensnare](https://sfzinstruments.github.io/drums) | CC0 | 2.3 GB, 1.6 GB, 2 GB, 900 MB | Yes, no credit |
| Drum kit (compact) | [Gogodze Phu Vol II](https://sfzinstruments.github.io/drums) | CC0 | 133 MB | Yes, no credit |
| Drum kit | [SM Drums](https://sfzinstruments.github.io/drums) | Public domain | 2.2+ GB | Yes |
| Drum kits | [Muldjord, Naked Drums, DRS](https://sfzinstruments.github.io/drums) | CC-BY-4.0 | 347 MB, 1.3 GB, 754 MB | Yes, with credit |
| Drum kit | [Salamander Drumkit](https://sfzinstruments.github.io/drums) | CC-BY-SA-3.0 | about 370 MB | Review: share-alike |
| Upright bass | [Ergo electric upright bass](https://sfzinstruments.github.io/misc) | CC0 | not listed | Yes, no credit |
| Double bass | [Sneakybass](https://bedroomproducersblog.com/2022/12/09/karoyfer-sneakybass/) | Not named in the article that was read | not stated | Check first |

Gaps: no verified free guitar, electric bass or synth library was found. Guitar and bass will start from your uploads and modelled plucks.

Ship a small default set (Splendid piano, Gogodze drums, Greg Sullivan keys, about 230 MB) and download the multi-gigabyte libraries on demand. The sampler must stream and cache, not load everything into memory.

**Layer 2: your own samples**

1. **Import:** WAV, MP3, FLAC and OGG, decoded to 32-bit float stereo at the device sample rate.
2. **Analyse:** root pitch, BPM, key, transients and loudness, stored beside the file.
3. **Map:** spread one sample across the keyboard, or build zones from a folder of multisamples named by note. Use formant-preserving pitch shifting for voices.
4. **Shape:** loop points with crossfade, envelope, filter, velocity response, and round-robin from several takes.
5. **Resample:** bounce the result to a new sample and save it as an instrument preset in the project.
6. **Record:** sample from the microphone or line-in, or resample a mixer channel.

The sampler reads an SFZ subset directly (regions, key and velocity ranges, loops, envelopes, round-robin, key switches), because the free libraries above ship as SFZ. SF2 banks play through spessasynth.

**Layer 3: modelled instruments**

- **808 and sub bass:** oscillator, pitch envelope, saturation and glide.
- **Plucked strings** (bass, guitar-like, harp, kalimba): a string model with a damped feedback loop, blended with a sampled pluck transient for realism.
- **FM keys and bells:** Rhodes-style keys, bells and marimba tones.
- **Wavetable and analog-style synth:** pads, leads and basses with unison, filter and modulation.
- **Synth drums and noise percussion:** kicks, snares, hats and shakers with endless variation.

The DSP is written as AudioWorklet and WebAssembly code. Faust is an option for authoring, pending the licence check in the last section.

**Realism techniques for every instrument**

- Velocity layers and at least three round-robin variations, so repeated hits and fast hi-hats never sound machine-gunned.
- Release samples, key and pedal noise, and key-switch articulations (the Sneakybass pack ships SFZ key switches for its articulations).
- Humanise timing and velocity; with a single sample, vary start offset and micro-pitch to fake round-robin.
- Convolution reverb with room impulses, and a close-versus-room blend where a library has several microphones.

**Licence rule**

Prefer CC0 and public domain. CC-BY needs an in-app credits screen and credits in project metadata. Avoid non-commercial licences for anything shipped. Treat share-alike, freemium and custom licences as needing review. Keep a licence ledger in the repo (source link, licence, date checked) for every bundled sound. Samples cut from commercial songs need clearance before release; the app should keep the source info with each chop. This is not legal advice.

## Assistive and analysis features

Most of these run on the user's machine, so uploads stay private, and several need no machine learning at all. The assistant features depend on the project model from the first build phase.

| Feature | How it works | Notes |
| --- | --- | --- |
| Stem split | HTDemucs on ONNX Runtime Web, run in a worker, into drums, bass, vocals and other. | Optional download of about 166 MB. About 2.5 s per 7.8 s of audio with 4 threads on an M4 Pro. |
| Audio to MIDI | Basic Pitch in TypeScript. | Best on one instrument at a time. Feeds hum-to-MIDI and sample-to-notes. |
| BPM, key and root pitch | An analysis worker run on import. | Needed for drop-a-loop setup and 808 mapping. Library to choose in the first spike. |
| Mix analysis | Spectrum, LUFS, true peak, phase correlation, clipping alerts, and a frequency-clash view between two channels. | Built on Web Audio analysers and our own loudness filter. No ML needed. |
| Reference A/B | Load a reference track, level-match it, switch instantly and overlay its spectrum. | Lives in the mastering section of the mixer. |
| Describe-a-sound | A typed description sets parameters on our own synths and effect chains, as a preset you can tweak. | Uses a language model to fill parameters. No generated audio, so no training-data licence issues. |
| Vocal chop maker | Stem split, then auto-slice, then map the slices across the keyboard. | Combines features from the sampling pipeline. |
| Project assistant | A typed command layer (add pattern, set tempo, edit notes) with a preview and accept or reject. | The assistant never touches UI elements or audio internals directly. |

## Build order

Eight phases, with the audio engine and project model first so every later feature lands on solid ground. Each phase ends with screenshots of the running app and a short note on what changed. Task-level detail is in [BUILD_ORDER.md](BUILD_ORDER.md).

1. **Foundation.** Upgrade to Electron 45, isolate the renderer behind a preload bridge, vendor the CDN assets, add TypeScript, a bundler and tests, and move repeated colours into tokens. *Done when* the app runs offline on Electron 45 with `contextIsolation` on and looks the same as today.
2. **Engine core.** Lookahead scheduler with transport, loop and tempo map; fix sample loading (stereo, sample rate, MP3, FLAC, OGG); wire the master bus; equal-power pan and dB faders; offline render to WAV. *Done when* a five-minute loop plays without audible drift and the rendered WAV matches playback.
3. **Project model.** A versioned JSON project with an assets folder, save and open, undo and redo, autosave. *Done when* save, close and reopen restores the playlist, mixer and plugins exactly.
4. **Beat core.** SFZ-subset sampler, drum rack with step sequencer, piano roll, patterns in the playlist. *Done when* you can build an eight-bar trap beat with an 808 and hi-hat rolls, save it and export it.
5. **Sound.** On-demand free libraries, 808 designer, plucked-string and FM instruments, the core effects (EQ, compressor, limiter, reverb, delay), and the sample browser. *Done when* you sign off the default piano, drums and 808 by ear.
6. **Workflow.** Automation, recording, chopper, resample, time-stretch, groove templates, genre starters, and mixer sends, buses and sidechain. *Done when* you can drop in a song, chop it, play the chops and bounce the result in a few minutes.
7. **Intelligence and plugins.** Stem split, audio to MIDI, BPM and key detection, reference A/B, describe-a-sound, the project assistant and a WebCLAP loader. *Done when* each runs on a real upload without freezing the audio.
8. **Release.** Packaging with Electron Forge, installer and updater, crash recovery, a performance pass, and a full audit of the licence ledger. *Done when* a clean install on a fresh machine makes and exports a beat.

## Risks, licensing and open decisions

Four licences are still unverified and one licence file is inconsistent. None of them blocks the foundation phase.

**Licensing**

- The repo's `LICENSE` is MIT (copyright 2022 Jan Bessler, the upstream author) but `package.json` says ISC. Keep the upstream notice and correct `package.json` to MIT.
- Not yet verified: the Signalsmith Stretch licence (its README does not state one), the licence of the HTDemucs model weights (check the Hugging Face model card), the licence of Faust-generated code, and the Sneakybass licence.
- JUCE is AGPLv3 or a paid commercial licence, so adopting it for a native engine is a licensing decision as well as a technical one. The VST3 SDK is MIT from version 3.8; VST2 source is not covered.
- Sample licences follow the rule in the instruments section, enforced through the licence ledger.

**Technical risks**

- Web Audio latency is higher and less controllable than native drivers such as ASIO. Keep the engine behind one interface so a native engine can replace it later.
- Stem separation needs multi-threaded WebAssembly, which the demucs page says requires COOP and COEP headers. The app loads from `file://` today, so it may need a custom protocol or a local server. To confirm in the foundation phase.
- Multi-gigabyte libraries need streaming and caching designed in from the beat core phase, not added afterwards.
- The UI uses a small hand-made JSX shim instead of a framework. Keep it for existing windows and draw heavy editors (piano roll, sampler waveform) on canvas, as the playlist already does.

**Open decisions** (recommendation first)

1. **Personal use or product?** Build as if it ships, which means no non-commercial samples, and decide later.
2. **Electron only, or Electron plus a browser build?** Electron first, with file access behind one service so a browser build stays possible.
3. **When to consider a native engine?** Not before the workflow phase, and only if latency or plugin hosting demands it.
4. **Where do multi-gigabyte libraries download from?** A host you control, with checksums.
