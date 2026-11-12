# Spike notes: Red Alert in the browser

Branch `spike/web`, based on commit `ce83b59`.

## Ticket 1: Native build (phase 0 gate)

Goal: build Red Alert natively in WSL Ubuntu and run it with the demo data, as a known-good baseline before the WebAssembly work.

### Environment

| | |
|---|---|
| OS | Ubuntu 26.04.1 LTS on WSL2 (kernel 6.6.87.2), WSLg for display and sound |
| Compiler | g++ 15.2.0 |
| CMake | 4.2.3, "Unix Makefiles" generator (Ninja is not installed) |
| SDL2 | libsdl2-dev 2.32.10 |
| OpenAL | libopenal-dev 1.25.1 (openal-soft) |
| Game data | Red Alert demo, `MAIN.MIX` and `REDALERT.MIX`, in `~/ra-data/demo` |

### Build commands

Run from the repo root.

```sh
# Configure: generate Makefiles into build/, Red Alert only.
cmake -S . -B build -DBUILD_VANILLATD=OFF

# Compile with 16 parallel jobs. Takes about 30 seconds here.
cmake --build build -j16
```

Result: `build/vanillara`. The `build/` directory is ignored by git.

### Run commands

One-time setup: tell the game where the data is, and to run in a window. This file lives outside the repo.

```sh
mkdir -p ~/.config/vanilla-conquer/vanillara
cat > ~/.config/vanilla-conquer/vanillara/redalert.ini <<'EOF'
[Paths]
DataPath=/home/mikem93/ra-data/demo

[Video]
Windowed=yes
WindowWidth=1280
WindowHeight=800

[Mouse]
RawInput=no
EOF
```

`RawInput=no` fixes the inverted mouse described under Problems.

Then, from the repo root:

```sh
./build/vanillara
```

The game reads the `.MIX` files in place. It writes its settings and saved games into `~/.config/vanilla-conquer/vanillara/`, never into the repo or the data folder.

### What I did

1. Checked the toolchain, WSLg, and the demo data (read-only).
2. Read `common/paths.cpp` to find how the game locates its data: a `[Paths] DataPath=` entry in `redalert.ini`, looked up in the per-user config folder.
3. Configured and built the `VanillaRA` target only. No source, README or CMake files were changed.
4. Created the config file above.
5. Smoke test: `timeout 20 ./build/vanillara` was still running when the timer fired (exit code 124), with no crash.
6. Interactive play test by the owner (results below).

### Decisions

- **Acceptance changed from "start a skirmish" to "start the first demo campaign mission and play about a minute (units move, sound plays, no crash)".** Reason: the demo data contains 3 campaign missions and no skirmish maps. The skirmish map list is built from `MISSIONS.PKT` and loose `.MPR` files (`SessionClass::Read_Scenario_Descriptions`, `redalert/session.cpp`), and the demo has neither. Meeting the original wording would have meant adding a map file, which the owner ruled out.
- **Red Alert only.** `-DBUILD_VANILLATD=OFF` skips Tiberian Dawn, which is out of scope and halves the compile.
- **Plain CMake instead of the CI presets.** The presets need Ninja, which is not installed. Nothing was installed for this ticket.
- **Data located through the config file, not by copying or symlinking.** Keeps both the repo and `~/ra-data` untouched.
- **Windowed mode.** The game defaults to fullscreen, which is awkward under WSLg.

### Problems

None blocked the build. Things worth knowing:

- **Mouse inverted on both axes in the first play test** (left/right and up/down), which made the game hard to control. With its default `RawInput=yes` the game asks SDL for relative mouse movements and steers its own cursor from them (`Move_Video_Mouse`, `common/video_sdl2.cpp`). WSLg has to emulate that mode, which is the suspected cause. Fix: `[Mouse] RawInput=no` in the config file, so the game follows the normal pointer position. Config only, no source change. Confirmed by the owner in the second play test.
- **Three compiler warnings in original game code**, each a possible small buffer overrun. Not fixed, since source changes are out of scope. They are candidates for trouble in the WebAssembly build:
  - `redalert/house.h:991`: loop reads past the end of `BQuantity` (iteration 84).
  - `redalert/score.cpp:1663`: `sprintf` may write one byte past its buffer.
  - `redalert/sendfile.cpp:582`: `strcpy` of 13 bytes into a 12-byte buffer.
- **Sound log noise.** On start, OpenAL prints `Failed to create PipeWire event context` and two `pw.conf` lines. WSL has no PipeWire; OpenAL then falls back to PulseAudio, which WSLg provides.
- **Configure warnings, all harmless:** CMake policy CMP0183 notice at `CMakeLists.txt:62` (that line also has a stray comma after `BUILD_REMASTERTD`), `clang-format` not found (only needed for the `format` target), ImageMagick not found (only needed for the app icon).
- **No skirmish with demo data**, see Decisions.

