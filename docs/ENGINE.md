# Audio engine

How sound is made, timed and rendered. The code is in `src/engine/` (time, scheduling, files) and
`src/core/` (the playlist, mixer and channels that make the signal path). The UI never keeps time
and never starts a sound itself; it asks the engine.

## Time is in beats

Everything in the project (clip positions, loop regions, the playhead) is in **beats**. Seconds
only exist at the edge, where a beat is turned into a moment on the audio clock.

- `TempoMap` converts beats to seconds and back. Tempo points are steps, and the conversion is
  exact in both directions, so a tempo change moves the music but never moves a clip on the grid.
- A clip's *start* is in beats. Its *length* is in seconds, because that is how long the file is;
  `Sample.getDurationBeats()` says how many beats that is at the current tempo.
- The UI draws `xsnap` pixels to a beat (`beats_to_px`, `px_to_beats` in `globals.ts`).

## Transport

`Transport` is a state machine (stopped, playing, paused) with one anchor: "at clock time T the
position was beat B". Position is *calculated* from the anchor and the audio clock whenever it is
asked for, never stepped by a timer, so it cannot drift. Seek, tempo change and loop change
re-anchor. `play(delay)` starts after a delay; `playAt(time)` starts at an exact clock time.

`stop()` returns to where playing last started from; `pause()` keeps the position.

## Scheduler

Timers in a browser are late and uneven. Audio start times are not. So the scheduler does not
play anything at a timer tick. Every 25 ms it looks 150 ms ahead of the audio clock and hands each
clip that starts in that window to the audio engine with an exact start time. A timer that fires
late (even by 100 ms) changes nothing audible.

- Start times come from the anchor and the tempo map, not from the previous start, so rounding
  never accumulates. The unit test plays a five-minute loop with jittery ticks and checks every
  start time to a billionth of a second.
- A loop wraps the cursor at the loop end; a clip that would run past the loop end is faded out
  there (5 ms) and the next pass starts it again.
- Seeking, stopping, playing or changing the loop drops what is scheduled but not yet audible and
  fades out what is playing, then re-times the rest. If playing starts in the middle of a clip,
  the clip joins part way in, at the position the tempo map gives.
- A tempo change only drops what has not started yet and re-times it. A clip that is already
  sounding is audio of fixed length and plays on untouched (restarting it would need how long it
  had really played, which the new tempo map cannot say). Known limit: a clip that crosses the
  loop end keeps its old cut time until the next pass, if the tempo changes during the pass.
- A clip whose start time has already passed when it is scheduled (a stalled main thread) joins
  part way in instead of playing late.
- A clip whose file has not finished loading when it is due waits for the file, then joins part
  way in the same way, so pressing play straight after dropping a big file does not leave that
  clip silent for the pass.

`Voices` is the scheduler's host: one `AudioBufferSourceNode` and gain per played clip.

## Files and samples

All file access goes through `FileService` (`src/platform/files.ts`): `readBytes`, `readText`,
`list`, `exists`, all asynchronous. Electron implements it with the preload bridge; a browser
build will implement it with the File System Access API and downloads from the library host.

`SampleCache` reads a file, decodes it with the browser's decoder, makes waveform peaks and keeps
the result (least recently used files are dropped past 512 MB). Decoding handles WAV (8, 16, 24,
32-bit and float), MP3, FLAC and OGG, any channel count, and any sample rate: the decoder converts
to the audio device's rate, which the app now follows instead of forcing 44.1 kHz. The sidebar
starts decoding a file when the mouse goes down on it, so it is ready when it is dropped.

`Peaks` keeps the lowest and highest sample for every 256 frames. The playlist draws waveforms
from those at whatever width it needs.

## Signal path

```
clip -> voice gain -> track -> channel input -> plugins -> pan -> fader -> meter -> output -> master channel -> speakers
```

- Voice gain, track node and channel input are always two channels (`engine/nodes.ts`). A mono
  file is copied to left and right at the same level. Without this, a node's channel count follows
  its busiest input, and a mono kick would change loudness when a stereo clip started on the same
  track.
- `StereoPannerNode` pans. Centre leaves a stereo signal unchanged.
- The fader is in dB (`engine/dsp.ts`): unity at 80% of the travel, +6 dB at the top, a square
  law below unity so quiet levels get usable travel, and silence at the bottom.
- The meter is an `AnalyserNode` after the fader; `getPeak()` and `getRms()` read it. The UI draws
  the peak in dB from -60 to 0, falling back slowly.
- Plugins are kept in a list of 10 slots. The chain is rebuilt from that list on every change, so
  adding, removing or bypassing never has to work out a neighbour to reconnect.
- Every channel plays into the master channel, which plays into the speakers.
- A track plays into one channel (`Track.connect`). A track with no channel is silent.

## Offline render

`renderProject()` copies the mixer and playlist into an `OfflineAudioContext`
(`Mixer.cloneTo`, `Playlist.cloneTo`, `Plugin.cloneTo`) and plays that copy with the same
transport, scheduler and voices as live playback, so an export is what you heard. The copy shares
decoded audio with the live project. `encodeWav()` writes 16-bit (dithered), 24-bit or 32-bit
float files.

Limits: plugins are copied by their parameter values only; internal state (a delay line) is not
copied until the plugin format has a state API (Phase 5 and 7).

## Tests

| Command | What it proves |
| --- | --- |
| `npm test` | Tempo maths both ways; transport anchoring, pause, seek, loop; scheduler start times under jittery ticks, a five-minute loop with no drift, loops, seeks and tempo changes; WAV files read back through an independent library; peaks against brute force; fader law. |
| `npm run smoke` | The real app: no Node in the renderer, file bridge refuses outside paths, plugin loads and its slider works, a sample drags onto the playlist, play, stop and space work, no network, no console errors. |
| `npm run test:engine` | The real audio engine: every format, channel count and rate decodes to the right channels and content; a stereo file renders correctly at 44.1, 48 and 96 kHz; a project (two tracks, pan, fader, a plugin, mono and stereo files at different rates) is played live and recorded at the master output, rendered offline, and the two are subtracted; a loop is played in real time and each click is measured against the ideal grid; exported WAV files hold exactly the rendered audio; a clip still loading when it is due joins and ends on time; a tempo change leaves a sounding clip unbroken. |
| `npm run test:engine -- --long` | The same timing test for a real five minutes. |

The null test found two real bugs while it was being written (cloned tracks playing every clip
twice, and mono clips changing level depending on their neighbours), and the automated review of
the pull request found two more (clips still loading when due stayed silent; a tempo change
restarted sounding clips at the wrong place). All four are fixed and each has a test that fails
without the fix.
