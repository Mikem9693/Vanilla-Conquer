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

## Session 3: First run in a browser (ticket 3)

Goal: Red Alert main menu in Chrome, using Emscripten's Asyncify so the game's waits hand control back to the browser. C++ changes are allowed if small and web-only.

**Result: the main menu renders and the cursor follows the mouse in headless Edge 157 (Chromium), with no error output, and the page survives a simulated focus loss and return. Asyncify was enough; no main-loop restructuring was needed. Movies are skipped in the web build. The owner then confirmed it in a normal Edge window, including the focus test. Ticket 3 acceptance is met, apart from one console line that comes from the test server, not the game.**

### C++ source changes

Every C++ change made for the web build, with the reason. Both are web-only (`__EMSCRIPTEN__`).

| # | File | Change | Reason |
|---|---|---|---|
| 1 | `common/mssleep.h` | `ms_sleep` and `us_sleep` call `emscripten_sleep` (microseconds rounded up to milliseconds); includes `<emscripten.h>`. 12 lines added, 2 removed. | Emscripten's `nanosleep` is a busy-wait on the browser's main thread (`system/lib/pthread/library_pthread_stub.c` in Emscripten 7.0.0), so the page would freeze. `emscripten_sleep` pauses the C++ code and lets the browser draw and deliver input. |
| 2 | `redalert/conquer.cpp` | `Play_Movie` returns at once in web builds (`#elif defined(__EMSCRIPTEN__)` branch). 6 lines added. | The movie player locks up the tab, see "The hang" below. The owner ranked intro graphics and sound as the lowest priorities and allowed removing them. |

Held back, not needed so far: a web-only yield in `Frame_Limiter()` (`common/framelimit.cpp`) for frames that take longer than the frame limit.

### The hang (first browser test)

The owner's first test in Edge: the game "crashes if anything else happens on screen", refresh does not help, console blank. That is a locked-up tab, not a crash: a loop that never returns to the browser, so nothing can be drawn, logged or reloaded.

Found with a watchdog in a test page (see "Test method") that records the C++ call stack when the page has not yielded for 3 seconds. The stack: `Init_Game` → `Play_Movie` → `VQA_Play` → `VQA_LoadFrame` → `VQA_CopyAudio`. With `PlayIntro=no` the game still plays the short logo movie at start-up (`redalert/init.cpp:317-320`). Two loops in the movie player never yield:

- **`VQA_Play` (`common/vqatask.cpp:114-165`)** spins while it waits for the audio buffer to drain. Emscripten's OpenAL feeds audio from a browser timer (`setInterval` in `src/lib/libopenal.js`), which cannot fire while the loop spins, so the wait never ends. Reproduced: the page stopped responding about 2 seconds after load, every run.
- **`VQ_Call_Back` (`redalert/conquer.cpp:3222`)**: `while (!GameInFocus) Check_For_Focus_Loss();`. If the page loses focus during a movie, this spins and the event that restores focus can never arrive. Read from the code, not reproduced separately; it matches the owner's description.

To bring movies back later: yield inside both loops (a few lines each), and deal with the browser blocking audio until the first click, because the movie waits for its audio.

### CMake changes

Top-level `CMakeLists.txt`, inside the existing `if(EMSCRIPTEN)` block, 19 added lines:

1. Link options: `-sASYNCIFY=1` (lets `emscripten_sleep` pause and resume the game), `-sASYNCIFY_STACK_SIZE=65536` (default is 4 KB), `-sSTACK_SIZE=8MB` (default is 64 KB; native Linux gives 8 MB), `-sALLOW_MEMORY_GROWTH=1`.
2. `CMAKE_EXECUTABLE_SUFFIX` set to `.html`, so Emscripten also writes `vanillara.html`, its stock page with a canvas. No HTML file is added to the repo.
3. New option `WEB_DATA_DIR`, empty by default. When set, the build packages that folder into `build-web/vanillara.data`, together with a generated `build-web/web_data/REDALERT.INI`. Without it nothing is packaged.