### Acceptance results

Session 1 (default settings, windowed), as reported by the owner:

| Check | Result |
|---|---|
| Game launches | Yes |
| Main menu appears | Yes |
| First demo campaign mission starts | Yes |
| Units move | Yes |
| Sound plays | Yes |
| Mouse | Inverted on both axes, hard to control |
| Clean exit | Yes, exit code 0 |

Session 2 (with `RawInput=no`): the owner reported the mouse working correctly. Exit code 0.

Result: the revised acceptance is met. The game launches, reaches the main menu, starts the first demo campaign mission, units move and sound plays. The owner confirmed no crashes or errors in either session; both exited with code 0 and their logs contain only the PipeWire notice.

## Session 2: First Emscripten build (ticket 2, discovery only)

Goal: find out what stops this code building for the browser. CMake files may change; C++ source may not.

**Result: the Red Alert target compiles and links for the browser once three build blockers are dealt with, all of them small.** Output: `build-web/vanillara.js` (430 KB) and `build-web/vanillara.wasm` (13 MB, with debug info). It has not been run in a browser. No C++ source was changed.

### Environment

| | |
|---|---|
| Emscripten | 7.0.0 (`emcc`, based on clang 24), installed with emsdk in `~/emsdk` (1.8 GB, outside the repo) |
| SDL2 | Emscripten's own port, 2.32.10 (same version as the native build), built on first use |
| OpenAL | Emscripten's built-in implementation (headers in its sysroot, library written in JavaScript) |
| CMake | 4.2.3, "Unix Makefiles" generator, as in ticket 1 |
| Build time | about 19 seconds for a full build with 16 jobs |

### Commands

```sh
# One-time install. Nothing is added to ~/.bashrc.
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install latest
~/emsdk/emsdk activate latest

# In every new shell: put emcc and emcmake on the PATH.
source ~/emsdk/emsdk_env.sh

# Configure. emcmake makes CMake use the Emscripten compiler and its own headers and libraries.
# -w hides warnings (as CI does); -ferror-limit=0 reports every error instead of stopping at 20 per file.
emcmake cmake -S . -B build-web -DBUILD_VANILLATD=OFF "-DVC_CXX_FLAGS=-w;-ferror-limit=0"

# Build Red Alert only. -k keeps going after a failed file, so one pass collects all errors.
cmake --build build-web --target VanillaRA -j16 -- -k > build-web/build-N.log 2>&1
```

`build-web/` and `build-web-nonet/` are ignored by git (the `/build*` rule). Build logs are kept inside them.

### Build blockers

"Seen" means the error appeared in a log. Sizes are for the proper fix.

| # | File | Type of error | Status | Likely fix | Size |
|---|---|---|---|---|---|
| 1 | `CMakeLists.txt:144`, `cmake/FindSDL2.cmake` | Configure: `Could NOT find SDL2 (missing: SDL2_LIBRARY SDL2_INCLUDE_DIR)`. The finder looks for a library file; Emscripten supplies SDL2 through a compiler flag instead. | Seen (baseline). Fixed in CMake. | `if(EMSCRIPTEN)`: skip the finder, add `--use-port=sdl2` to compile and link options. Done. | Small |
| 2 | `CMakeLists.txt` OpenAL block, `cmake/FindOpenAL.cmake` | Configure: the same kind of failure is expected for OpenAL. | **Not seen**: changed in the same edit as blocker 1, so the failure itself was never observed. | `if(EMSCRIPTEN)`: skip the finder, add the sysroot `include/AL` folder (the code includes `<al.h>`, not `<AL/al.h>`), link `openal`. Done. | Small |
| 3 | `common/wwstd.h:263` | Compile: `static declaration of 'strupr' follows non-static declaration`. Emscripten's `<string.h>` already declares `strupr`. One error in each of 27 files of the `common` library; the build stopped there, so the other two targets were not reached in that round. | Seen (round 1). **Routed around**, not fixed. | Proper fix is in C++: skip the `strupr` helper when `__EMSCRIPTEN__` is defined (about 2 lines), then delete the CMake workaround. | Small |

After these, round 2 compiled all 268 objects with 0 errors and linked. The only link message is a notice that optimisation is limited because debug info was requested.

Build rounds:

| Round | Setup | Result |
|---|---|---|
| Baseline | No repo changes | Configure fails, blocker 1 |
| 1 | CMake changes for SDL2 and OpenAL | 27 errors, all blocker 3; 68 objects built |
| 2 | Plus the `strupr` workaround | 0 errors, links. Networking and sound on |
| 3 | Round 2 plus `-DNETWORKING=OFF`, in `build-web-nonet/` | 0 errors, links (259 objects, 12.6 MB `.wasm`) |

### CMake changes (uncommitted)

