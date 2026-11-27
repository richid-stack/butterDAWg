# butterDAWg
FL Studio clone with Electron (WIP)
 
It is not a 100% clone:
there are some deviations from the original that I believe improve the UX

Basic audio functionality implemented

- [X] playback/sequencing of samples
- [X] routing tracks to channels
- [ ] piano editor
- [X] audio graph editor
- [ ] usage of fileview for importing samples/plugins
- [X] POC custom plugins
- [X] basic application of custom plugins
- [X] dynamic application of custom plugins
- [X] saving and opening of files (see [docs/PROJECT.md](docs/PROJECT.md))

# Development
install all necessary node modules:
```
npm install
```

then run with
```
npm run start
```
(this bundles the renderer into `dist/` first, then launches Electron)

Other commands:
```
npm run typecheck     # TypeScript check, no output files
npm run build         # bundle the renderer only
npm test              # unit tests: tempo maths, transport, scheduler, WAV writer, peaks
npm run smoke         # drive the real app: plugins, sample drag-and-drop, play and stop, offline, no errors
npm run test:engine   # the real audio engine: file formats, stereo, render-versus-playback null test, timing
                      # (add -- --long for a real five-minute timing run)
npm run test:project  # the real app: save, close and reopen; undo and redo of every edit; crash recovery
                      # (add -- --shots to write docs/progress/phase3-*.png)
npm run shot -- name  # screenshot to docs/progress/name.png
```
`smoke`, `test:engine`, `test:project` and `shot` need `xvfb` (and ImageMagick for `shot`) on Linux; the three tests
also need the `playwright` or `playwright-core` package, and `test:engine` uses `ffmpeg` if it is
installed (to make MP3, FLAC and OGG test files). Electron 45 downloads its binary the first time it
runs; `node node_modules/electron/install.js` fetches it up front.

The renderer runs sandboxed with no Node access; it reads files only through the bridge in
`preload.js` and `main.js`, limited to `files/`, `plugins/` and the `assets/` folder of a project the
user opened or saved. It can write only into a project folder the user chose.

The plan for turning this into a pro-grade beat-making DAW is in
[docs/BLUEPRINT.md](docs/BLUEPRINT.md) and [docs/BUILD_ORDER.md](docs/BUILD_ORDER.md).

# Build
not yet

# Version History

version 0.5.1 (current):
+ internal restructuring complete
+ custom plugins can now be developed, dynamically loaded and used

![butterDAWg_v5 1](https://user-images.githubusercontent.com/64578396/221420687-f7ac91d9-d1a6-454b-8cf2-24762e3bfd95.png)

version 0.5.0:
+ windowmanager massively improved
+ audio playback reworked (mor efficinci + better UX)
+ playlist view internally reworked (now a canvas instead of thousands of divs)
+ plugins can now be independently created with their own HTML/CSS/JS files and dynamically loaded in

![butterDAWg_v5 0](https://user-images.githubusercontent.com/64578396/211222614-d9ad333d-e9fa-46cb-b29c-fc76fba8ed66.png)


version 0.4.2:
+ Added Audio Graph bc idk
+ we now got windows in this bitch
+ custom plugins now possible
+ generalized internal codebase for easier integration and development

![butterDAWg_v4 2](https://user-images.githubusercontent.com/64578396/207967816-20bcf9ed-d39a-4359-a71a-7f9733af2c68.png)
 
 
version 0.4.1:
+ Tracks can be routed through channels
+ channels have volume indicators
+ track cursor will play from whereever it is positioned (given not placed in the middle of a sample)
+ POC for custom plugins implemented
 
 
version 0.4.0:
![grafik](https://user-images.githubusercontent.com/64578396/193315177-dd883db7-2012-4ae1-812d-96c06e7c5642.png)

 
version 0.3.2:
![grafik](https://user-images.githubusercontent.com/64578396/179958914-d864f78e-aea7-4405-9f14-c46003c45ade.png)


version 0.3.1:
![grafik](https://user-images.githubusercontent.com/64578396/179421263-a6d788f2-9b32-45d8-bf33-9c88090629fa.png)

 
version 0.3.0:
![grafik](https://user-images.githubusercontent.com/64578396/179368655-fbc7182f-d894-48b3-84ed-ef6f8d42b5ce.png)

 
version 0.2.0:
 ![image](https://user-images.githubusercontent.com/64578396/178554704-c7bd4468-8edc-4d52-bc17-284d148f41fb.png)

 
 
version 0.1.0:
![image](https://user-images.githubusercontent.com/64578396/178067986-6e06db41-a3b2-4854-9871-685442ee5db8.png)