The generated INI sets `[Video] Windowed=yes`, `[Mouse] RawInput=no` (the default would ask the browser for pointer lock) and `[Intro] PlayIntro=no` (the default makes `Select_Game` skip the menu and start a new game, `redalert/init.cpp:602`).

`-sASSERTIONS=1` (clearer runtime error messages) was used for the first builds and then removed: it prints one harmless line on the error stream at start-up (`emscripten_set_main_loop_timing: Cannot set timing mode for main loop...`, from `src/lib/libeventloop.js`), which would show as an error in the console. To debug with it, add `-DCMAKE_EXE_LINKER_FLAGS=-sASSERTIONS=1` to the configure command.

### Commands

```sh
source ~/emsdk/emsdk_env.sh

# Configure, pointing WEB_DATA_DIR at the demo data (local testing only).
emcmake cmake -S . -B build-web -DBUILD_VANILLATD=OFF "-DVC_CXX_FLAGS=-w;-ferror-limit=0" -DWEB_DATA_DIR=$HOME/ra-data/demo

# Build. About 27 seconds from scratch, 8 to 24 seconds after a small change.
cmake --build build-web --target VanillaRA -j16 > build-web/build-N.log 2>&1

# Serve build-web/ to this machine only, then open http://localhost:8000/vanillara.html.
python3 -m http.server 8000 --bind 127.0.0.1 --directory build-web
```

After a rebuild, reload the page with Ctrl+Shift+R. A plain refresh can reuse the old files, because this simple server does not tell the browser how long to keep them.

### Build result

| | Session 2 | Session 3 |
|---|---|---|
| Errors | 0 | 0 |
| `vanillara.wasm` | 13.2 MB | 14.3 MB |
| `vanillara.js` | 430 KB | 455 KB |
| `vanillara.html` | none | 22 KB |
| `vanillara.data` | none | 24.4 MB (`MAIN.MIX`, `REDALERT.MIX`, `REDALERT.INI`) |

Networking is still compiled in, as in session 2 round 2. The native build still compiles with 0 errors after both C++ changes.

### Game data safety

- `git check-ignore -v` confirms the `/build*` rule covers `build-web/vanillara.data` and `build-web/web_data/REDALERT.INI`.
- The data is read from `~/ra-data/demo` at link time; nothing is copied into the repo.
- Both test servers bind to `127.0.0.1`, so only this machine can reach them.
- **`build-web/` must never be committed, uploaded or deployed while `vanillara.data` is in it.**

### Test method

There is no browser inside WSL, so the tests ran in the Windows Edge (157) started from WSL in headless mode (no window) with a throwaway profile folder. A test page and a small Python server, both kept outside the repo, load the same `vanillara.js` and report back: console and error output, focus events, a heartbeat every 500 ms (a gap means the page was stuck), pictures of the canvas, and the watchdog described above. Mouse moves and focus changes were simulated by script, so they are not the same as a person doing them.

### Acceptance results

Headless Edge, final build:

| Check | Result |
|---|---|
| Main menu renders | Yes, within 3 seconds of loading. |
| Mouse moves the cursor | Yes. Simulated moves to three positions; the cursor was drawn at each. |
| No errors | Yes. Nothing on the error stream, no JavaScript errors, no heartbeat gap after loading. Messages the browser itself writes to the console (for example the audio notice below) were not captured by this method. |
| Focus test | Simulated: page hidden and unfocused for 10 seconds, then restored. No hang. The menu stayed on screen, and the cursor followed the mouse both while unfocused and after the return. Sound was not checked. |

Owner's test, normal Edge window, `http://localhost:8000/vanillara.html`, final build:

| Check | Result |
|---|---|
| Main menu renders, game responds | Yes, "appearing to work fine". |
| Console | One red line about a file not found and one yellow line about the audio context. Exact text not recorded; they match the two expected lines below (the `favicon.ico` 404 from the test server and the browser's audio notice). To be confirmed by reading the red line next session. |
| Focus test (switch tabs, come back) | The game appears to pause, with no audio, and picks up where it left off on return. |

Expected console lines that do not come from the game: a 404 for `favicon.ico` (the test server has none) and the browser's notice that audio cannot start before the first click.

### Where the game finds its files in the browser

No path code was changed. `argv[0]` is `./this.program` and the working folder is `/`, so `PathsClass::Init` (`common/paths.cpp`) looks in `/`, finds `REDALERT.MIX` and `REDALERT.INI` there, and uses `/` as both data and user folder. Confirmed by the run: the title art and menu come from the packaged files.

### Problems and things to know

- **Movies are off in the web build**, including mission briefings. See "The hang".
- **Other focus-wait loops of the same kind remain:** `Bootstrap()` at `redalert/init.cpp:2412-2414` (start-up; not reached in testing because the game starts in focus) and two in `redalert/netdlg.cpp` (network dialogs). Each would lock the tab if reached without focus.
- **Sound was not tested.** Browsers block audio until the first click or key press; Emscripten resumes it on that event.
- **Loops that wait on the clock without yielding** (`Delay()` in `common/delay.cpp`, palette fade waits) end on their own but stall the page for their duration. Not seen as a problem at the menu.
- **Nothing past the main menu has been tried.**
- **`grep` in this shell is a wrapper function that silently skipped some source files** (for example `redalert/conquer.cpp`, which contains a few bytes in an old Windows encoding). Searches of this repo should use `grep -a`. An early search for focus loops missed `conquer.cpp` and `netdlg.cpp` because of this.
- The three compiler warnings from ticket 1 were not involved; no memory error was seen.

### Hand-off (end of session 3)

State: four files changed and **not committed**: `CMakeLists.txt`, `common/mssleep.h`, `redalert/conquer.cpp`, `SPIKE.md`. Both test servers are stopped. `build-web/` holds the final build including the packaged demo data.

Owner's priorities, stated this session: sound is the lowest priority, intro graphics the second lowest; both may be removed if they get in the way of gameplay.

To pick up:

1. Rebuild and serve with the commands above if `build-web/` is gone.
2. Confirm the red console line is the `favicon.ico` 404 (hover or click it in the console). An empty `build-web/favicon.ico` would silence it.
3. Decide whether to commit the session 3 changes.
4. Next step for the port: start the first demo mission from the menu and see how far it gets. Expect new hangs of the same kind (loops that wait without yielding); the watchdog below finds them quickly.

Test tools, kept in `build-web/probe-tools/` (ignored by git, lost if `build-web/` is deleted):

```sh
# Server on port 8001: serves build-web/ plus /probe.html, writes reports and pictures to the last folder.
python3 build-web/probe-tools/probe_server.py build-web build-web/probe-tools/probe.html /tmp/vc-probe-out 8001

# Headless Edge from WSL with a throwaway profile. script= steps are milliseconds:action
# (shot-NAME, mouse@X@Y, blur, focus, hide, show). watchdog=3000 records the C++ stack after 3 s without a yield.
timeout 32 "/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  '--user-data-dir=C:\Users\mikem\AppData\Local\Temp\vc-probe' --no-first-run --window-size=900,700 \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling \
  "http://localhost:8001/probe.html?run=t1&watchdog=3000&script=3000:shot-03s,6000:mouse@320@200,7000:shot-07s"
```

Afterwards stop only that Edge instance (match `vc-probe` in the process command line, never all of `msedge.exe`) and delete the profile folder. The same probe page also works in a normal browser window and reports what it sees to the server.

## Session 4: Phase 0 result and game data decision

### Owner's play test

Reported by the owner, in a browser, on the session 3 build. Which browser was not stated, and no console output was recorded.

| Check | Result |
|---|---|
| First demo mission | Played to completion, no crashes or hangs. |
| Sound and music | Both played. |
| Focus test (switch tabs, come back) | The game paused and resumed where it was on return. |

Result: this meets the phase 0 goal. It also closes two "not tested" items from session 3: "Sound was not tested" and "Nothing past the main menu has been tried".

### The strupr workaround replaced (build blocker 3)

Session 2's blocker 3 is now fixed properly, not routed around.

| # | File | Change | Reason |
|---|---|---|---|
| 1 | `common/wwstd.h` | The `strupr` helper is wrapped in `#ifndef __EMSCRIPTEN__` / `#endif`, with a one-line comment. 3 lines added, none removed. | Emscripten's libc already declares `strupr` (`system/include/compat/string.h`) and defines it (`system/lib/libc/compat/strupr.c`). Its version does the same thing as the helper: upper-cases the string in place and returns the same pointer. |
| 2 | `CMakeLists.txt` | The 6-line `SPIKE WORKAROUND` block (the generated `web_shim.h` and the `-include` option) is deleted. Everything else in the `if(EMSCRIPTEN)` block is unchanged. | No longer needed after change 1. |

Note for future edits: `common/wwstd.h` is not valid UTF-8 (a few bytes in an old Windows encoding), so it was changed with a small `python3` script that reads and writes bytes. The file went from 7472 to 7548 bytes, exactly the three added lines.

Results:

| Check | Result |
|---|---|
| Native build (`cmake --build build -j16`) | 0 errors. The same 3 warnings as ticket 1 (`redalert/house.h:991`, `redalert/score.cpp:1663`, and a string-overflow warning reported through glibc's `string_fortified.h`), none in the changed files. |
| Web build (reconfigured with the session 3 command, then target `VanillaRA`) | 0 errors, 268 objects, links. `vanillara.wasm` 14,291,949 bytes, `vanillara.js` 454,611 bytes. |
| Leftovers of the workaround | No compile flags or dependency records mention `web_shim.h` any more. The stale `build-web/web_shim.h` was deleted. |
| Headless Edge smoke test (session 3 probe tools) | Main menu renders, cursor drawn at the scripted position. No stderr, abort, error or watchdog entries. Largest heartbeat gap after start-up: 515 ms. |

Two small things to know:

- Headless Edge reported version 156 in this run (session 3 recorded 157).
- `timeout` ends only the Edge launcher. The Edge processes using the `vc-probe` profile keep running and have to be stopped afterwards by matching `vc-probe` in the command line (this run left 9).

### Game data loading decision (12 Nov 2026)

The owner's decision, also recorded in `CLAUDE.md`:

- Two data routes:
  1. Hosted: fetch the 2008 freeware Red Alert data from a separate hosted location (not this repo), for instant play.
  2. Player-supplied: the player picks their own files.
- Either route stores the data in IndexedDB (the browser's built-in database for a site's own data), so it loads instantly on later visits.
- The data source is a setting, so the hosted route can be switched off without code changes.
- The full game has two `MAIN.MIX` files (Allied and Soviet discs) with the same name; the loader must handle both.
- Rules (unchanged): no game data ever goes in this repo or in committed build output. The packaged demo in `build-web/` is for local testing only.
- Not in scope yet: building the loader. It will be its own ticket in phase 2.

The `WEB_DATA_DIR` option from session 3 stays as it is, as the local-testing route.

### Correction to the session 3 hand-off

The hand-off lists `redalert/conquer.cpp` as not committed. That change is committed, in `1df12dd`. Checked with `git log --oneline -3 -- redalert/conquer.cpp`, which shows `1df12dd` as the latest commit for that file.

Uncommitted files at the time of writing (`git status --short`), apart from this session's own edits to `CLAUDE.md` and `SPIKE.md`: `CMakeLists.txt`, `common/mssleep.h` and `common/wwstd.h` (the `strupr` fix below). `SPIKE.md` was already modified before this session.

### Findings for the phase 2 loader ticket (read from code, not tested)

- **The game takes its data folder and user folder from the working folder.** In the browser `argv[0]` is `./this.program` (`~/emsdk/upstream/emscripten/src/shell.js:133`). `PathsClass::Argv_Path` (`common/paths_posix.cpp:257`) turns that into the full path of the working folder. `PathsClass::Init` (`common/paths.cpp:58` and `:76`) then uses that folder when it finds `REDALERT.INI` and `REDALERT.MIX` there (the names are passed in from `redalert/startup.cpp:292`). So a loader can point the game at its files by changing the working folder before `main()` runs, with no change to path code. A `[Paths] DataPath=` or `UserPath=` entry in the INI overrides this (`common/paths.cpp:93` and `:102`).
- **`REDALERT.MIX` and `MAIN.MIX` are opened by fixed name** (`redalert/init.cpp:2301` and `:2343`). This is why two discs' `MAIN.MIX` files with the same name need special handling.
- **File lookups ignore letter case.** `RawFileClass::Set_Name` (`common/rawfile.cpp:179`) calls `Resolve_File` (`common/file.cpp`), which matches names on disk with `fnmatch` and `FNM_CASEFOLD` (`common/file_posix.cpp:79`).
- **Emscripten 7.0.0's IndexedDB file system (IDBFS) has an `autoPersist` mount option** (`~/emsdk/upstream/emscripten/src/lib/libidbfs.js:71`). IDBFS is Emscripten's file system that saves files into IndexedDB. With `autoPersist`, file changes in that folder are saved to IndexedDB automatically, without the program calling `FS.syncfs` itself.

### The red console line (session 3 open item)

The owner's line, verbatim: "Failed to load resource: the server responded with a status of 404 (File not found)". Which URL it points at was not stated.

What the page loads, read from `build-web/vanillara.html` and `build-web/vanillara.js`: the page loads `vanillara.js`, which fetches `vanillara.wasm` and `vanillara.data`. All three files exist in `build-web/`. There is no source map or worker file. The Emscripten logo is built into the page, so it is not a separate request.

Live check: `python3 -m http.server 8002 --bind 127.0.0.1 --directory build-web` with its request log saved, and headless Edge (throwaway `vc-probe` profile) opening the stock page `http://localhost:8002/vanillara.html` for about 10 seconds.

| Request | Before | After adding `build-web/favicon.ico` |
|---|---|---|
| `/vanillara.html` | 200 | 200 |
| `/vanillara.js` | 200 | 200 |
| `/vanillara.data` | 200 | 200 |
| `/vanillara.wasm` | 200 | 200 |
| `/favicon.ico` | **404**, server message "File not found" | 200 |

Observed:

- Headless Edge requested `/favicon.ico` by itself; the page does not ask for it. It was the only 404.
- Python's server answers that request with 404 "File not found", the same words as in the owner's line.

Inferred, not seen: that the owner's red line in a normal Edge window comes from the same request. Nobody saw which URL the owner's line points at, and the owner's server on port 8000 was not checked.

Done: created an empty `build-web/favicon.ico`. This is build output, ignored by git (`git check-ignore` matches `/build*` in `.gitignore`), and it is lost if `build-web/` is deleted. After that, a fresh run with a new profile got 200 for all five requests and no 404. The second run has to use a new profile: when the profile was reused, Edge took the other four files from its cache and only requested `/favicon.ico`.

### Hand-off (end of session 4)

State: five files changed and **not committed**: `CLAUDE.md`, `CMakeLists.txt`, `SPIKE.md`, `common/mssleep.h`, `common/wwstd.h` (checked with `git status --short`). Nothing was committed this session.

Open items:

1. Decide whether to commit.
2. Owner to re-check the rebuilt page in a normal browser window: hard reload with Ctrl+Shift+R, then start a mission.
3. The red console line from session 3: the only 404 the page causes is the browser's own request for `/favicon.ico`, now answered by an empty `build-web/favicon.ico`. Owner to confirm the red line is gone after a hard reload (Ctrl+Shift+R).
4. The phase 2 loader ticket.