All in the top-level `CMakeLists.txt`, 32 changed lines, each inside `if(EMSCRIPTEN)` so the native build takes the same path as before. Checked: the native build still configures against Ubuntu's SDL2 and OpenAL and builds with 0 errors.

1. SDL2: use Emscripten's port instead of `find_package(SDL2)`.
2. OpenAL: use Emscripten's headers and library instead of `find_package(OpenAL)`.
3. **Temporary workaround for blocker 3**, marked `SPIKE WORKAROUND`: CMake writes `build-web/web_shim.h` and passes it with `-include` (include this file first in every source). The file renames Emscripten's `strupr` declaration so it no longer clashes. Remove it when `wwstd.h` is fixed.

### What did not block

- No other compile or link errors in the 268 files. No assembly or CPU-specific code turned up.
- The networking code compiles as is: Emscripten ships the POSIX socket headers it uses (`common/sockets.h`, `common/wspudp.cpp`). Compiling is not the same as working, see below.
- The `-fsigned-char` and `-fcheck-new` checks in `cmake/Compilers.cmake` both pass.
- CMake prints a warning seven times that CMake 4.2.3 does not support Emscripten shared libraries. Harmless here: everything is linked statically.

### Beyond this ticket: first look at running it

One check outside the ticket's question, done without a browser and without game data: `timeout 20 node build-web/vanillara.js`. The program loads, `main()` runs and reaches `Set_Video_Mode`, then SDL's video start-up fails with `ReferenceError: screen is not defined`. Node has no browser screen, so this says only that start-up gets as far as video.

Not tested, noticed while reading. Candidates for the next tickets:

- **The game never returns control.** `main()` runs its own loops and waits with `nanosleep` (`common/mssleep.h`, used from 4 places in 2 files). A browser page freezes unless the program hands control back each frame. The usual options are Emscripten's Asyncify feature or restructuring the main loop; neither was tried. Probably the largest piece of work.
- **Game data.** The web build sees an empty in-memory file system, not `~/ra-data`. The `.MIX` files and `redalert.ini` have to be supplied at run time, in a way that keeps them out of the repo.
- **No HTML page yet.** The build produces only `.js` and `.wasm`; a page with a canvas is needed to host them.
- **Networking.** Browsers cannot open UDP sockets. `-DNETWORKING=OFF` builds cleanly (round 3) and is the likely starting point.
- **Size.** The 13 MB `.wasm` is an `-O2 -g` build. Size without debug info was not measured.
- **Warnings were hidden** (`-w`) in every round, so there is no warning list for the web compiler. The three possible buffer overruns from ticket 1 are still open.

### Focus events upstream (for session 3)

- **Commit `6d135b8`** (Cameron Cawley, 2023-06-17, "Implement window focus events with SDL 1.2") adds 10 lines to `common/wwkeyboard_sdl1.cpp` and nothing else. In the SDL 1.2 event loop it handles `SDL_ACTIVEEVENT`: when the `SDL_APPINPUTFOCUS` bit is set it calls `Focus_Restore()` on gain and `Focus_Loss()` on loss.
- **It copies what the SDL2 backend already did.** Commit `69976a2` (Toni Spets, 2020-12-01, "Manage focus in SDL2 windowed mode") is the real design. `common/wwkeyboard_sdl2.cpp:86-98` maps window events `EXPOSED`, `RESTORED`, `FOCUS_GAINED` to `Focus_Restore()` and `HIDDEN`, `MINIMIZED`, `FOCUS_LOST` to `Focus_Loss()`. A web build uses the SDL2 backend, so this is the path that matters.
- **The pattern:** the keyboard backend (the only place that reads SDL events) translates a platform event into two game-level calls. The backend declares them (`void Focus_Loss(); void Focus_Restore();` at the top of the file) and each game defines them.
- **Red Alert's handlers** are in `redalert/winstub.cpp:79` and `:89`. Loss: `GameInFocus = false`, pause movie audio, suspend the music, stop the sound buffer. Restore: `GameInFocus = true`, resume movie audio, flag the whole map for redraw, restart the sound buffer.
- **Who reads `GameInFocus`:** `common/wwmouse.cpp:174` (skip cursor drawing), `common/gbuffer.cpp:273` (refuse to lock the screen surface), `common/soundio_common.cpp:1118` (skip sound upkeep), `redalert/theme.cpp:197` (do not start the next music track).
- **Watch out for session 3:** `Bootstrap()` at `redalert/init.cpp:2412-2414` loops on `Keyboard->Check()` until `GameInFocus` is true. In a browser a loop like that never lets the page handle events, so if the tab starts without focus it would hang. Not tested; noticed while reading.
- Not checked yet: which browser events Emscripten's SDL2 turns into `FOCUS_LOST` / `HIDDEN` (tab switch, window blur).
