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

## Session 4a: Skirmish with full game data (ticket 4a)

Goal: a skirmish against the AI works natively and in the browser, and we know the smallest data set a skirmish needs.

The owner's release priority, stated on 13 Nov 2026:

1. Hostable skirmish.
2. Multiplayer.
3. Campaigns.

Data used: the Allied disc of the 2008 freeware release, in `~/ra-data/full/allied/disc` (`MAIN.MIX` at the root, `REDALERT.MIX` in `INSTALL/`). As before, nothing from it goes in the repo.

| Step | What | Status |
|---|---|---|
| 1 | Native skirmish | Done: owner's play test passed (13 Nov 2026) |
| 2 | Smallest data set a skirmish needs (data-size study) | Done (investigation only; candidate set reaches the menu natively, skirmish not yet played with it) |
| 3 | Skirmish in the browser | Skirmish runs for 10+ minutes in the owner's browser, then a crash (diagnosed from the crashed build, not reproduced, not fixed) |

### Step 1: native skirmish

#### Set-up (all outside the repo)

- **Data folder:** `~/ra-data/skirmish-full/` holds two symbolic links (pointers to the original files, not copies):
  - `MAIN.MIX -> ~/ra-data/full/allied/disc/MAIN.MIX`
  - `REDALERT.MIX -> ~/ra-data/full/allied/disc/INSTALL/REDALERT.MIX`

  The game's file lookup works through the links (observed).
- **Config file:** in `~/.config/vanilla-conquer/vanillara/redalert.ini` only the `DataPath` line changed, from `/home/mikem93/ra-data/demo` to `/home/mikem93/ra-data/skirmish-full` (a one-line diff). The old file is kept beside it as `redalert.ini.demo-backup`. To go back to the demo data, restore that line or the backup.

#### Commands

```sh
# Make the data folder and link the two archives into it (no copying).
mkdir -p ~/ra-data/skirmish-full && ln -s ~/ra-data/full/allied/disc/INSTALL/REDALERT.MIX ~/ra-data/skirmish-full/REDALERT.MIX && ln -s ~/ra-data/full/allied/disc/MAIN.MIX ~/ra-data/skirmish-full/MAIN.MIX

# Rebuild the native game. Incremental: only changed files are recompiled, no reconfigure.
cmake --build build -j16

# In ~/.config/vanilla-conquer/vanillara/: keep a copy of the INI (-p keeps its date),
# then point DataPath at the new folder. \r is there because the file has Windows line endings.
cp -p redalert.ini redalert.ini.demo-backup
sed -i 's|^DataPath=/home/mikem93/ra-data/demo\r$|DataPath=/home/mikem93/ra-data/skirmish-full\r|' redalert.ini

# Smoke test: start the game and stop it after 20 seconds.
timeout 20 ./build/vanillara
```

#### Results

| Check | Result |
|---|---|
| Native build | Exit 0, 0 errors, 0 warnings reported. It recompiled `common` and relinked `build/vanillara`. |
| Smoke test (observed) | Exit code 124: still running when the 20 second timer fired. Output was only the known PipeWire notice (two `pw.conf` lines and one `[ALSOFT]` line). No process left behind. Nobody saw the window, so which screen it reached is not known. |

#### The skirmish map list

Observed with a read-only checker program, built outside the repo against `build/common/libcommon.a`. It registers the MIX files in the same order as `Init_Bootstrap_Mixfiles` / `Init_Secondary_Mixfiles` and reads `MISSIONS.PKT` the way `Read_Scenario_Descriptions` does.

- `MISSIONS.PKT` (795 bytes) is inside `GENERAL.MIX`, which is itself inside `MAIN.MIX`.
- Its `[Missions]` list has 24 entries, and all 24 scenario files are found: `SCM01EA` to `SCM24EA`, all in `GENERAL.MIX`.

Read from code:

- `Read_Scenario_Descriptions` (`redalert/session.cpp:743`) is called once at start-up, from `SessionClass::One_Time` (`session.cpp:248`).
- It also scans for loose `*.MPR` map files (`:773-800`, `:839-866`). There are none.
- `CSTRIKE.PKT` and `AFTMATH.PKT` (the expansion map lists) are only read when `EXPAND.MIX` / `EXPAND2.MIX` exist (`:809`, `:827`). They do not.

Expected, not yet seen on screen: all 24 maps appear in the skirmish dialog (`redalert/nulldlg.cpp:1709-1737`).

#### What the two archives contain

Observed with the checker. Sizes come with step 2.

| Archive | Contains |
|---|---|
| `REDALERT.MIX` | `LOCAL.MIX`, `LORES.MIX`, `HIRES.MIX`, `SPEECH.MIX` |
| `MAIN.MIX` | `CONQUER.MIX`, `GENERAL.MIX`, `MOVIES1.MIX`, `SCORES.MIX`, `SOUNDS.MIX`, `RUSSIAN.MIX`, `ALLIES.MIX` |

`RULES.INI` is in `LOCAL.MIX`.

#### CD checks

The original game asks for a specific disc at some points. Read from code, plus the smoke run not exiting at start-up: nothing on the skirmish path asks for a disc, and no second disc is needed.

- `Init_CDROM_Access` sets `RequiredCD` from `Force_CD_Available(-1)` (`redalert/init.cpp:2229`).
- The active `Force_CD_Available` is the `FIXIT_VERSION_3` one at `redalert/conquer.cpp:3813-3831`. It goes through `Change_Local_Dir` (`conquer.cpp:3710`), which accepts the data folder itself.
- `Read_Scenario_INI` uses `RequiredCD = -1` (any disc) for non-campaign games unless the map is from an expansion (`redalert/scenario.cpp:2071-2085`, check at `:2120`).
- Missing optional archives, all harmless by the code: `MOVIES2.MIX` (`MOVIES1.MIX` is used, `init.cpp:2355`), `EXPAND.MIX`, `EXPAND2.MIX`, `HIRES1.MIX`.
- `Is_Demo` is false because `DEMOPIC.PCX` is absent (`conquer.cpp:4608`, file check at `:4614`), so the full menu shows.

Not checked at run time: that `Change_Local_Dir` behaves as read.

#### Movies

Read from code, data observed:

- **The Red Alert logo movie now plays at every native launch, even with `PlayIntro=no`.** `init.cpp:317-320` calls `Play_Intro()`, which plays `REDINTRO` (`init.cpp:1227-1230`), and `REDINTRO.VQA` is in `MOVIES1.MIX`. The demo did not have it. Esc skips it.
- **No movie plays at skirmish start.** All 24 maps set `Intro`, `Brief`, `Win`, `Lose` and `Action` to `<none>` (observed with the checker). The start-of-mission calls are at `scenario.cpp:376-410`.
- **At skirmish end** the game shows a score screen and returns before any movie (`scenario.cpp:920-931`). The win movie calls come after that, at `scenario.cpp:937-940`; the lose movie call is at `:1207`.

None of this was seen on screen.

#### Menu path to a skirmish

Read from code:

1. Main menu, "Multiplayer Game" (`redalert/menus.cpp:604`).
2. "Skirmish" (`redalert/mplayer.cpp:155`, `:319-323`), which opens `Com_Scenario_Dialog(true)` (`nulldlg.cpp:1337`).
3. In that dialog the AI players gauge is forced to at least 1 (`nulldlg.cpp:1694`). OK starts the game (`nulldlg.cpp:2124-2141`).

#### Blockers and risks

| # | Item | Evidence | Workaround or fix | Size |
|---|---|---|---|---|
| 1 | Skirmish music might start silent. Predicted from the code, not seen in the owner's play test; cause of the difference not investigated (see "Owner's play test"). | Read from code: when a skirmish starts, `Options.ScoreVolume = Options.MultiScoreVolume` (`init.cpp:892`). `MultiScoreVolume` defaults to "0" (`redalert/options.cpp:94`, read at `:573`), and the INI has `MultiplayerScoreVolume=0`. Observed: the owner heard music without touching the slider. | If music is silent: raise the Music slider in the in-game sound controls, which saves the value; or set `MultiplayerScoreVolume` in the INI. Not a code blocker. | None (setting) |
| 2 | Logo movie at every native launch. | See Movies. | None needed: Esc skips it. Movies are already skipped in the web build. | None |
| 3 | The game rewrites the whole INI when options are saved. | `session.cpp:640-656`, `options.cpp:735`. | `DataPath` has survived this before, and the backup exists. | None |

Note for step 3: the web build's generated INI will have the same default (`MultiplayerScoreVolume` not set, so 0). From the code this predicts silent skirmish music there too, but the same prediction was not borne out in the owner's native play test, and the cause of the difference has not been investigated. The step 3 worker has been told. Check whether music plays in the browser rather than assume either way.

#### Things to know

- **The INI uses Windows line endings (CRLF),** so each line ends in an invisible `\r` before the newline. A `sed` pattern ending in `demo$` matched nothing; the pattern has to allow for the `\r`, as in the command above.

#### Owner's play test

Native build `./build/vanillara`, full Allied data in `~/ra-data/skirmish-full`, 13 Nov 2026. The owner followed a play-test script: Esc past the logo movie; Multiplayer Game, Skirmish; check the map list; start a skirmish against one AI; raise the Music slider; play 5 minutes; quit and check the exit code.

The owner's report, verbatim: "Play test completed with zero errors - launch video was still included which is expected to cause hangs if kept on browser version".

The owner's second report, answering follow-up questions, verbatim: "Skrimish map looked complete - large list of maps. Sound effects all worked as expected, music was playing without manual intervention game exited cleanly by following usual route (menu - exit)".

The table records only what was reported.

| Check | Result |
|---|---|
| Logo movie at launch | Played (observed by the owner), as step 1 predicted from the code |
| Skirmish map list shows maps | Yes, "large list of maps". The exact count was not reported (24 expected) |
| Skirmish against one AI starts | Not reported separately; covered by the first report ("completed with zero errors") |
| Plays for 5 minutes | Not reported separately; covered by the first report ("completed with zero errors") |
| Sound | Yes, sound effects "all worked as expected" |
| Music | Yes, without raising the Music slider |
| No crash | Yes |
| Exit | Clean, through the menu's exit. The exit code number was not reported |

Result: step 1 acceptance is met, as reported by the owner.

**Discrepancy: music played, although step 1 predicted silence.** Step 1 predicted from the code that skirmish music starts silent: `MultiplayerScoreVolume=0` in the INI, copied to `ScoreVolume` when a skirmish starts (`init.cpp:892`; see "Blockers and risks", row 1). The owner heard music without touching the slider. Checked after the play test (observed): the game rewrote `redalert.ini` at 00:44 on 13 Nov (1247 bytes before, 1545 after), and it still has `ScoreVolume=0.25` and `MultiplayerScoreVolume=0`, with `DataPath` unchanged. So the prediction from the code was not borne out. The reason is not known; it has not been investigated.

Update from step 3: in the browser the setting does matter. Observed: with `MultiplayerScoreVolume=0.00` there was no in-game music stream; with `0.25` there was (see step 3, "Source changes"). The native difference is still unexplained. One candidate explanation, **a guess that has not been checked**: `Main_Menu` raises a zero music volume to 0.4 for the menu and restores it on exit (`redalert/menus.cpp:690-693`, `:959`), and the menu track (`INTRO.AUD`) is in `LOCAL.MIX`, so music at the menu plays regardless of the setting. If so, the owner may have heard menu music and not skirmish music. Whether the owner's music was in the skirmish itself has been asked.

**The owner's concern about the launch video, for step 3.** The logo movie will not play or hang in the browser:

- The web build already skips every movie. `Play_Movie` returns at once in web builds (session 3, C++ change 2; the `__EMSCRIPTEN__` branch at `redalert/conquer.cpp:2369-2374`). The logo movie goes through `Play_Movie` too (`Play_Intro`, `init.cpp:1230`).
- The trimmed skirmish data set from step 2 does not contain the movie archive (`movies1.mix`) at all.
- Bringing movies back in the browser would need the two yields described in session 3, "The hang".

### Step 2: data size

Question: what is the smallest set of data files a skirmish needs? Investigation only; no repo files changed.

**Result: a trimmed pair of archives of 17,711,278 bytes (16.9 MiB), against 479.7 MB for the full Allied disc pair, reaches the main menu natively. No skirmish has been played with it yet.** Adding all the music brings it to 81,882,638 bytes (78.1 MiB).

#### Tool: vanillamix

`vanillamix` is the project's own MIX archive tool (`tools/mixtool/`). It was built in `build-tools/`, which is ignored by git (the `/build*` rule, confirmed with `git check-ignore -v build-tools/x`).

```sh
# Configure and build only the tools: no games, no tests. 0 errors, 0 compiler warnings.
cmake -B build-tools -DBUILD_TOOLS=ON -DBUILD_VANILLATD=OFF -DBUILD_VANILLARA=OFF -DBUILD_TESTS=OFF . && cmake --build build-tools -j8
```

Later the same folder was reconfigured with `-DBUILD_VANILLARA=ON`, to get a private copy of the game (`build-tools/vanillara`) for smoke tests without touching `build/`. 0 errors, the same 3 known warnings.

Usage:

- `vanillamix -l <mix>` lists an archive.
- `vanillamix -x -d <dir> <mix>` unpacks it into a folder.
- `vanillamix -c -d <dir> <out.mix>` packs a folder into a new archive. The result is plain (not encrypted). The tool lowercases the output name, so results were renamed to upper case.

MIX archives store a number computed from each file name (a hash), not the name itself. The tool has a built-in list of known names (`tools/mixtool/mixnamedb_data.cpp`); an entry it cannot name is shown as its hash.

#### What is inside the two archives

Observed with `vanillamix -l`. MiB is 1,048,576 bytes.

`MAIN.MIX`, 454,605,294 bytes (entries total 454,605,058, plus a 236-byte encrypted header; exact):

| Inner archive | Bytes | MiB |
|---|---|---|
| `movies1.mix` | 369,362,336 | 352.25 |
| `scores.mix` | 64,171,360 | 61.20 |
| `general.mix` | 14,932,344 | 14.24 |
| `conquer.mix` | 2,177,047 | 2.08 |
| `temperat.mix` | 1,038,859 | 0.99 |
| `snow.mix` | 1,030,861 | 0.98 |
| `sounds.mix` | 1,006,778 | 0.96 |
| `allies.mix` | 309,406 | 0.30 |
| `russian.mix` | 266,077 | 0.25 |
| `interior.mix` | 247,425 | 0.24 |
| `edhi.mix` | 54,335 | 0.05 |
| `edlo.mix` | 8,230 | 0.01 |

`REDALERT.MIX`, 25,046,328 bytes (entries total 25,046,164, plus a 164-byte header; exact):

| Inner archive | Bytes | MiB |
|---|---|---|
| `nchires.mix` | 11,990,198 | 11.43 |
| `hires.mix` | 5,817,417 | 5.55 |
| `local.mix` | 3,829,837 | 3.65 |
| `speech.mix` | 2,003,464 | 1.91 |
| `lores.mix` | 754,800 | 0.72 |
| `editor.mix` | 650,448 | 0.62 |

Entries the tool could not name: one in `movies1.mix` (hash `18FF53F1`, 20.3 MB, almost certainly a movie), and hash `27FF53F1` listed twice in `nchires.mix` (1.6 MB each). None of them is in the trimmed set.

#### Which archives a skirmish needs

Contents are observed from the listings. Start-up behaviour and skirmish use are read from code. "Registered" means the game adds the archive to its search list; "cached" means it also loads the whole archive into memory at start-up. Note: `assert` is compiled out in this build type, so the `assert(ok)` after each cache call does not stop the game when an archive is missing.

| Archive | Contents | At start-up (read from code) | Skirmish |
|---|---|---|---|
| `local.mix` | `rules.ini`, palettes, fonts, text strings, `intro.aud` | Registered and cached (`redalert/init.cpp:2307-2309`) | Required |
| `hires.mix` | Sidebar and interface art, `TITLE.PCX`, fonts | Cached when `RESFACTOR` is not 1, the default (`init.cpp:2311-2314`) | Yes |
| `lores.mix` | Low-resolution versions of the above | Only when `RESFACTOR` is 1, i.e. `[Video] DOSMode=yes` (`init.cpp:2317-2320`, `redalert/startup.cpp:332`) | No, with default settings |
| `nchires.mix` | 106 movie palettes (`.vqp`), `english.vqa`, 2 unnamed | Registered, not cached (`init.cpp:2316`) | No. The palettes are used only by `Play_Movie` (`Load_Interpolated_Palettes`, `redalert/conquer.cpp:2259`) |
| `speech.mix` | EVA voice lines (the announcer) | Registered (`init.cpp:2373`) | Optional. Speech playback checks `Is_Available` and stays silent if the file is missing (`redalert/audio.cpp:740-741`, in `Speak_AI`) |
| `editor.mix`, `edhi.mix`, `edlo.mix` | Map editor art | Not referenced by the Red Alert game code | No |
| `conquer.mix` | Unit and building art, score-screen art | Registered (`init.cpp:2349`), cached (`init.cpp:2662`) | Yes |
| `general.mix` | `MISSIONS.PKT`, the 24 `SCM*.INI` skirmish maps, campaign scenario files, `MISSION.INI`, `TUTORIAL.INI`. 12.5 MB of it is campaign map-selection animations (`redalert/mapsel.cpp:116`), the rest low-resolution credits slides (`redalert/egos.cpp:95`) | Registered (`init.cpp:2353`) | Yes, but only `MISSIONS.PKT` and the SCM files (`redalert/session.cpp:756`), plus `MISSION.INI`, read on every scenario load (`redalert/scenario.cpp:2427`), and `TUTORIAL.INI`, read at start-up (`init.cpp:2674`) |
| `temperat.mix`, `snow.mix` | Terrain tiles | Loaded when a map needs that theatre (map climate) (`redalert/display.cpp:371-380`) | Yes. Observed: 11 skirmish maps are temperate, 13 snow, none interior |
| `interior.mix` | Interior tiles | As above | No |
| `sounds.mix` | Sound effects | Registered, and cached when sound is on (`init.cpp:2374`, `:2664`) | Yes for sound. A missing sound just does not play (`audio.cpp:483-490`) |
| `allies.mix`, `russian.mix` | Unit voice replies | Registered, and cached when sound is on (`init.cpp:2375-2376`, `:2665-2666`) | Yes for unit voices; optional |
| `scores.mix` | 21 music tracks | Registered (`init.cpp:2366`). Each track's availability is checked separately (`redalert/theme.cpp:578`), and missing tracks are never chosen (`theme.cpp:480`) | Optional (music) |
| `movies1.mix` | 51 movies plus 1 unnamed | `MOVIES1` if present, else `MOVIES2`; a missing file gives an empty archive object (`init.cpp:2355-2359`, `common/mixfile.h:277`) | No |

Method limit: file names quoted in `redalert/*.cpp` were matched against the archive listings. Everything that exists only in the dropped archives is campaign, credits, movie-palette or DOS-mode material. Names the game builds at run time (with `sprintf`) would not show up in that check.

#### Answers

1. **Movies are not needed for a skirmish** (read from code). `Play_Movie` returns at once when `Session.Type != GAME_NORMAL`, i.e. in any non-campaign game (`conquer.cpp:2392`). It also skips a movie whose `.VQA` is missing (`conquer.cpp:2408`), and the web build skips all movies (`conquer.cpp:2369`). A missing `MOVIES1.MIX` is handled at `init.cpp:2355-2359`. Observed support: the demo data has no `movies1.mix` and already plays a mission. This sharpens step 1's movie note: step 1 found that no skirmish map names a movie; this shows a skirmish would not play one anyway.
2. **The map list needs `general.mix`**, or loose copies of `MISSIONS.PKT` and the SCM files. Without them the list is empty.
3. **A smaller set is possible with no source changes.** Two routes:
   - (b) Rebuild smaller `MAIN.MIX` and `REDALERT.MIX` with `vanillamix`. Supported by the code and the tool: the game reads plain unencrypted archives (`common/mixfile.h:419-430`). The candidate below uses this route.
   - (a) Put the inner archives loose in the data folder. Read from code: `CCFileClass::Open` tries a loose file on disk before looking inside archives (`common/ccfile.cpp:424-425`), and each inner archive is opened by name (`init.cpp:2349-2376`). The catch, read from code and not tested: with no file named `MAIN.MIX` at all, starting a skirmish should fail. A skirmish uses `RequiredCD = -1` (`scenario.cpp:2072-2073`), and `Read_Scenario_INI` exits if `Force_CD_Available` returns false (`scenario.cpp:2120-2124`). That returns true only if a `MAIN.MIX` can be found (`conquer.cpp:3728-3732`, `:3819-3825`) or the game is started with the `-CD.` argument (`init.cpp:1440`, `common/cdfile.h:92`). Mixing the routes works by the code: a small `MAIN.MIX` plus loose optional files such as `SCORES.MIX`.
4. **Size variants:**

| Variant | Bytes | What is lost |
|---|---|---|
| Candidate, without music | 17,711,278 (16.9 MiB) | Music, movies, campaign, interior maps, DOS low-resolution mode |
| Candidate plus all music (`scores.mix`) | 81,882,638 (78.1 MiB) | Movies, campaign, interior maps, DOS mode |
| Candidate without EVA speech | About 15.7 MB (2.0 MB less) | Announcements such as "construction complete". The step 2 worker advises keeping speech |
| Candidate without unit voices | 0.56 MB less | Unit replies |
| Full Allied disc pair, for scale | 479.7 MB | Nothing. Movies are 352 MiB of it, music 61 MiB |

Read from code, not tested: a `SCORES.MIX` with only 2 to 4 tracks (about 3 MB each) should also work, because availability is checked per track.

Updates from step 3:

- **The "few tracks" idea is now tested and works in the browser** (observed): a `SCORES.MIX` of four tracks, 10,386,815 bytes (10.4 MB). See step 3, "Data set".
- **The 17.7 MB no-music candidate works in the browser only with music volume 0.** With music volume above 0 and no in-game track available, the game hangs at skirmish start. See step 3, blocker 1.
- **The menu has music even without `SCORES.MIX`**: the menu track is `INTRO.AUD`, which is in `LOCAL.MIX` (see the classification table).

#### The candidate set

All outside the repo. Both files exist with these sizes, and listing the new `MAIN.MIX` shows its seven inner archives.

| File | Bytes | Inner archives |
|---|---|---|
| `~/ra-data/skirmish-min/MAIN.MIX` | 6,060,518 | `conquer`, `sounds`, `allies`, `russian`, `temperat`, `snow`, and a trimmed `general.mix` (231,400 bytes: `missions.pkt`, `mission.ini`, `tutorial.ini`, `scm01ea.ini` to `scm24ea.ini`) |
| `~/ra-data/skirmish-min/REDALERT.MIX` | 11,650,760 | `local`, `hires`, `speech` |
| `~/ra-data/skirmish-min-music/SCORES.MIX` (optional music) | 64,171,360 | A loose copy of `scores.mix` |

How it was made: unpacked with `vanillamix -x` into `~/ra-data/allied-extract/` (472 MB), the chosen files staged in `~/ra-data/skirmish-min-build/` (18 MB), then packed with `vanillamix -c`.

#### Smoke test of the candidate

```sh
# Run the private game copy for 20 seconds with its own per-user folder, so the owner's config is not touched.
XDG_CONFIG_HOME=~/ra-data/smoke-min/config timeout 20 build-tools/vanillara
```

That folder's `vanilla-conquer/vanillara/REDALERT.INI` sets `DataPath=/home/mikem93/ra-data/skirmish-min`, `Windowed=yes` and `RawInput=no`. `XDG_CONFIG_HOME` is the standard Linux variable for where programs keep settings; the game uses it for its per-user folder (`Get_Posix_Default`, `common/paths_posix.cpp:91`, used at `:203`).

Observed:

- Exit code 124 in each of three runs (without and with a loose `SCORES.MIX`). The log has only the PipeWire notice, no missing-file messages.
- The game was seen reading only the two `skirmish-min` files.
- A baseline run on the full data gave the same result.

Limits: this shows only that the game reaches its menu. No skirmish was started with the trimmed set. It also does not show that a loose `SCORES.MIX` is used: the music file was never seen opened, but the full data did not open its music at the menu within 20 seconds either.

#### Risks and unknowns

| # | Item | Evidence | If it goes wrong | Size |
|---|---|---|---|---|
| 1 | A skirmish has not been played with the trimmed set. Files loaded by names built at run time could be missing. | Judged low risk: the demo already plays a mission with a `conquer.mix` of the same size (2,177,047 bytes). | Add the missing file to the set. | Small |
| 2 | Route (a) (no `MAIN.MIX`, `-CD.` argument) | Read from code only. | Use route (b), which is the candidate. | None for the candidate |
| 3 | The rebuilt archives are unencrypted and differ in size from the originals. | Accepted natively (observed). Not yet tested in the web build. | Unknown until step 3. | Not known |
| 4 | Only the Allied disc was examined. | The Soviet disc's `general.mix` may differ. | Repeat the listing on the Soviet disc. | Small |

#### Things to know

- **`vanillamix` writes a file in the per-user config area.** It always calls `Paths.Init("vanillatools")` (`tools/mixtool/makemix.cpp:553`), and so created `~/.config/vanilla-conquer/vanillatools/filenames.db` (1.1 MB). It is not game data and does not affect the game's own `vanillara/` config folder. To avoid it, run the tool with `XDG_CONFIG_HOME` set to a scratch folder. The file is still there; the owner decides whether to remove it.
- **Leftovers outside the repo:** `~/ra-data/allied-extract` (472 MB), `~/ra-data/skirmish-min-build`, `~/ra-data/smoke-min`, `~/ra-data/smoke-full`, and the `vanillatools` config folder above. Inside the repo: `build-tools/` (ignored by git).

### Step 3: skirmish in the browser

**Result: a skirmish against one AI runs in headless Edge 156 with a 28.1 MB data set that includes music. No hang or crash in about 7.5 minutes of active play, and the game pauses on a simulated tab switch and resumes. One tracked file changed (CMake, one line); no C++ changes. One hang was found, only when no in-game music track is available and music volume is above 0. It is not web-specific and is not fixed (blocker 1).**

All input was simulated by script, and nobody watched or listened live.

#### Data set

`~/ra-data/skirmish-web/`, outside the repo:

| File | Bytes | What |
|---|---|---|
| `MAIN.MIX` | 6,060,518 | Symbolic link to `../skirmish-min/MAIN.MIX` (step 2 candidate) |
| `REDALERT.MIX` | 11,650,760 | Symbolic link to `../skirmish-min/REDALERT.MIX` (step 2 candidate) |
| `SCORES.MIX` | 10,386,815 | New: packed with `vanillamix -c` from four tracks, `vector1a`, `snake`, `smsh226m` and `score` (`.aud`), with `XDG_CONFIG_HOME` pointed at a scratch folder |

`build-web/vanillara.data` is 28,098,196 bytes: the three files (28,098,093) plus the 103-byte generated INI. Emscripten's file packager follows symbolic links (observed: the `.data` size matches the real file sizes exactly; read from the packager: it walks the folder with `os.walk` and reads with `open()`).

Why these tracks (read from `RULES.INI [ThemeControl]` and from code):

- HELL226M, AWAIT, MUD1A, SNAKE, VECTOR1A and SMSH226M are allowed for every side; the rest are Allies-only or Soviet-only.
- `ThemeClass::Is_Allowed` always applies the side limit (`redalert/theme.cpp:494`); the scenario-number limit applies only to campaign play (`theme.cpp:501`).
- Three every-side tracks were taken because shuffle mode needs at least two allowed tracks (`theme.cpp:244-246`: it never picks the track that just played), plus `score.aud` for the end screen. No track is required by name.
- AWAIT can never play: the freeware file is named `await_r.aud`.

Smallest set seen working in the browser: with in-game music, this 28.1 MB set. Without in-game music, the 17.7 MB `skirmish-min`, but only with music volume 0 (blocker 1); it still has menu music.

#### Source changes

Every change to a tracked file for the web build in this ticket. Checked with `git diff CMakeLists.txt`: 1 line added, 1 removed. No C++ source was changed.

| # | File | Change | Reason |
|---|---|---|---|
| 1 | `CMakeLists.txt`, inside `if(EMSCRIPTEN)` / `if(WEB_DATA_DIR)` | The generated `REDALERT.INI` gains an `[Options]` section with `MultiplayerScoreVolume=0.25`, matching the `ScoreVolume=0.25` the game writes. | At skirmish start `Options.ScoreVolume = Options.MultiScoreVolume` (`redalert/init.cpp:892`), whose default is 0. Observed necessary in the browser: run m1 with `MultiplayerScoreVolume=0.00` had no in-game music stream. |

The native build still compiles after the change: `cmake --build build -j8`, exit 0, 0 errors.

#### Commands

```sh
# Put emcc and emcmake on the PATH for this shell.
source ~/emsdk/emsdk_env.sh

# Configure, packaging the skirmish-web data (local testing only).
emcmake cmake -S . -B build-web -DBUILD_VANILLATD=OFF "-DVC_CXX_FLAGS=-w;-ferror-limit=0" -DWEB_DATA_DIR=$HOME/ra-data/skirmish-web

# Build Red Alert only.
cmake --build build-web --target VanillaRA -j8
```

Build result: 0 errors, 1 warning (the usual notice that optimisation is limited because debug info was requested).

| File | Bytes |
|---|---|
| `vanillara.wasm` | 14,291,949 |
| `vanillara.js` | 454,672 |
| `vanillara.html` | 21,964 |
| `vanillara.data` | 28,098,196 |

`git check-ignore -v` shows the `/build*` rule covering the `.data`, the generated INI and the probe tools. As before, **`build-web/` must never be committed, uploaded or deployed while `vanillara.data` is in it.**

#### Acceptance results (headless Edge 156, main run "b1")

| Check | Result |
|---|---|
| Map list shows maps | Observed. Picture `b1-shot-dialog.png`: the Scenarios list shows 11 names with a scroll bar, "A Path Beyond (Lg)" selected; side Russia, AI Players 1, Credits 10000, Bases ticked. |
| Skirmish against 1 AI starts | Observed. In game within 2 seconds of OK (`b1-shot-ok2s.png`): map with the start area revealed, MCV, tanks, infantry, credits counting up to 10000. |
| Runs 5 minutes | Observed. In game from t=34 s to t=545 s; minus 69 s of pauses, about 440 s of active play. Scripted actions worked: MCV deployed into a Construction Yard, a tank moved to the clicked spot twice, Power Plant built and placed, Ore Refinery started (credits 10000, 9730, 9621). `b1-shot-final.png`: Construction Yard, Power Plant, units, credits 9621, Ore Refinery in production in the sidebar. |
| No crash or hang | Observed. No stderr, abort, JavaScript error or watchdog entry. 1049 heartbeats; largest gap 673 ms (start-up), 523 ms at skirmish load. |
| Tab switch pauses and resumes | Observed, simulated. Page hidden and blurred by script for 15 s. Credits stood at 9975 before and while hidden; within 5 s of restore the rest of the Power Plant's cost was spent and it showed READY (`b1-shot-focus-after2.png`: credits 9730, Power Plant READY). Music stopped while hidden and came back. |
| Sound effects and music | Observed as signal only (method below). Not verified: that a person hears it, which track plays, audio in a normal window. |

An unplanned real focus loss: at t=59.8 s headless Edge itself fired a blur and `visibility=hidden` (cause not known). The game paused correctly; a simulated show and focus at t=114 s resumed it fully.

Audio method: a hook on the Web Audio layer (the browser's sound system). Each OpenAL source has its own gain node (volume control), and every 5 s the probe recorded buffers started, seconds of audio and peak level per source.

- Music: after restore, 64 of 72 five-second windows show one source streaming continuously (5.02 s of audio per 5 s, peak 0.6 to 0.9, gain 0.249, matching volume 0.25).
- Sound effects and speech: short bursts on other sources at gains 0.198 and 0.397.

#### Blocker 1: endless loop when no in-game music is available

| | |
|---|---|
| Where | `redalert/theme.cpp:254-258`, the sequential loop in `Next_Song` (the shuffle loop is `:244-246`). Both repeat until `Is_Allowed` is true. Reached from `Theme.AI` (`theme.cpp:197-203`) after `Main_Loop` queues `THEME_PICK_ANOTHER` (`redalert/conquer.cpp:1762-1763`). `ScoresPresent = true` is set unconditionally (`init.cpp:2365`). |
| Kind | A loop that never ends and never yields (hands control back to the browser), when music volume is above 0 and no in-game track is available. Not web-specific: read from code, a native game would freeze the same way. |
| How found | Observed: run n1 (17.7 MB set, volume 0.25): the heartbeat stops right after OK, with no watchdog stack, because the loop never calls into JavaScript. Run n2 (same set, volume 0.00) plays normally. The location comes from code reading plus that difference, not from a stack trace. |
| Likely fix | Return `THEME_NONE` from `Next_Song` when no theme is allowed. Not done: it is not web-only, and it does not affect the accepted set. |
| Size | Small |

Consequence: **any data set shipped without in-game music must either set music volume to 0 or wait for this fix.**

#### Performance and memory

Headless Edge 156, served from localhost, an `-O2 -g` build. These are not real-network or real-window numbers.

Load time, measured from the page request. "Menu drawn" is the last change of the canvas image, confirmed by a picture at 4 s.

| Run | Files downloaded | `main()` starts | First pixels | Menu drawn |
|---|---|---|---|---|
| Cold (fresh profile), 3 runs | 0.59 to 0.68 s | 0.47 to 0.70 s | 1.09 to 1.20 s | 1.69 to 1.78 s |
| Warm (cached), 2 runs | 0.27 to 0.32 s | 0.30 to 0.34 s | 0.54 to 0.57 s | 1.22 s |
| No-music set, cold, 2 runs | 0.36 s | 0.37 s | 1.09 to 1.11 s | 1.54 to 1.56 s |

In the warm runs the `.data` and `.wasm` came from the browser cache (no server requests for them). On localhost the music costs about 0.1 to 0.2 s; over a real network the cost is the extra 10.4 MB of download.

Memory: the WebAssembly memory size (the game's own heap), and Chromium's `performance.memory` for the JavaScript heap.

| | With music (28.1 MB set) | Without music (17.7 MB set) |
|---|---|---|
| Wasm heap before `main()` | 26,148,864 bytes | Same |
| Wasm heap at main menu, skirmish start, and after 5+ minutes | 51,445,760 bytes (no growth) | Same |
| JavaScript heap used before `main()` | 58.6 MB | 37.6 MB |
| JavaScript heap used during the game | 32 to 37 MB | 21 to 23 MB |

Inferred, not confirmed: the packaged data is not in the wasm heap, since that is the same with and without music. It sits on the JavaScript side (the in-memory file system); the 12 to 13 MB difference between the two sets tracks the 10.4 MB `SCORES.MIX`. How much of the wasm heap is MIX data the game caches could not be separated.

Smoothness (observed):

- Screen updates (one texture upload plus draw per SDL present), counted in 5 s windows in game: median 116 per second, minimum 83, about 114 at the menu. This is how often the screen is drawn, not the game-logic rate, which was not measured. Headless Edge has no real display refresh.
- Heartbeat every 500 ms: worst gap 673 ms at start-up, 523 ms at skirmish load, nothing else over 521 ms in 9 minutes.

#### Probe tools

In `build-web/probe-tools/` (ignored by git, lost if `build-web/` is deleted):

- `probe2.html`: everything the session 3 probe did, plus:
  - input steps `click@X@Y`, `rclick@X@Y`, `move@X@Y` (640x400 canvas pixels) and `key@NAME`;
  - load-timing marks, and a screen-change log for the first 40 s (`scrsecs=`);
  - memory every 10 s, and per-source audio summaries and screen updates per second every 5 s;
  - a live command queue.
- `probe_server.py`, extended:
  - `GET /cmd?run=X` hands the page any lines appended to `<outdir>/cmd-X.txt`, so a live page can be driven from the shell, for example `echo click@320@239 >> <outdir>/cmd-b1.txt`;
  - `PROBE_LOG=1` saves the request log;
  - `PROBE_CACHE=1` lets the browser cache files, for warm-load runs.
- `edge.sh <name> <secs> <url>` starts headless Edge with the profile `vc-probe-<name>`. `edge-kill.ps1` stops only Edge processes whose command line contains `vc-probe` (run it with `powershell.exe -ExecutionPolicy Bypass -File`).
- Menu click spots: Multiplayer Game (320,239), Skirmish (320,231), dialog OK (105,368).
- Pictures and logs: `build-web/probe-tools/results-4a/`, with folders `main-b1/`, `musicvol0-m1/`, `nomusic-n1-n2/`, `warm-w1-w3/`.

#### State left

- `~/ra-data/skirmish-web/` created.
- `build-web/` holds the accepted build, including the packaged data.
- No test server and no `vc-probe` Edge process left running (nothing listening on ports 8000 to 8009; Edge count 0). Port 8000 was not touched, and no server is running there now, so the owner starts one with the session 3 command.
- `~/.config/vanilla-conquer/` not touched.

#### Not checked in step 3

- A normal (non-headless) window; audio by ear; which track plays.
- The game-logic frame rate.
- The Allied side (the run played Russia).
- The end-of-game score screen.
- Fighting the AI: the AI did not appear on screen in 7.5 minutes.
- The cause of headless Edge's own hide at 60 s.
- Why native music played with `MultiplayerScoreVolume=0` (see step 1).
- The full 480 MB data in the browser. Not run, because nothing pointed at the trim.
- A `.wasm` size difference between a scratch build (14,117,162 bytes) and `build-web` (14,291,949 bytes). Not investigated.

#### Owner's browser play test

The step 3 build in `build-web/` (`vanillara.wasm` 14,291,949 bytes, `-O2 -g`, data from `~/ra-data/skirmish-web`), in a normal Edge window. Side: Soviet (Russia). Map: "Normandy", as the owner names it (the exact entry in the map list has not been matched). Players: the owner plus 2 AI players.

The owner's report, verbatim: "test ran perfectly for 10minutes plus then crashed and froze" and "refresh returns game to menu".

The owner's answer to follow-up questions about the crash, verbatim: "Edge, Soviet (Russia) Normandy - Units were moving, previously combat and movement had been heavy with no issues, 2 AI + player On screen were four mammoth tanks no notable browser behabior beyond the crash".

Console output pasted by the owner, verbatim:

```
Uncaught (in promise) RuntimeError: function signature mismatch
    at vanillara.wasm.DriveClass::Start_Of_Move() (vanillara.wasm:0x8ab9c)
    at vanillara.wasm.DriveClass::AI() (vanillara.wasm:0x8be38)
    at vanillara.wasm.UnitClass::AI() (vanillara.wasm:0x186ce6)
    at vanillara.wasm.LogicClass::AI() (vanillara.wasm:0xf363f)
    at vanillara.wasm.Main_Loop() (vanillara.wasm:0x6dd37)
    at vanillara.wasm.Main_Game(int, char**) (vanillara.wasm:0x6cdb3)
    at vanillara.wasm.main (vanillara.wasm:0x156839)
    at wrapper (vanillara.js:4754:20)
    at callUserCallback (vanillara.js:4726:16)
    at Object.doRewind (vanillara.js:4858:16)
```

The table records only what was reported.

| Check | Result |
|---|---|
| Skirmish map list shows maps | Not reported separately; covered by "ran perfectly" for the first 10 minutes |
| Skirmish against one AI starts | Not reported separately; covered by "ran perfectly" for the first 10 minutes |
| Plays for 5 minutes | Yes ("ran perfectly for 10minutes plus") |
| Sound | Not reported separately; covered by "ran perfectly" for the first 10 minutes |
| Music | Not reported separately; covered by "ran perfectly" for the first 10 minutes |
| No crash | **No**: a crash after 10+ minutes, see blocker 2 |
| Tab switch pauses and resumes | Not reported separately; covered by "ran perfectly" for the first 10 minutes |
| Console | The crash message above; nothing else reported |

#### Blocker 2: crash in unit movement after 10+ minutes

| | |
|---|---|
| Seen | Owner's browser play test, step 3 build, after 10+ minutes of a skirmish. The game froze; a refresh returns to the menu. Console message above. |
| What the message means | WebAssembly checks the type of a function every time code calls one through a pointer or a virtual function table (an "indirect call"). "function signature mismatch" means such a call, inside `DriveClass::Start_Of_Move` (unit movement, `redalert/drive.cpp`), reached a function of a different type from the one expected, and the browser stopped the program. |
| At the time of the crash | Reported by the owner: units were moving; four Mammoth Tanks were on screen; combat and movement had been heavy earlier in the game with no problem; no other unusual browser behaviour. It is not known whether the Mammoth Tanks were the units that triggered it, or whose they were. |
| Why it froze | The stop ends the game's code, so the page keeps showing the last picture. A refresh starts the program again. |
| Mapping (observed) | `emsymbolizer` (from `~/emsdk`, turns wasm addresses into source lines) on a copy of the crashed `vanillara.wasm`; `llvm-symbolizer` gives the same lines. `0x8ab9c` is `redalert/drive.cpp:1261`, the `Set_Speed(0);` inside `if (!Start_Driver(dest)) {` in `DriveClass::Start_Of_Move`. `0x8be38` is `drive.cpp:1390`, where `DriveClass::AI` calls `Start_Of_Move()`; the caller checks `IsActive` only after that call, at `:1391`. Further down: `unit.cpp:394`, `logic.cpp:351`. |
| In the wasm (observed) | With `llvm-objdump -d` (disassembler): the trapping instruction is an indirect call of type `(i32,i32)->()` through the unit's own virtual table, slot 144, `FootClass::Set_Speed`. The earlier virtual call in the same function, `Start_Driver` (slot 139), worked. After a unit's destructors run, its table pointer is left at the `TechnoClass` table, which has no slot 144; the word read there is a function of type `(i32,i32)->(i32)`, which is exactly a signature mismatch. |
| Read from code | `UnitClass::Start_Driver` goes down to `FootClass::Start_Driver`, which calls `Map[headto].Goodie_Check(this)` (picking up a crate). An Explosion or Napalm crate calls `Take_Damage` on the unit; if that kills it, `UnitClass::Take_Damage` deletes the unit. `Start_Driver` then returns false (`unit.cpp:3532` has the comment "IsActive can be cleared by Start_Driver"), and `Start_Of_Move` goes on to call `Set_Speed(0)` on the deleted unit. This is a use-after-delete (using an object after it has been freed) in shared game code. It is not web-specific and not caused by the trimmed data: native and full-data builds have the same bug; native happens not to trap. |
| Hypothesis, not confirmed | A damaged unit (possibly one of the Mammoth Tanks) drove onto an Explosion or Napalm crate and died. The crash has not been reproduced. |
| Proposed fix, not applied | In `redalert/drive.cpp` at 1258, inside `if (!Start_Driver(dest)) {`, add `if (!IsActive) return (false);` before `TrackNumber = -1;` (2 lines). Shared code, so the owner decides. `tiberiandawn/drive.cpp` probably needs the same; not checked. |
| Workaround for now | Untick Crates in the skirmish dialog. |
| Coverage so far | Step 3's headless run (about 7.5 minutes of active play) did not hit it. That run differed in two ways that may or may not matter: 1 AI player instead of 2, and a different map ("A Path Beyond (Lg)"). The owner's native play test was about 5 minutes; the native build has not been played for 10 minutes or more. |
| Status | Diagnosed from the crashed build, not reproduced, not fixed |
| Size | Small |

### Correction to the session 4 hand-off

The session 4 hand-off lists five files as changed and not committed: `CLAUDE.md`, `CMakeLists.txt`, `SPIKE.md`, `common/mssleep.h`, `common/wwstd.h`. All five are now committed:

| File | Commit |
|---|---|
| `CMakeLists.txt`, `common/mssleep.h`, `common/wwstd.h` | `9952c95` ("Web Build: Asyncify waits, proper srtupt fix, local test data option") |
| `CLAUDE.md`, `SPIKE.md` | `3770745` ("Notes:session 3 results and game data decision"), the next commit |

Checked with `git show --stat --oneline 9952c95` and `git show --stat --oneline 3770745` (each lists exactly those files), and `git log --oneline -3 -- <file>` for each of the five. `3770745` includes the session 4 notes themselves, hand-off included. `git status --short` was empty at the start of session 4a, and `git diff 3770745` shows no difference in any of the five files.

### Blockers, all steps

Nothing blocked steps 1 or 2.

| # | Step | Blocker | Status | Size |
|---|---|---|---|---|
| 1 | 3 | `Next_Song` loops forever when music volume is above 0 and no in-game track is available (`redalert/theme.cpp:244-246`, `:254-258`). Not web-specific. | Not fixed. Avoided by shipping music tracks or setting music volume to 0. | Small |
| 2 | 3 | Crash in unit movement after 10+ minutes in the owner's browser: "function signature mismatch" in `DriveClass::Start_Of_Move` (see step 3, blocker 2). Read from code: a unit killed by a crate while starting to move is used after it is deleted. Workaround: Crates off. | Diagnosed from the crashed build, not reproduced, not fixed | Small |

Not blocking:

| Item | Size |
|---|---|
| Movies are off in the web build (session 3). Not needed for a skirmish (step 2). | None for skirmish |
| `vanillamix` writes into `~/.config/vanilla-conquer/vanillatools/` unless `XDG_CONFIG_HOME` is set. | None (usage) |
| The trimmed set is untested for file names built at run time beyond what 7.5 minutes of play touched. | Small if it happens: add the file |

### Open items

1. Reproduce the crash and decide on the 2-line fix for blocker 2 (see the hand-off).
2. Decide on the `Next_Song` fix (blocker 1). It changes shared, non-web code, so it is outside this ticket's scope.
3. Owner re-tests the browser skirmish.
4. Whether the owner's native music was heard in the skirmish itself or only at the menu (asked).
5. Leftovers for the owner to remove or keep: `~/.config/vanilla-conquer/vanillatools/`, and the work folders `~/ra-data/allied-extract`, `~/ra-data/skirmish-min-build`, `~/ra-data/smoke-min` and `~/ra-data/smoke-full`.
6. Nothing is committed: `CMakeLists.txt` and `SPIKE.md` are modified.

### Hand-off (end of session 4a)

State: two files changed and **not committed**: `CMakeLists.txt` (one web-only line, `MultiplayerScoreVolume=0.25` in the generated INI) and `SPIKE.md` (checked with `git status --short`). No test servers or `vc-probe` Edge processes are running. `build-web/` holds the exact build that crashed: do not rebuild it until the reproduction below no longer needs its addresses. Scratch copies of that `.wasm` and `.js`, the disassembly and small reader scripts are in `/tmp/claude-1000/-home-mikem93-dev-Vanilla-Conquer/f26f9b24-7aba-4407-9069-001a0eee74f0/scratchpad/crash-4a/`, which may not survive a restart.

Results:

| Step | Result |
|---|---|
| 1, native skirmish | Passed (owner's play test) |
| 2, data size | Done (investigation) |
| 3, browser skirmish | Not passed: crash after 10+ minutes (blocker 2). The ticket's 5-minute acceptance was otherwise met, in headless Edge and in the owner's window. |

Owner's game config: `DataPath` in `~/.config/vanilla-conquer/vanillara/redalert.ini` points at `~/ra-data/skirmish-full`; the demo version is saved beside it as `redalert.ini.demo-backup`.

To pick up, in order:

1. Reproduce the crash in a separate build folder (`build-web-dbg/`), using a scratch copy of the source whose `Goodie_Check` always gives the Explosion crate with lethal damage. Run a 2-AI skirmish in headless Edge and expect the same trap.
2. Owner decides on the 2-line fix in shared code (blocker 2). If approved: apply it, show the trap is gone, check `tiberiandawn/drive.cpp`, and check the native build compiles.
3. Owner decides on the `Next_Song` fix (blocker 1).
4. Owner re-tests the browser skirmish.
5. The remaining open items: the native music question, the leftovers, and whether to commit.

## Session 5: 4a blockers fixed (13 Nov 2026)

**Result: both 4a blockers are fixed in code. The no-music run that used to hang now passes, and the owner's 10+ minute play test with Crates on completed with no crash (the crash was never reproduced, so "not seen again", not proof). A new blocker, fullscreen black screen, was found, fixed and confirmed by the owner, and fullscreen now uses a whole-number scale. One new ticket raised: higher game resolution. Committed at the end of the session.**

Owner's decisions (13 Nov 2026):

1. This session's job: finish the session 4a hand-off.
2. Blocker 2 (crate crash): apply the fix without reproducing the crash first (cheapest option). The rigged-crate reproduction from the 4a hand-off was not done. The owner's own 10+ minute play test with Crates on is the evidence.
3. Blocker 1 (`Next_Song` endless loop): fix approved.

Consequence: `build-web/` no longer had to be kept as "the build that crashed", and it has been rebuilt. The 4a crash addresses (`0x8ab9c`, `0x8be38`) do not apply to the new `.wasm`.

### Source changes

| File | Change |
|---|---|
| `redalert/drive.cpp:1259-1260` | In `DriveClass::Start_Of_Move`, inside `if (!Start_Driver(dest)) {`, added `if (!IsActive) return (false);` before `TrackNumber = -1;`. Two lines, same style as the existing guards at 1195-1199. |
| `redalert/theme.cpp:237-255` | `ThemeClass::Next_Song`: new check before the shuffle and sequential loops (below). No track allowed: returns `THEME_QUIET`. |
| `tiberiandawn/theme.cpp:228-246` | Same check. No track allowed: returns `THEME_NONE` (Tiberian Dawn has no `THEME_QUIET`). |
| `tiberiandawn/drive.cpp` | Not changed (below). |

No INI gate: both fixes act only in states that crashed or hung before.

**The `Next_Song` check.** One pass over `THEME_FIRST..THEME_LAST` using the existing `Is_Allowed()`. If no track is allowed, return "play nothing". If shuffle is on and the only allowed track is the current one, return the current track (the shuffle loop would otherwise never end). The new code does not call `Sim_Random_Pick`, so behaviour with tracks present is unchanged.

| Later frames (read from code) | What happens |
|---|---|
| Red Alert | `Next_Song(THEME_QUIET)` returns at its first check. `Play_Song(THEME_QUIET)` runs every frame: it stops the current track and loads no file. |
| Tiberian Dawn | `Next_Song(THEME_NONE)` recurses once with `THEME_PICK_ANOTHER`; the scan returns `THEME_NONE` again, so there is no endless recursion. Cost: about 50 `Is_Allowed` calls plus `Stop()` per frame, no file access. |
| Side effect, both games | Once quiet this way, music stays silent until something calls `Queue_Song`, even if tracks become allowed later. Before the fix this state was a hang. |

**Other `Start_Driver` callers in Red Alert** (read from code, no change):

| Caller | Why no change |
|---|---|
| `drive.cpp:429` (`Force_Track`) | Discards the result and does nothing after the call. |
| `drive.cpp:749` | Gets false for a dead unit (`UnitClass`/`VesselClass::Start_Driver` check `IsActive`), so `Set_Speed` is not reached. Plain fields are still written, and line 806 writes `SpeedAccum` and returns true on the dead unit (no virtual call). |
| `infantry.cpp:4170`, `2287-2289` | Check `IsActive` straight after the call. |

**Tiberian Dawn `drive.cpp`** (read from code, not changed): a TD unit can be killed by a crate (`cell.cpp:2354` calls `Take_Damage`; `unit.cpp:1094` clears `IsActive` on delete). But TD's `Goodie_Check` still returns true (`cell.cpp:2416`), and `FootClass`/`UnitClass::Start_Driver` pass that on, so the false branch at `tiberiandawn/drive.cpp:1260` is not reached. Side note, not acted on: TD's true path (`tiberiandawn/unit.cpp:3521`) runs `Mark_Track` on the dead unit; judged harmless there.

### Build and test results

| Check | Result |
|---|---|
| Native build (incremental) | 0 errors, 0 warnings. `build/` is configured with Tiberian Dawn off, so this compiled Red Alert only. |
| `tiberiandawn/theme.cpp` on its own, in a scratch build folder | 0 errors, 0 warnings. A full Tiberian Dawn build and link was **not** done. |
| Format check | **Skipped**: no clang-format of any version is installed on this machine. CI (clang-format 14) has not seen these changes. |
| Web build | 0 errors, 1 warning (the usual limited-optimisation notice). `vanillara.wasm` is now 14,292,644 bytes (was 14,291,949). |
| No-music run (the old hang, blocker 1) | **Pass.** Data `~/ra-data/skirmish-min` (no `SCORES.MIX`, the set the 4a "n1" run used), generated INI at `MultiplayerScoreVolume=0.25`. Headless Edge: the skirmish started and ran to t=142 s, about 116 screen updates per second, no errors. |
| Normal run | **Pass.** `skirmish-web` data, headless Edge, map "A Path Beyond", Russia, AI Players 2, Crates on (the default); settings confirmed from the screenshot `c5-shot-gauge1.png`. 5 minutes in game, 672 heartbeats, no errors, no "function signature mismatch". |

Limits of the normal run: it was not shown that any crate was picked up, and the final screenshot shows the player's side with its starting units and 10000 credits, so the scripted player did not build a base. This run shows nothing else broke; it does **not** prove the crash fix.

Results and pictures: `build-web/probe-tools/results-5/` (`nomusic/`, `normal/`), git-ignored.

Commands used:

```sh
# Native build, incremental (Red Alert only in this build folder)
cmake --build build -j8
```

```sh
# Load the Emscripten tools into this shell, then build the web version
source ~/emsdk/emsdk_env.sh
cmake --build build-web --target VanillaRA -j8
```

```sh
# Choose which data folder gets packaged into the web build (then rebuild)
cmake -B build-web -DWEB_DATA_DIR=...
```

```sh
# Click at screen position X,Y in the live test page (probe tools, session 4a)
echo click@X@Y >> cmd-RUN.txt
```

`probe_server.py` and `edge.sh` start the test server and headless Edge, and `edge-kill.ps1` stops the test Edge (see the session 4a probe tools).

Thing to know: a `pkill -f` pattern (kill processes whose command line matches) matched and killed the worker's own shell. `pgrep` (list matching processes without killing them) was used instead to find the process first.

### State left

Checked by the conductor with read-only commands:

- `git status --short` lists only `redalert/drive.cpp`, `redalert/theme.cpp`, `tiberiandawn/theme.cpp` and `SPIKE.md`.
- `build-web/` holds the fixed build with the normal `skirmish-web` data: `vanillara.data` is 28,098,196 bytes, and `WEB_DATA_DIR` in `build-web/CMakeCache.txt` is `~/ra-data/skirmish-web`.
- Nothing listening on ports 8000-8009.
- As before, `build-web/` must never be committed, uploaded or deployed while `vanillara.data` is in it.

### Blockers, session 5

| # | Blocker | Status |
|---|---|---|
| 1 | `Next_Song` loops forever when music is on and no track is available | Fixed (no-music run passes) |
| 2 | Crash in unit movement after 10+ minutes (crate kills a unit that is starting to move) | Fix in place. Owner's play test with Crates on, 10+ minutes: full skirmish completed, no crash. The crash was never reproduced, so this means "not seen again", not proof. |
| 3 | Fullscreen, entered with the button on the page, gives a black or blank screen (owner's browser, fixed build) | Fixed (web only, `common/video_sdl2.cpp`). Real-fullscreen black screen confirmed gone by the owner's re-test. |

### Owner's play test

The owner's words, quoted exactly:

> "Play test complete - Full skirmish completed with no issues - Russia vs 1 allied & 1 soviet AI - Large Map. Game speed adjusted in game with no issue - fullscreen crahses game"

Answers the owner picked from options the conductor offered (not free text):

| Question | Owner's answer |
|---|---|
| How fullscreen was entered | "Button on the page" |
| What the crash looked like | "Black or blank screen" |
| Crates and length of the completed skirmish | "Crates on, 10+ minutes" |
| What to do about fullscreen | "Diagnose and fix now" |

Not asked and not known: which of the page's tick boxes were set, any console message, whether a refresh recovered it, which map by name, how long the game lasted beyond "10+ minutes", whether any unit died on a crate.

### Blocker 3: fullscreen black screen

| | |
|---|---|
| Cause (observed in a test) | The game did not crash. Emscripten's `Module.requestFullscreen` resets the canvas to a saved "native" size (`canvas.widthNative`/`heightNative`, `vanillara.js:7766-7790` in that build). Only Emscripten's own `setCanvasSize` saves that size; SDL sizes the canvas directly, so the saved size was empty. The canvas became 0x0 and black, and stayed black after leaving fullscreen, with the game still running (about 117 draws a second, no wasm error). |
| Reproduced | Headless Edge, page defaults (resize off, pointer lock on). Headless Edge refuses real fullscreen, so the probe page faked the browser's fullscreen event. |
| Fix | `common/video_sdl2.cpp`: an `#include <emscripten.h>` at about lines 50-52, and an `EM_ASM` block (JavaScript written inside C++) after the "Created SDL2 window" log line in `Set_Video_Mode`, all inside `#ifdef __EMSCRIPTEN__`. It records the canvas size SDL created. 19 lines. Native builds unaffected. |
| Builds | Web: 0 errors, 1 usual warning. Native: 0 errors, 0 warnings. |
| Smoke run | Menu; fullscreen on and off (canvas stays 640x400); skirmish with fullscreen on and off about 34 s into play; ran about 75 s; no errors. Results: `build-web/probe-tools/results-5/fullscreen/`. |

The owner's re-test, quoted exactly:

> "All works correctly - Scaling is an issue on 1080p monitor everything is too large/stretched"

Answers the owner picked from offered options: where = "Fullscreen only"; wanted look = "Exact 2x, centred"; when = "Fix now if small".

### Fullscreen scaling change

| | |
|---|---|
| Cause (read from `vanillara.js:7776-7794`, confirmed in the probe) | Emscripten scaled the canvas by `min(screen.width/640, screen.height/400)` = 2.7, giving 1728x1080, horizontally centred, top-aligned, smoothed. The shape was kept; the "stretched" look came from uneven 2.7x pixels. |
| Change | 19 more lines in the same `EM_ASM` block (38 added lines in `common/video_sdl2.cpp` in total, all web-only). It wraps Emscripten's `Browser.updateCanvasDimensions`: in fullscreen with resize off it uses the largest whole-number scale that fits (minimum 1), allowing for `devicePixelRatio`, centres the canvas on black, and sets `image-rendering: pixelated` in fullscreen only. Windowed view unchanged. |
| Risk | Relies on Emscripten internals (`Browser`, `getFullscreenElement`); an Emscripten upgrade could break it. |
| Probe (screen faked as 1920x1080) | Canvas shown at 1280x800, left 320, top 140 (measured box 1282x802 at 319,139, because of the 1 px canvas border the windowed page already has). Clicks on Multiplayer, Skirmish and OK landed while scaled, and a skirmish started. Results: `build-web/probe-tools/results-5/fullscreen-scale/`. |
| Builds | Web: 0 errors, 1 usual warning. Native: 0/0. `vanillara.wasm` is now 14,293,059 bytes. |
| Not verified by any worker | Real fullscreen, pointer-locked mouse aim, Windows display scaling other than 100%, other screen sizes, the "Resize canvas" tick box. |

The owner's second re-test, quoted exactly:

> "Fix has improved menu appearance - in game assets still appear too large relative to screen size - Gives a zoomed in appearance - will need to render more pixels than game natively does"

### New ticket: higher game resolution

Not a blocker of 4a. Owner's decision, picked from offered options: "Record as new ticket (Recommended)". No work done on it this session.

Conductor's read-only check (grep only): the resolution is fixed in code. `redalert/globals.cpp:179-180` sets `ScreenWidth`/`ScreenHeight` to `GBUFF_INIT_WIDTH`/`GBUFF_INIT_HEIGHT` (640x400); `redalert/startup.cpp:334-335` sets 320x200 for DOS mode; `startup.cpp` uses the two globals 27 times. No setting for other sizes was found in `globals.cpp`, `startup.cpp`, `init.cpp` or `common/settings.*`.

Not scoped: what else is tied to 640x400 (map view, sidebar, radar, menus, mouse). It is shared game code, so by the project rule it would go behind a setting, default unchanged. First step: a read-only scoping pass. Until then, the 2x fullscreen change is the interim.

#### Scoping pass (read from code, not tested)

Owner's request, quoted exactly: "Complete first step of ticket (scoping pass)". Done by one read-only worker (no edits, no builds), looking at `redalert/` and `common/` only.

Target evaluated: an optional larger internal resolution, first 960x540 (exactly 2x on 1920x1080), generally any size at or above 640x400. The map area grows; sidebar, radar, power bar and tabs keep native size; menus may stay 640x400, centred.

**Verdict: feasible, size M (worker's estimate: about 4-7 focused days). No blockers found.** The video layer, mouse mapping, edge scrolling, radar and `Set_View_Dimensions` already follow the buffer size. Most work is in two places: sidebar, power and tab positions are 320-space constants (roughly 15 sites), and menus and dialogs mix absolute and centred coordinates.

| Area | Status | Pointers | Size |
|---|---|---|---|
| Buffers, video | Follows buffer | `externs.h:61-65`; `startup.cpp:343-436` (all from `ScreenWidth`/`ScreenHeight`); `video_sdl2.cpp:221,387,764-769` (generic w,h). Default `BoxingAspectRatio` is "16:10" (`settings.cpp:28`) and would distort 16:9. The old 640x480 fallback was removed in `0fc12f6` ("Remove legacy Resolution option"). | S |
| Tactical view | Follows buffer | `display.cpp:543-597` derives size from `SeenBuff` or a cell count; `CellRedraw` is sized from `MAP_CELL_TOTAL`. `sidebar.cpp:987` hard-codes 20 cells: `((320 - SIDE_WIDTH) / ICON_PIXEL_W) * RESFACTOR`. | S |
| Chrome | Mixed | Radar follows (`radar.cpp:149`). Tied to constants: `sidebar.h:62-94` (`SIDE_X = 320 - 80`), `sidebar.cpp:151,213,225,240-242,305-323,761-765`, `power.h:87`, `power.cpp:140,257`, `tab.cpp:145-173`. Strips use positions relative to X (`sidebar.cpp:1171`). | S-M |
| Menus, movies | Mixed | Centred: `loaddlg.cpp:119`, `gamedlg.cpp:65`. Absolute: `menus.cpp:475`, `mplayer.cpp:72`, `seditdlg.cpp:104`. Score and map-select use 320x200 buffers (`score.cpp:359`, `mapsel.cpp:141`). VQA is 640x400 (`init.cpp:1276`), centred inside its own frame. 42 direct `VisiblePage`/`HiddenPage` uses. | M |
| Mouse, scroll | Follows buffer | `video_sdl2.cpp:133,448`, `wwkeyboard_sdl2.cpp:79`, `scroll.cpp:110`, `wwmouse.cpp:382` | S |
| Determinism, saves | Judged safe | View reads in logic files only flag redraws or set audio pan (`aircraft.cpp:1008`, `vessel.cpp:610`, `audio.cpp:360-368`). `TacLepton*` sits in `MouseClass`, saved raw (`iomap.cpp:256`), but `Sidebar::Init_IO` calls `Activate`, which recomputes the view (`sidebar.cpp:339-341`). Struct layout unchanged. | S |
| Prior art | None useful | `fd1da1e` (output scaling), `0fc12f6` (Resolution option removed); no setting exists. | - |

File names without a folder are in `redalert/`, except `video_sdl2.cpp`, `wwkeyboard_sdl2.cpp`, `wwmouse.cpp` and `settings.cpp`, which are in `common/`. That folder attribution is the conductor's reading of the report, not checked file by file.

Conductor's spot checks (read-only, matched the report): `redalert/sidebar.cpp:987`, `redalert/sidebar.h:62`, `common/settings.cpp:28`, and commit `0fc12f6` exists with that title. Nothing else was independently checked.

Staged plan proposed by the scoping worker (not approved, not started):

1. Add a `Settings.Video` field for internal width/height (default 640x400) and apply it in `startup.cpp:334` and at the `GBUFF` init. Add one runtime offset (`SideDX = ScreenWidth - 640`) to the sidebar, power and tab sites above; change `sidebar.cpp:987` to `(ScreenWidth - 160) / 24` cells; fill the strip under the sidebar with black; set boxing to 16:9. Test: browser at 960x540 shows more map, sidebar clicks work, default build matches the old screenshot pixel for pixel.
2. Make the game height follow the buffer and handle maps smaller than the view (`Confine_Rect`, not checked). Test: small skirmish maps, scrolling at map edges.
3. Menus centred: attach `SeenBuff`/`HidPage` as a 640x400 sub-viewport centred in the big pages (the `startup.cpp:423` mechanism), apply a mouse offset in `wwkeyboard_sdl2`, switch back to the full-size viewport on entering the game. Test: every dialog, score screen, map selection, movies.
4. In-game dialogs (`goptions`, `msgbox.cpp:90`, `scenario.cpp:1439`), message input width (`init.cpp:1147`), and a save/load round trip across resolutions.

Risks:

- Desync: judged low, but drawing code that consumes random numbers was not checked.
- Saves: low risk; a cross-resolution load relies on `Init_IO`.
- Shared `common/` and settings changes also affect Tiberian Dawn and need upstream-style review.
- Remastered: `REMASTER_BUILD` uses 3072x3072 with separate paths, so changes should stay behind `#ifndef REMASTER_BUILD`.
- Tiberian Dawn has the same 320-space sidebar, display and dialog structure and would need parallel work (stated by the worker; TD was out of scope and not examined).

Open questions for the owner (not yet asked):

1. Arbitrary sizes, or a fixed list?
2. Minimum map size, and should the view be clamped to it?
3. Menus centred (stage 3), or left at top-left?
4. Is a 16:9 boxing default acceptable, and how to keep the default faithful?
5. Should the in-game Options dialog expose the setting, or only the INI?

### Native music (4a question answered)

The owner's words, quoted exactly: "native music was heard throughout skirmish play".

### Open items

1. The higher-resolution ticket (above): scoping pass done; the owner's answers to its open questions are next.
2. clang-format 14 not run on any changed file, including `common/video_sdl2.cpp` (it may reformat the `EM_ASM` block).
3. Full Tiberian Dawn build and the CI presets not run.
4. Still open from 4a: the leftover folders `~/.config/vanilla-conquer/vanillatools/`, `~/ra-data/allied-extract`, `~/ra-data/skirmish-min-build`, `~/ra-data/smoke-min`, `~/ra-data/smoke-full`.
5. If the crash returns: the rigged-crate reproduction from the 4a hand-off is still available as a follow-up.

### Hand-off (end of session 5)

State (checked by the conductor): `build-web/` holds the current build with the normal `skirmish-web` data; nothing listening on ports 8000-8009. Files changed this session: `common/video_sdl2.cpp`, `redalert/drive.cpp`, `redalert/theme.cpp`, `tiberiandawn/theme.cpp`, `SPIKE.md`. These were committed at the end of the session (owner's choice: "Worker commits"); not pushed. That commit is `b0d0536`; its co-author line reads "Claude Opus 5.5" where the conductor had specified "Claude Fable 5.2" (left as is; owner informed). The scoping-pass notes were committed afterwards in a separate `SPIKE.md`-only commit. As before, `build-web/` must never be committed, uploaded or deployed while `vanillara.data` is in it.

Results:

| Check | Result |
|---|---|
| Blocker 1, no-music run | Passed (headless Edge) |
| Blocker 2, crate crash | Fix applied; not reproduced; owner's play test (Crates on, 10+ minutes, full skirmish) completed with no crash |
| Blocker 3, fullscreen black screen | Fixed; owner's re-test: "All works correctly" |
| Fullscreen scaling | Whole-number scale, centred; menus improved; in-game view still looks zoomed in (new ticket) |
| Native build | Clean (Red Alert only) |
| Format, full TD build, CI presets | Not run |

To pick up, in order:

1. Higher-resolution ticket: scoping pass done. Next: the owner answers its open questions, then stage 1 as its own ticket.
2. clang-format 14 check on the changed files; full Tiberian Dawn build and CI presets.
3. The 4a leftover folders.

To play the current build in the browser:

```sh
# Serve the build-web folder on this machine only, at port 8000
python3 -m http.server 8000 --bind 127.0.0.1 --directory build-web
```

Then open http://localhost:8000/vanillara.html.

## Session 6: Multiplayer discovery (13 Nov 2026)

**Result: browser multiplayer looks feasible without touching the game's lockstep or lobby logic, by replacing one transport class with a WebSocket version and adding a small relay server with join codes. The existing UDP code compiles for the web but cannot work in a browser. Overall size medium to large, driven by making the lobby's blocking waits yield to the browser and by hidden-tab behaviour. Assume browser-only play for a first version. Nothing was run, so every conclusion is from reading.** (Conductor's synthesis.)

Owner's ticket: "Multiplayer discovery (spike, investigate and report only)". Release priority: (1) hostable skirmish, (2) multiplayer, (3) campaigns. Goal: an evidence-based answer to "what would browser multiplayer take?".

Scope kept: code and documentation read only; no tracked file changed apart from SPIKE.md; no experiment was run. The optional networking-on web build was skipped because SPIKE.md:167 already records that it compiles and links, and `build-web/CMakeCache.txt:263` shows `NETWORKING:BOOL=ON` [obs].

Method: two read-only Opus workers (game side in `redalert/`; transport and server in `common/`, the local Emscripten SDK 7.0.0 in `~/emsdk`, 3 web searches), plus conductor spot checks of about ten code pointers (all matched).

Evidence labels: [code] read from code, [obs] observed by running, [web] looked up on the web 13 Nov 2026, [bg] background knowledge not checked, [est] estimate.

Terms used below:

- Lockstep: every machine runs the same simulation; only player commands are sent, and no machine moves to the next frame until it has everyone's commands for it.
- Relay: a server that just passes messages between players.
- WebSocket: a browser's two-way connection to a server, running over TCP.
- WebRTC: the browser's peer-to-peer connection system; its "data channels" can carry game packets.
- TURN: a relay server WebRTC falls back to when two players cannot connect directly.
- Asyncify: the Emscripten feature this build uses to pause the C++ code and hand control back to the browser, then resume it.
- Head-of-line blocking: on TCP, one lost packet holds up every packet behind it until it is resent.

### Q1 Structure

- Files compiled only with NETWORKING on: `redalert/` ipxconn, ipxgconn, ipxmgr, netdlg, sendfile (`redalert/CMakeLists.txt:151-158`); `common/` connect.cpp, ipxaddr.cpp, wsproto.cpp, wspudp.cpp, with defines `WINSOCK_IPX` and `NETWORKING` (`common/CMakeLists.txt:158-163,209-210`). Always compiled: event.cpp, queue.cpp, session.cpp, nulldlg.cpp, rawolapi.cpp, wolstrng.cpp (`redalert/CMakeLists.txt:44,91,98,101,110,148`). [code]
- Layers, top to bottom [code]:

| Layer | Where |
|---|---|
| Lobby dialogs | `netdlg.cpp` |
| Session data, `Create_Connections` | `session.cpp:297-315` |
| Connection manager `IPXManagerClass` | `ipxmgr.h:150` |
| Per-connection `IPXConnClass` (ACK/retry); `IPXGlobalConnClass` (broadcast channel) | `ipxconn.h:53`, `ipxgconn.h:107` |
| Base classes | `common/` connect.h, combuf.h, connmgr.h |
| Transport interface `WinsockInterfaceClass` (`Open_Socket`, `WriteTo`, `Broadcast`, `Read`, `Message_Handler`) | `common/wsproto.h:92-135` |
| Implementation `UDPInterfaceClass` | `common/wspudp.h:44` |

- Protocol [code]: despite the "IPX" names, traffic is UDP: `PacketTransport = new UDPInterfaceClass` (`redalert/init.cpp:903,954`).
  - One IPv4 UDP socket (`wspudp.cpp:166`), `SO_BROADCAST` and sends to 255.255.255.255 (:175-180), non-blocking (:191).
  - Every player is bound to the same fixed port 1234, `PlanetWestwoodPortNumber` (:197, `internet.cpp:24`); own addresses come from `getifaddrs` (:251).
  - `select` with zero timeout, then `recvfrom`/`sendto` (:513-583). A peer is identified by its 4-byte IP alone (:552, :570).
  - Packets at most 1024 bytes (`wsproto.h:184`). Windows-only parts: `WSAAsyncSelect` and a `gethostbyname` path (:213, :341-445).
- Reachable game types [code]: the menu offers Skirmish or "Network" (`GAME_IPX`) only (`mplayer.cpp`, about lines 320 and 339, line numbers approximate). `GameType` still lists MODEM, NULL_MODEM, IPX, INTERNET (`session.h:123-129`), but INTERNET/Westwood Online needs `WOLAPI_INTEGRATION` (`init.cpp:887-944`), which no CMake file defines. The worker judged modem/serial/internet code dead (not fully checked for nulldlg).
- Finding and joining: LAN broadcast only [code].
  - Lobby packets `NET_QUERY_GAME`/`ANSWER_GAME`, `QUERY_PLAYER`/`ANSWER_PLAYER`, `QUERY_JOIN`, `CONFIRM_JOIN`, `REJECT_JOIN`, `GAME_OPTIONS`, `GO`, plus scenario transfer 1000-1004 (`session.h:202-221`).
  - `Send_Global_Message(..., 0, NULL)` means broadcast (`ipxmgr.cpp:709`) and ends in `PacketTransport->Broadcast` (`ipxgconn.cpp:413`, `ipxconn.cpp:434`). Addresses are learnt from the sender of each packet (`netdlg.cpp:2758, 3237`).
  - Join: `Request_To_Join` sends `QUERY_JOIN` with min/max version and a RULES.INI check value (`netdlg.cpp:2473-2493`). Host sends seed, settings and protocol in `GAME_OPTIONS` (`netdlg.cpp:3071-3087`; seed from `rand()`, :3722).
  - Start: host sends `GO`, then waits in place for ACKs and READY replies with a 10 s timeout (`netdlg.cpp:4460-4513`); connections are then created (`init.cpp:1150`).
  - There is no way to join by typing an address.
- Where the network meets the game loop [code]: `Main_Loop` calls `Queue_AI` (`conquer.cpp:1855`), which calls `Queue_AI_Multiplayer` (`queue.cpp:377,554`). Each frame a game CRC is computed (`queue.cpp:624-625`); every `FrameSendRate` frames packets/FRAMEINFO are sent (:762-776). Defaults `MaxAhead=5`, `FrameSendRate=3` (`session.cpp:167-168`, `session.h:101`); the host recomputes MaxAhead from measured response time, minimum 2 (`netdlg.cpp:4449-4454`). Frames are held back in `Wait_For_Players` until `Can_Advance` (`queue.cpp:1222`); the game stalls while waiting.

### Q2 Transport

Can Emscripten's socket emulation carry the traffic as-is? **No.** [code, not run]

- `setsockopt` always returns "option not supported" in a browser (`~/emsdk/upstream/emscripten/src/lib/libsyscall.js:465-471`), so the `SO_BROADCAST` call at `wspudp.cpp:175` makes `Open_Socket` fail before any packet is sent.
- `bind` on a UDP socket tries to start a listening server; unsupported in a browser, error quietly dropped (`libsockfs.js:525-547, 583`).
- `sendto` opens one WebSocket per destination, to `ws://<ip>:<port>` (`libsockfs.js:207-283`); a broadcast would try `ws://255.255.255.255:1234`. Each UDP socket first sends a 10-byte "port" message (:310-318), and the server must speak the binary WebSocket subprotocol (`settings.js:440`). `select` works through `poll` (:435-478).
- `PROXY_POSIX_SOCKETS` forwards every socket call to a native bridge program (`tools/websocket_to_posix_proxy`); each call blocks on a futex wait (`websocket_to_posix_socket.c:158`) [code]; it needs threads, special server headers and the game off the main thread [bg]. Not suitable here.
- Even with a relay, the emulation does not fit: players are addressed by IP on a fixed port and found by broadcast.

Conclusion [code]: a browser-specific replacement of one class. Smallest seam: `WinsockInterfaceClass` (`common/wsproto.h:92-135`), polled at `wsproto.cpp:70`. Write a web transport class and create it instead of `UDPInterfaceClass` at `redalert/init.cpp:903,954`. Everything above it (ACK/retry, lobby, lockstep) stays as it is.

| | WebSocket via relay | WebRTC data channels |
|---|---|---|
| Delivery | Runs over TCP, so head-of-line blocking; the game's own ACK/retry layer adds a second retry loop on top [bg] | Can be unordered and unreliable, close to UDP [bg] |
| Path | All traffic through the relay [bg] | Peer to peer, but strict home routers need a TURN server [bg] |
| Emscripten support | WebSocket API is built in | None built in: `SOCKET_WEBRTC` was removed (`ChangeLog.md:161`) [code]; third-party `datachannel-wasm`, compatible with libdatachannel [web: GitHub, paullouisageneau/datachannel-wasm] |
| Server | Relay with rooms | Signalling server still needed, plus STUN/TURN. Cloudflare TURN: 1,000 GB a month free, then $0.05/GB; STUN free [web: developers.cloudflare.com, realtime/turn] |
| Complexity | Small | Larger C++ side, more failure modes |

Verdict: WebSocket relay first. A 2-8 player lockstep game sends small packets, so latency through a nearby relay should be acceptable, but this is not measured.

### Q3 Server

- Minimum: one relay with rooms and join codes. The host gets a code; friends open the page with `?join=CODE`. The relay gives each player a made-up IPv4 address and forwards `WriteTo` (to one player) and `Broadcast` (to everyone in the room), so the existing LAN lobby works inside a room as if it were a LAN. No separate lobby list is needed for a first version.
- Size: roughly 150-250 lines of Node.js with the `ws` package [est].
- Hosting: Cloudflare Durable Objects can hold WebSockets and charge per message, but Cloudflare's own pages disagree on whether the free plan includes them [web: developers.cloudflare.com, durable-objects pricing]. A small rented server (VPS) is the fallback; prices not checked.
- A page served over https can only open secure WebSockets (`wss://`), so the relay needs a TLS certificate [bg].

### Q4 Lockstep in a hidden or throttled tab

What the code does when a player stops sending [code]:

- `queue.cpp:565-573`: the reconnect dialog appears after 3 s (`FRAMESYNC_DLG_TIME`, 3*60 ticks at 60 per second); the player is treated as gone after `FRAMESYNC_TIMEOUT` (15*60 ticks; the worker reports this is applied twice, about 30 s). Both are multiplied by 6 for `GAME_INTERNET`, which is not reachable today.
- `Handle_Timeout` drops the slowest peer (`queue.cpp:2230-2248`), `Destroy_Connection` turns that house into a computer player (`netdlg.cpp:514-521`), and the others carry on.
- Everyone stalls while waiting. There is no rejoin.

What the web build does today [obs, sessions 3 and 4a, single player]: the game pauses itself when the page is hidden or loses focus and resumes on return (SPIKE.md:831, :834); SDL focus events drive this (`common/wwkeyboard_sdl2.cpp:86-98`). Whether multiplayer mode pauses on focus loss: not checked.

Browser behaviour [bg, not tested here]: hidden tabs have timers slowed to about once a second (and, after some minutes, as little as once a minute in Chromium browsers) and get no animation frames; WebSocket messages still arrive; Web Workers are not slowed the same way.

| Option | What it means | For | Against |
|---|---|---|---|
| 1. Keep ticking in the background | Drive the hidden tab's game loop from incoming relay messages or a Web Worker timer instead of page timers; do not pause on focus loss in multiplayer | Others never notice a tab switch | Most work; fights the browser; sound and drawing must be skipped while hidden; not known to be reliable on phones |
| 2. Timeouts only | Leave the existing behaviour: others stall, see the reconnect dialog at 3 s, and the hidden player is replaced by a computer player after the timeout | Already written; simple | A short tab switch stalls everyone, and about 30 s away loses your seat for good; no rejoin |
| 3. Pause for all | The hidden tab (or the relay on its behalf) tells the room "player away"; everyone shows a waiting box for up to a cap (for example 60 s), then option 2 applies | Honest and predictable; small protocol addition | One player can stall the game; needs a new message or a longer, configurable timeout |

Conductor's recommendation: measure first (work item 6), start with option 2 using a longer web timeout plus a clear "keep this tab visible" notice, then add option 3; option 1 only if play tests show it is needed.

### Q5 Compatibility with native players

- Checks that exist [code]: version range at join (`REJECT_VERSION_TOO_OLD/NEW`, `netdlg.cpp:4737-4748`); RULES.INI identity (`REJECT_MISMATCH`, :4690); desync detection by comparing the last 32 frame CRCs (`queue.cpp:3298`), with an out-of-sync box offering Continue (drops all connections) or Stop (:3302-3309).
- Hazards [code]:
  - `EventClass` is packed with bitfields and sent as raw memory (`event.h:48,113-123`; `queue.cpp:2471`). Its union contains a `void* Pointer` (`event.h:223`), 4 bytes in the browser build and 8 on a 64-bit native build, which changes the packet size only if that member is the largest: not checked.
  - `GlobalPacketType` is packed with bitfields (`session.h:292-399`); the size of the address class inside it: not checked.
  - Enums are fixed width (`event.h:55`, `defines.h:370,962`). Floating point in game logic is almost nil (`house.cpp:3875` is a UI message; rules use fixed point, `rules.cpp:93`).
- Transport side: the relay would also need a UDP socket on port 1234, map each native player's real IP to a made-up address, and forward broadcasts both ways. One public IP could stand for only one native player, because peers are told apart by IP alone (`wspudp.cpp:570`). Native players would need a new "connect to relay" option, because they find games by LAN broadcast.
- Answer: assume browser-only for the first version. Browser players all run the same compiled program, which is the best case for staying in sync. Native interop is possible in principle but is a separate, large piece of work with unproven cross-build determinism.

### Recommended approach (conductor's synthesis, not approved by the owner)

1. Web transport: a new web-only class implementing `WinsockInterfaceClass` over one WebSocket to the relay, selected under `__EMSCRIPTEN__` at `redalert/init.cpp:903,954`; native builds unchanged. Incoming messages are only queued by the browser callback and handed to the game when it polls (the game uses Asyncify, so callbacks must not call into game code).
2. Relay with rooms and join codes (Q3). A room behaves like a LAN, so the existing lobby, ACK/retry and lockstep code is reused unchanged.
3. Make the waits yield. The lobby has about 18 loops of the form `while (Ipx.Global_Num_Send() > 0 && Ipx.Service())` in `netdlg.cpp` (for example :1680, 2335, 3027, 4169, 6931), two wait-for-GO loops (`netdlg.cpp:4513, 6050`), one in `sendfile.cpp:136`, the out-of-sync loop (`queue.cpp:3303`) and `Wait_For_Players` (`queue.cpp:955`), which ends with `Frame_Limiter(FL_NO_BLOCK)` (`queue.cpp:1244`). Conductor's reading of `common/framelimit.cpp:28,45`: with `FL_NO_BLOCK` the limiter skips its sleep, and the sleep (`common/mssleep.h:34-52`, `emscripten_sleep`) is the only place the web build hands control back to the browser, so these loops would spin without ever letting a WebSocket message arrive. Not run; this is the main technical risk. Idea to test first: one short yield inside the web transport's poll, which every such loop already calls through `Service()`.
4. Hidden tabs: as recommended under Q4.
5. Browser-only; each player needs the same game data (the phase 2 loader's hosted route covers this) and the RULES.INI check already guards it.

### Work items

| # | Item | Size | Notes |
|---|---|---|---|
| 1 | Confirm in a browser that today's networking fails at `Open_Socket`, and capture the console | S | Turns the Q2 reading into an observation |
| 2 | Web transport class over WebSocket | M | New web-only file in `common/`, two-line selection in `init.cpp` |
| 3 | Relay with rooms and join codes, runnable locally | S | Node.js + `ws`, about 150-250 lines [est]; lives outside the game build |
| 4 | Yield audit of the blocking waits under Asyncify | M | Unknown until tried; could be S if the single yield in the transport poll works, L if each loop needs work |
| 5 | Two-browser test harness: two headless Edge pages play a network game through the local relay for N minutes with CRCs in sync | M | Extends the existing probe tools |
| 6 | Hidden-tab measurement, then the chosen policy | M | S for option 2 with a longer timeout; more for options 3 or 1 |
| 7 | Join flow on the page: create game, show code/link, `?join=CODE` | S-M | How much of the old LAN lobby to show is an owner decision |
| 8 | Host the relay with TLS (`wss://`), plus basic limits against abuse (room count, message rate, idle timeout) | S | Hosting choice open |
| 9 | Measure latency through the relay and tune `MaxAhead`/`FrameSendRate` | S | Needs two real machines |
| 10 | Scenario file transfer (`sendfile.cpp`): test or switch off for the web | S | |
| 11 | Later, only if needed: WebRTC transport | L | Third-party library, TURN |
| 12 | Later, only if wanted: native interop | L | Relay UDP side, native "connect to relay" option, cross-build determinism |

Overall, items 1-10: medium to large (conductor's estimate; no day count was produced).

### Key risks

- Blocking waits never yield, so the page freezes waiting for a packet that cannot arrive (see approach 3). Highest risk, cheapest to test early (items 1-4).
- Hidden or throttled tabs stall or drop players (Q4).
- TCP head-of-line blocking plus the game's own retries may cause stutter on poor connections; not measured.
- An open relay can be abused; it needs limits, and hosting cost is not pinned down (Cloudflare free-plan status unclear).
- Secure pages need `wss://` and a certificate.
- Desync between browsers is unlikely with one shared build but unproven; native interop determinism is unproven and the event packet size may differ.
- All findings are from reading code and documentation; nothing was run.

### Open questions for the owner

1. Hosting for the relay: Cloudflare or a small rented server?
2. Hidden-tab policy (Q4 options)?
3. Is browser-only acceptable for the first version?
4. Join by code/link only, or a public game list too?
5. Maximum players for a first version?

### Things the workers were least sure of

- That the `setsockopt` failure is the first runtime failure (not run).
- Whether Cloudflare's free plan includes Durable Objects.
- That relay latency is good enough.
- Whether `void* Pointer` changes `sizeof(EventClass)`.
- Whether `Frame_Limiter(FL_NO_BLOCK)` yields.
- The exact `mplayer.cpp` line numbers, and whether the modem code in nulldlg is fully unreachable.

### Hand-off (end of session 6)

State: only SPIKE.md changed; no builds, no servers, nothing outside the repo created.

To pick up, in order:

1. Owner answers the open questions.
2. Work items 1 to 4 as the first multiplayer ticket (they settle the main risk cheaply).

Other open items from Session 5 stand: higher-resolution ticket decisions, clang-format 14 check, full Tiberian Dawn build and CI presets, leftover folders.

## Session 7: Skirmish data size (13 Nov 2026)

**Result: no further trimming. A script now rebuilds the existing 28.1 MB skirmish pack from the Allied disc, byte for byte. Loading the music archive after start-up would cut the up-front download from about 28.1 MB to 17.7 MB raw, but needs a small code change; not implemented.**

Evidence labels: [obs] observed by running, [code] read from code, [inf] inferred, [est] estimate.

### Scope decision

The ticket asked for file logging, a file-by-file trimmed pack and play tests. Ticket 4a had already produced the inventory and a 28.1 MB pack that the owner has played in the browser. The conductor's guess (not measured) was that file-by-file trimming would save 1 to 3 MB [est]. Owner's decision, verbatim: "File sizes are acceptable as they are - reducing by under 5mb is not cost effective. No more trimming needed". So no logging was added, no new trimmed pack was made and no play tests were run; no C++ or CMake changes.

Inventory: see "Step 2: data size" > "What is inside the two archives" earlier in this file.

### Pack size

| File | Bytes |
|---|---:|
| MAIN.MIX | 6,060,518 |
| REDALERT.MIX | 11,650,760 |
| SCORES.MIX | 10,386,815 |
| Total | 28,098,093 |

Against 479,651,622 bytes for the original pair (MAIN.MIX 454,605,294 + REDALERT.MIX 25,046,328) [obs]. All three files are byte-identical (`cmp`) to `~/ra-data/skirmish-web`, checked by the worker and re-checked by the conductor [obs]. That is the pack the owner played, so no new play test was needed [inf].

### How to rebuild

```sh
scripts/make-skirmish-pack.sh ~/ra-data/full/allied/disc ~/ra-data/skirmish
```

- Arguments: the disc folder (MAIN.MIX, and REDALERT.MIX beside it or in `INSTALL/`), the output folder, and optionally the path to vanillamix (default `build-tools/vanillamix`; build command in the 4a notes, "Tool: vanillamix").
- Takes about 1 second; extracts only the entries it needs [obs].
- Refuses an output folder inside the repo, and leaves nothing in `~/.config` (vanillamix runs with a temporary `XDG_CONFIG_HOME`) [obs].
- Uses GNU `realpath -m`, so it needs GNU coreutils (not the macOS default) [inf].

### Download size as a web server would send it

| File | Raw bytes | gzip -9 bytes |
|---|---:|---:|
| vanillara.data | 28,098,196 | 20,959,980 |
| vanillara.wasm | 14,293,059 | 4,887,575 |
| vanillara.js | 455,640 | 102,569 |
| Total | 42,846,895 | 25,950,124 |

[obs] brotli is not installed, so it was not measured. The wasm is built with -O2 -g, so the hosted build could be smaller without debug info [inf].

### On-demand loading (worker C; full text in `~/ra-data/session7/ondemand.md`)

- Recommendation: load MAIN.MIX, REDALERT.MIX and the INI up front (about 17.7 MB raw instead of 28.1 MB) and fetch SCORES.MIX (10.4 MB) in the background after the game starts. Work size S. Not implemented.
- It does not work today without a code change [code; first three points re-checked by the conductor]: track availability is stored once by `ThemeClass::Scan()` (`redalert/theme.cpp:595-599`), called only at start-up right after SCORES.MIX is registered (`redalert/init.cpp:2365-2367`); an archive missing at start-up returns early from its constructor (`common/mixfile.h:277`) before it joins the archive list (`:347`); `Is_Allowed` rejects tracks whose flag is false (`theme.cpp:500`).
- Smallest change [inf]: one new function in `redalert/init.cpp` that does `new MFCD("SCORES.MIX", &FastKey)` then `ThemeClass::Scan()`, called by game code from a polling point (not from JavaScript, because of Asyncify).
- Delivery [inf]: JavaScript `fetch`, then `FS.writeFile` into the in-memory file system; write to a temporary name and rename when complete, so a half-written file is never opened. The phase 2 IndexedDB loader needs the same final step and can reuse it.
- Not recommended now: speech, terrain, voices and sound effects sit inside MAIN.MIX / REDALERT.MIX, so deferring them means repacking. EVA speech (2.0 MB) would be safe (silent when missing, `redalert/audio.cpp:740-741`) [code]; terrain is needed before the first frame and only an assert guards it (`redalert/display.cpp:371-380`) [code]; voices and effects are cached at start-up (`redalert/init.cpp:2662-2666`) [code]. Deferring speech plus the unused terrain set too would give about 14.7 MB up front, at M to L work for 3 MB more [est].
- Worker C was least sure of: the polling point and half-written files; whether heap growth copes with a 10 MB file written late; that the session 5 `theme.cpp` fix keeps "no tracks available" safe until music arrives. The gzip size of the 17.7 MB core alone was not measured.

### Open items

- Late-music loading as its own ticket (S).
- brotli size.
- Whether the hosted build should drop -g from the wasm.
- The Soviet disc's REDALERT.MIX was not compared with the Allied one (same size [obs]).
- Tiberian Dawn build is out of scope; this replaces the session 5 open item "Full Tiberian Dawn build".
- New folders outside the repo: `~/ra-data/skirmish` (duplicate of skirmish-web) and `~/ra-data/session7`; earlier leftover folders still stand.

### Hand-off (end of session 7)

Files changed: `scripts/make-skirmish-pack.sh` (new), SPIKE.md, CLAUDE.md; not committed at the time of writing. `build-web/` untouched.

## Session 8: Loader (15 Nov 2026)

**Result: a release web build now starts with no game data, gets it either from a hosted pack or from the player's own files, checks it, keeps it in the browser's IndexedDB and then starts the game. Second visits download nothing. The wasm shrank from 4.9 MB to 0.8 MB gzipped by dropping debug info. A small engine change pauses single-player games while the browser tab is hidden. Deployment (Cloudflare Pages for the page, Cloudflare R2 for the data) is still to do.**

Evidence labels: [obs] observed by running, [code] read from code, [inf] inferred, [est] estimate.

### What was built

Two local commits, not pushed:

- `a52d9d2` "[RA] Web: hold single-player game while the browser tab is hidden": `redalert/conquer.cpp`, 10 lines (see "Hidden tab" below).
- `25fdfb5` "Add web game-data loader and release build script": `web/index.html`, `web/loader.js`, `web/loader-config.json`, `scripts/build-web-release.sh`, `scripts/make-loader-config.py`, `scripts/serve-pack.py`.

### Release build and file sizes

`scripts/build-web-release.sh` builds into `build-release/` in about 30 s with 0 warnings and 0 errors [obs], then assembles `build-release/site/` (index.html, loader.js, loader-config.json, vanillara.js, vanillara.wasm). That folder is what gets uploaded later. There is no `.data` file any more; the script stops if one appears.

- Compile: `-DCMAKE_BUILD_TYPE=WebRelease` with `-O2 -DNDEBUG`. Link: `-O2 -sINVOKE_RUN=0 -sEXPORTED_RUNTIME_METHODS=FS,callMain,requestFullscreen`. No `WEB_DATA_DIR`. No CMake file was edited.
- Why a custom name "WebRelease": plain `Release` gets `-g` (debug info) added by `cmake/Compilers.cmake:31-33` [code]; a new build type name avoids that.
- `INVOKE_RUN=0` means the game does not start by itself when the page loads; the loader starts it with `callMain` once data is in place.

| File | Release raw | Release gzip -9 | Session 7 dev raw | Session 7 dev gzip -9 |
|---|---:|---:|---:|---:|
| vanillara.wasm | 2,778,028 | 822,050 | 14,293,059 | 4,887,575 |
| vanillara.js | 217,638 | 54,621 | 455,640 | 102,569 |
| Total | 2,995,666 | 876,671 | 14,748,699 | 4,990,144 |

[obs], measured on the final build. The session 7 build had debug info. brotli is still not measured.

### Loader config and how to regenerate it

`web/loader-config.json` holds no game data, only the list of accepted files:

- `dataSource`: "hosted" or "own-files-only". This is the setting that switches the hosted route off without code changes.
- `dataBaseUrl`: where the pack lives; currently `http://localhost:8001/packs/skirmish-v1/`.
- `packVersion`: "skirmish-v1". Changing it makes browsers download the pack again.
- `files`: the three pack files with size and SHA-256 (a fingerprint of the file's bytes): MAIN.MIX 6,060,518; REDALERT.MIX 11,650,760; SCORES.MIX 10,386,815.
- `ownFiles`: full original files the player may pick, each with a label: Allied MAIN.MIX 454,605,294; Soviet MAIN.MIX 500,577,414; REDALERT.MIX 25,046,328.

The Allied and Soviet REDALERT.MIX are byte-identical (same SHA-256) [obs], which closes the session 7 open item. The single entry is labelled "allied"; that is cosmetic.

Regenerate (usage comment in `scripts/make-loader-config.py`):

```sh
python3 scripts/make-loader-config.py ~/ra-data/skirmish skirmish-v1 \
    http://localhost:8001/packs/skirmish-v1/ hosted \
    allied=$HOME/ra-data/full/allied/disc/MAIN.MIX \
    soviet=$HOME/ra-data/full/soviet/disc/MAIN.MIX \
    allied=$HOME/ra-data/full/allied/disc/INSTALL/REDALERT.MIX \
    soviet=$HOME/ra-data/full/soviet/disc/INSTALL/REDALERT.MIX
```

Arguments: pack folder, pack version, base URL, data source, then any number of `label=path` originals. Originals with the same name and hash are listed once.

### How the loader works

`web/loader.js` is plain JavaScript, 314 lines [obs]:

1. Loads `vanillara.js` at once, so the wasm compiles while data arrives, and reads the config.
2. Uses data already in IndexedDB if it was downloaded for this `packVersion`, or if stored own files are still on the accepted list.
3. Otherwise downloads the hosted pack with a progress bar, or takes the player's files. Own files need MAIN.MIX + REDALERT.MIX, plus SCORES.MIX only with the pack MAIN.MIX (the full disc MAIN.MIX already contains the music).
4. Checks each file's size, then its SHA-256 (`crypto.subtle`, the browser's built-in crypto).
5. Saves to IndexedDB under keys like `pack:MAIN.MIX` or `allied:MAIN.MIX`, so both discs' MAIN.MIX can sit side by side later, and asks the browser for persistent storage (so it is not cleared under space pressure).
6. Writes the files and a REDALERT.INI (Windowed=yes, RawInput=no, PlayIntro=no, MultiplayerScoreVolume=0.25) to `/` in Emscripten's in-memory file system, enables Play; the click calls `Module.callMain([])`.

"Clear saved game data" deletes the database without reloading the page. If IndexedDB is unavailable, the loader carries on from memory and says the data will be needed again next visit.

Page contract (header of `web/loader.js`): the script uses only these element IDs, so the page can be redesigned freely as long as they exist.

| ID | Element | Role |
|---|---|---|
| `play` | button | starts the game; disabled until data is ready |
| `progress` | progress | download progress; hidden when idle |
| `status` | any text element | messages; `data-state` = working, ready or error |
| `own-files` | input type=file multiple | player-supplied data files |
| `clear-data` | button | deletes the saved data |
| `canvas` | canvas tabindex=-1 | the game screen |

The Fullscreen button in `index.html` is owned by the page (inline handler) and is not part of the contract.

### How to run both test servers

From the repo root, in two terminals, then open http://localhost:8000/ :

```sh
python3 -m http.server 8000 -d build-release/site
python3 scripts/serve-pack.py ~/ra-data/skirmish
```

`serve-pack.py` stands in for R2: it serves the folder at `/packs/skirmish-v1/` on port 8001 with `Access-Control-Allow-Origin: http://localhost:8000`. That header is CORS: the browser's rule that a page may only fetch from another address if that address allows it. To try the own-files route, set `dataSource` to "own-files-only" in `build-release/site/loader-config.json` (the copy, not `web/`).

The test rig (headless browser driver `drive.js`, `d.sh`, `pack.sh`) is kept in `build-release/probe-tools/` (git-ignored; never commit it).

### Test results

Worker B, headless Edge 157 driven over the DevTools protocol; all [obs]:

| Test | Result |
|---|---|
| First visit, hosted | 3 GETs, ready at 1.6 s, Play reaches the menu; only console errors are favicon 404s |
| Second visit | 0 GETs |
| Clear, then reload | 3 GETs again |
| Clear during download | no crash, no database left |
| Truncated SCORES.MIX | "smaller than expected" |
| One byte flipped | "damaged (checksum)" |
| Both damaged | Play disabled, 0 records stored |
| own-files-only | 0 requests to :8001; pack files reach the menu |
| Full Allied MAIN.MIX + REDALERT.MIX | about 13.6 s from picking to ready, then the menu; renderer memory peak about 740 MB |
| Stored own files, next visit | reload without picking |
| Demo MAIN.MIX | rejected, with its SHA-256 shown |

Damaged test copies are in `~/ra-data/session8/`. The owner then tested by hand: "when the tab is hidden the game freezes but then catches up on return (build progress jumps forward), so please make a hidden tab trigger the game's original focus-loss pause, web-only, and confirm the game clock no longer advances while hidden.All else runs correctly"

Fixes made after the owner's test, tested headless only, not yet seen by the owner: a failed own-file pick re-enables Play when data was already ready; a running download is cancelled only after picked files pass verification; a `versionchange` handler closes the database so "clear data" from another tab no longer stalls.

### Hidden tab: engine change

There was no gameplay pause on focus loss to trigger [code]. SDL already turns tab hiding and window blur into `Focus_Loss()` (`common/wwkeyboard_sdl2.cpp:93-96`), which only sets `GameInFocus=false` and mutes sound (`redalert/winstub.cpp:79-86`); `Main_Loop()` only skips drawing and input (`redalert/conquer.cpp` near 1798). So JavaScript alone could not fix it. The worker stopped as the ticket required, and the owner approved an engine change on 15 Nov 2026.

Change: in `Main_Loop()` after `Check_For_Focus_Loss();`, under `#ifdef __EMSCRIPTEN__`, a loop sleeps 250 ms at a time while `document.hidden` is true and the game is `GAME_NORMAL` or `GAME_SKIRMISH`, plus a guarded `#include "common/mssleep.h"`. Multiplayer is excluded: pausing one player would break the shared lockstep game.

Test (worker D) [obs]: a tank ordered on a long move; the page hidden for 22 s by activating a second tab (`document.hidden` confirmed true); on return the tank was in the same spot within a pixel or two, and 5 s later it had arrived. With the page visible and only the window blurred, drawing freezes but the game keeps running, as before.

### Decisions

- Own files are strict: they must match a listed hash. The error shows the file's hash so the list can be extended.
- The hosted download starts on page load.
- The committed config points at localhost:8001; changing `dataBaseUrl` to the R2 address is a deploy step.
- The Fullscreen button is page-owned.

### After the owner's second test

The owner, verbatim: "All appears to work - after exiting game refresh is still needed to play again"

Then, verbatim: "Exit and play is not a fix required now"

"All appears to work" covers the hidden-tab pause in a real browser and the three post-test loader fixes.
By the owner's decision, exit-and-replay was not changed: `web/loader.js` is still as committed in `25fdfb5`.

### Open items

- clang-format is not installed here: the new `conquer.cpp` lines were formatted by hand and CI's clang-format 14 check has not been run on them.
- Multiplayer not tested with the hidden-tab pause.
- After "Exit Game" the page must be refreshed to play again. A second `callMain` in the same page is not safe, because the program's globals are not reset. The likely fix is an automatic page reload that loads the data from browser storage.
- Soviet MAIN.MIX is hash-listed but not confirmed running in the browser. Other Red Alert editions are rejected by the strict list.
- Untested: the no-IndexedDB path (private window, full quota) and browsers other than Edge.
- The full-disc route holds about 740 MB in memory, probably too much for phones [inf].
- Saved games are not kept between visits (follow-up ticket: keep the user folder in IndexedDB).
- Deployment: R2 address in `dataBaseUrl`, CORS on R2 for the Pages origin, https.
- Late-music loading (session 7) and brotli size are still open.

Tips: plain `grep` here is ugrep and silently skips `redalert/conquer.cpp`; use `/usr/bin/grep`. Edge's debugging port listens only on the Windows side's 127.0.0.1, so the driver must run with Windows `node.exe`. Worker D found the owner's servers already running on :8000/:8001 and left them running.

### Hand-off (end of session 8)

Code commits `a52d9d2` and `25fdfb5`, then notes commits `4e1702a` and "Notes: session 8 owner confirmation"; nothing pushed. Tree clean after the notes commit. `build-release/` (including `probe-tools/`) and `~/ra-data/session8/` are outside version control.

## Session 9: Multiplayer (15 Nov 2026)

**Result: stage A of multiplayer works locally. Two browser pages joined the same room through a small relay, met in the game's own Network lobby and played one match on A Path Beyond for about 15 minutes with no out-of-sync box, no waiting dialog and no console errors. "Same game on both pages" rests on matching frame counters and the absence of the out-of-sync box: neither page was seen showing the other player's units. Tested only in headless Edge on one machine with two players. Hiding a tab for up to 30 s was harmless; at 60 s the game slowed to a crawl for both players but nobody was dropped.**

**Stage B result (16 Nov 2026): the page now has a multiplayer panel. One player presses Create game and shares an invite link; the other opens the link and joins. Both then meet in the game's own Network lobby as before. The relay has room rules (create or join on purpose, rooms close to new players at game start) and limits against abuse, plus a health check; it is ready to host but not deployed. Tested in two headless Edge instances on one machine: a match ran about 7 minutes with no out-of-sync box, no waiting dialog and no console errors; a late join to the started room was refused. As in stage A, neither page was seen showing the other player's units.**

Evidence labels: [obs] observed by running, [code] read from code, [inf] inferred, "not run" where nothing was tried.

### Ticket and approach

Ticket 8 "Multiplayer, iteration 1", branch `multiplayer`. Approach agreed by the owner: a browser version of the one transport class the game uses for LAN play, sending over a WebSocket (a lasting two-way connection between page and server), plus a small Node.js relay with rooms. Each room behaves like a LAN, so the game's lobby, retry and lockstep code stay unchanged. Browser-only (no mixing with desktop players).

- Stage A (this session) = prototype: relay, transport, join by `?room=CODE` in the page address, hidden-tab measurement.
- Gate: the owner tests before stage B (room rules, page flow, hidden-tab policy, relay ready to host).
- Method: conductor plus Opus workers (relay, transport, test, notes).

### Stage A: what was built

Two local commits, not pushed:

- `e2d0ba3` "Relay: stage A prototype (rooms, join by code, forward)". The conductor amended its message to fix the co-author line (it was `1de0b82`).
- `6fabed4` "[RA] Web: WebSocket relay transport (stage A prototype)".

Relay [code]: `relay/server.js` (123 lines), `package.json`, `package-lock.json`, `.gitignore` (node_modules), `test.js` (95 lines). Node.js with the `ws` package 8.23.0. Listens on env `HOST` (default 127.0.0.1) and `PORT` (default 8002). Logs only the listening address and room/client counts: no IP addresses, room codes or payloads. Room limits live in one `RULES` object plus `joinRefusal()`. Each room has unused `started` and `createdAt` fields ready for stage B.

Wire protocol v0 [code]:

- Connect `ws://HOST:PORT/?room=CODE`; CODE must match `^[A-Za-z0-9]{4,32}$`, else close code 4000.
- Stage A rooms are join-or-create. Ids 1..254 count up per room and are never reused. A 9th client is refused with close code 4001.
- First frame from the relay is text `{"t":"hello","id":N,"peers":[...]}`; the others get text `{"t":"join","id":N}` / `{"t":"leave","id":N}`.
- Game data is binary. Client to relay: byte 0 = destination id (0 = everyone else in the room). Relay to client: byte 0 = sender id. The rest is the payload, unchanged. No echo to the sender. Frames over 2048 bytes are dropped. A room is deleted when its last client leaves.
- Small deviations from the brief: a 1-byte frame (no payload) is dropped; a message to your own id is dropped; frames over 64 KB close the connection (a `ws` library limit).

Transport [code]: new `common/wspudp_web.cpp` (271 lines) implements the same `UDPInterfaceClass` (declared in `common/wspudp.h`) for the web. `common/CMakeLists.txt` (+7/-1) compiles it instead of `wspudp.cpp` when `EMSCRIPTEN`, the repo's usual "backend chosen by which file is compiled" pattern, so `redalert/init.cpp`, `netdlg.cpp`, `wspudp.h` and `wsproto.*` are unchanged.

- Uses the browser `WebSocket` through `EM_JS` (C++ calling inline JavaScript), arraybuffer frames, and a JavaScript-side receive queue capped at 4096 frames that the game drains when it polls.
- Relay id N appears to the game as address 10.0.0.N; broadcast goes to destination 0. The native game discards its own broadcasts; here the relay never echoes and the file drops any frame claiming to be from itself.
- Room code comes from `?room=CODE`. Relay address is `Module.relayUrl` if set, else `ws://<page hostname>:8002` (`wss://` when the page is https, an addition not in the brief). With no valid `room`, `Open_Socket` returns false. With one, it yields in 20 ms steps for up to 5 s waiting for the hello.
- Yield (the session 6 main risk, a lobby loop freezing the browser): when a poll received nothing and at least 10 ms have passed since the last yield, it sleeps 1 ms (`us_sleep`). No lobby loop froze on the screens tested [obs], but only those screens were exercised.
- Build with `scripts/build-web-release.sh`: 0 errors (warnings hidden by `-w`) [obs]. clang-format is not installed, so CI's format check was not run on the new file.

Max players [code]: 8. `MAX_PLAYERS 8` at `redalert/defines.h:3605`; `Rule.MaxPlayers(8)` at `redalert/rules.cpp:167`; rules.ini `[Maximums] Players` can override it at `redalert/rules.cpp:603`. The relay limit is also 8.

### Stage A: test results

All in headless Edge (no visible window), two separate browser instances (debug ports 9333/9334, separate profiles), [obs] unless marked.

- Relay self-test: 15 of 15 passed.
- Lobby (transport worker, throttling switched off): both pages with `?room=TEST01` reached the Network lobby; the host clicked "New"; page 2 saw "Noname's Game" and joined; the host's list showed the joiner "bravo".
- Match (test worker): host Noname and joiner bob on A Path Beyond, 20:38 to 20:53 (about 15 minutes). Host gave orders from 20:40 (deploy MCV, two power plants, group moves); joiner from 20:46 (deploy MCV, a power plant, group moves). Each side's orders worked on its own screen. No out-of-sync box, no waiting dialog, no console errors on either page.
- In a second match the game frame counter, read from memory at the same moment, was 23489 / 23483 (within 6 frames).
- NOT seen: one player's units on the other player's screen. "Same game on both pages" rests on the frame counters and the missing out-of-sync box.
- Speed: about 20.8 frames per second on both pages over 5-second intervals; a power plant took about 11 s; both pages responsive.
- Skirmish regression: with no `?room=`, a Skirmish game started and advanced at 21 fps.
- Not done: visible windows; two real machines; more than 2 players; latency through a remote relay.

### Hidden-tab measurements

Edge default throttling (the browser slowing timers in background tabs); the joiner's page hidden by activating a second tab, `document.hidden` true. [obs] unless marked.

- Throttling check: a silent hidden tab got 1 timer per second instead of about 10, so headless Edge throttles like a real browser. The game tab is spared while it plays sound (its audio is "running"); throttling began once it went quiet.
- 10 s hidden: host unaffected, about 17-20 fps, no stall, no dialog; the joiner caught up on return; both at 21 fps afterwards.
- 30 s hidden: host about 18 fps, no stall; the joiner caught up; both fine.
- 60 s hidden: throttled from about 30 s. The host slowed to about 1 fps and the joiner stopped. On return the joiner resumed at once, no out-of-sync box, nobody dropped; both back to 21 fps within 5 s.
- No reconnect dialog in the 60 s run: 28 s into the stall the host showed none (one screenshot only). From code (`redalert/queue.cpp:565-573, 2230-2248`) the dialog should appear after about 3 s with no packets and the player be dropped after roughly 15-30 s [code]. The worker's guess, not checked: the throttled tab still sends about once a second, which keeps the connection alive, so the game crawls instead of dropping the player. A run with the host's view uncovered also showed a near-freeze from about 30 s.
- An early 60 s run was tainted (a misplaced drag opened the host's Options menu) and was repeated cleanly.
- Not run: hiding for more than 5 minutes (Edge's harsher throttling, about one timer per minute, should lead to the drop path); hiding the host.
- Conductor's reading [inf]: short tab switches are harmless while the game is making sound; a longer absence slows everyone to a crawl rather than dropping the player. This feeds stage B item 7 (hidden-tab policy), which is the owner's decision.

### How to run the relay and test locally

Node is not on PATH in WSL; use Emscripten's bundled Node (it has npm). Four terminals from the repo root:

Since session 10, `scripts/start-local-mp.sh` starts all three servers (relay, site, data) in one go and skips any that are already running; the four commands below are what it runs.

```
cd relay && PATH=~/emsdk/node/24.19.0_64bit/bin:$PATH npm install     # once
HOST=127.0.0.1 PORT=8002 ~/emsdk/node/24.19.0_64bit/bin/node relay/server.js
python3 -m http.server 8000 -d build-release/site
python3 scripts/serve-pack.py ~/ra-data/skirmish
```

The relay must be running before Create game will work; `scripts/start-local-mp.sh` (or the second command above) starts it. Then (updated for stage B; the `?room=TEST01` address no longer creates a room):

1. Open `http://localhost:8000/` in two browser windows (not two tabs in one window, or one gets throttled).
2. In one window press Create game and copy the invite link.
3. Open the invite link in the other window.
4. In both windows press Play, then Multiplayer Game, Network.
5. One player picks "New", the other joins the listed game; the host starts it.

Relay self-test: `~/emsdk/node/24.19.0_64bit/bin/node relay/test.js`. The relay left running after stage A (pid 60273) was stopped on 16 Nov.

Test rig (git-ignored, `build-release/probe-tools/`): `drive2.js` (two-page driver: cropped screenshots, drag, pixel-change watch, window resize, raw devtools commands), `d2.sh`, `edge2.sh`, `edge3.sh`, `monitor.js`, `hide.js`, `throttle.js`, `trial.sh`, `mpstart.sh`, `killedge.ps1`. Caveats: the frame counter address (wasm 405664) is good for this build only; two screenshots at once on one page left it stuck at 640x400 until the window was resized (a test setup problem, not the game).

### Relay size

`relay/server.js` 123 lines and `relay/test.js` 95 lines, one dependency (`ws` 8.23.0) [code]. The transport file is 271 lines [code].

### Decisions

The conductor's; the owner may overrule:

- The transport is a second implementation of `UDPInterfaceClass` chosen in CMake, so `init.cpp` is untouched. The `common/CMakeLists.txt` source-list edit was treated as part of the transport.
- Stage A rooms are join-or-create.
- Relay port 8002.
- A fresh worker per task once a worker's context gets large.

### Open items

- Done (16 Nov 2026): the owner's own two-window test (the gate) passed.
- `Close_Socket` is not overridden, so the WebSocket closes only when the object is destroyed or the socket reopened.
- Relay join/leave messages are ignored by the game side.
- The yield's effect on frame rate is not isolated (20.8 fps in the match vs 21 in skirmish).
- Cross-screen visibility of the other player's units not confirmed.
- Hidden for over 5 minutes, and a hidden host: not run.
- clang-format check not run on `common/wspudp_web.cpp`.
- Done in stage B (16 Nov 2026): stage B items 5-8 (room rules, page flow with agreed element IDs, hidden-tab policy, relay ready to host). See "Stage B" below.

### Hand-off (stage A gate)

Code commits `e2d0ba3` and `6fabed4`, then the notes commit "Notes: session 9 multiplayer stage A"; nothing pushed. Tree clean after the notes commit. Next step: the owner's own test. Stage B only on the owner's approval.

### Stage B (16 Nov 2026)

Gate: on 16 Nov 2026 the owner reported that their own two-window test of stage A passed, and approved a written plan for stage B.

Method: conductor plus Opus workers. Three workers (relay, game side, page) worked in parallel to one fixed contract, then one test worker, then this notes worker.

#### Decisions

The owner's (16 Nov 2026):

- Hidden-tab policy: a notice only, no engine change.
- Page flow: a Create/Join panel on the page, then the game's own Network lobby.
- Relay hosting: prepare only. Nothing is deployed and no host is chosen.

The conductor's; the owner may overrule:

- The page opens the connection and the game adopts it. So errors such as "no such room" show on the page before the game starts.
- Rooms close to new players at game start.
- Commits carry the Fable 5.2 co-author line, though Opus workers wrote the code (the owner was told).

#### What was built

Four local commits, not pushed:

- `e9beded` "Relay: stage B room rules, limits, health check, hosting notes".
- `f20545d` "[RA] Web: game adopts the page's relay connection, signals game start".
- `6d1324c` "Web: multiplayer Create/Join panel and hidden-tab notice".
- `3325117` "Web: room code box accepts typing while the game runs".

Relay [code]: `relay/server.js` is now 245 lines and `relay/test.js` 265 lines. New `relay/README.md` (77 lines) covers environment variables (settings passed to a program when it starts), close codes, what is logged, and hosting notes. The hosting notes are untested.

- Limits, all in `RULES`, each settable by an environment variable: MAX_ROOMS 200; MAX_CLIENTS 800; MAX_PER_IP 16 (counted in memory, never logged; `TRUST_PROXY=1` reads the first `X-Forwarded-For` entry, for when the relay sits behind a proxy); MSGS_PER_SEC 600 and BYTES_PER_SEC 262144 per client (excess is dropped; 5 s over the limit closes with 4007; text frames count too); IDLE_MS 30 min; ROOM_MAX_AGE_MS 12 h (the room is removed at once, so its code can be reused); ALLOWED_ORIGINS (a list of web sites allowed to connect; empty = any, otherwise others get HTTP 403).
- A ping every 30 s drops dead connections.
- `GET /health` returns `{"ok":true,"rooms":N,"clients":N}`, so a host can check the relay is alive.
- SIGTERM/SIGINT (the stop signals) close all sockets and exit.
- Logging is still counts only.
- Worker's deviations from the contract: server state lives inside `start()`, so tests can run several small servers; `start()` takes overrides as a fourth argument; three extra test-only rules have no environment variable (`tickMs` 1000, `pingMs` 30000, `overLimitSecs` 5); MAX_CLIENTS maps to `RULES.maxTotalClients`.

Game side [code]: `common/wspudp_web.cpp` 40 insertions, 74 deletions.

- The page sets `Module.vcnetPre = { ws, id, room }`: a WebSocket that is already open and has had the relay's hello.
- The game adopts it when the player enters Multiplayer Game > Network. It adds one listener with `addEventListener` (the flag `ws.vcnetListening` stops a second one) and never closes the page's socket.
- The game no longer connects by itself: the `?room=` parsing, `Module.relayUrl` and the wait-for-hello loop are gone.
- With no room, `Open_Socket` returns false and logs "vcnet: not in a room; use Create game or Join game on the page". Ids outside 1..254 are refused.
- Unchanged: 10.0.0.N addresses, broadcast to 0, own-frame drop, 4096-frame queue cap, 1 ms yield.
- `redalert/init.cpp` +7 lines, web build only: at line 969, in `Select_Game`'s network branch, after `Remote_Connect()` returns true, it calls `Module.onNetGameStart()`. This runs on the host and on joiners.
- Release build: 0 errors [obs].

Page [code]:

- New `web/multiplayer.js` (201 lines, plus 4 for the typing fix). `web/index.html` +14 lines (the panel). `web/loader.js` +4 lines: it calls `window.vcMultiplayerInit(config, Module)` once the config is read.
- `web/loader-config.json` has two new settings: `"multiplayer": "on"` or `"off"` (off hides the panel and nothing connects), and `"relayUrl": ""` (empty = `ws://<page host>:8002`, or `wss://` on https pages).
- `scripts/make-loader-config.py` carries both settings over when it regenerates the config (missing = `"off"` and `""`). Not run, because it needs the original data files.
- `scripts/build-web-release.sh` now copies `multiplayer.js` into the site.

Element IDs the script uses:

| ID | What it is |
|---|---|
| `mp-panel` | container for the panel |
| `mp-create` | Create game button |
| `mp-code` | text box for a room code |
| `mp-join` | Join game button |
| `mp-leave` | Leave button |
| `mp-link` | read-only invite link |
| `mp-copy` | button that copies the link |
| `mp-status` | status text; `data-state` is idle, working, ready or error |
| `mp-notice` | hidden-tab notice |

Behaviour:

- Create makes a 6-character code from letters and digits, leaving out characters that look alike. If the code is taken it retries once.
- Join by a typed code (Enter works), or automatically when arriving by an invite link `…/?room=CODE`.
- The player count comes from the relay's hello/join/leave messages.
- Each close code, and a dropped connection, gets a plain message.
- At game start the page sends the lock.
- Hidden-tab notice: a permanent "keep this tab visible" line. While in a room the tab title changes when the tab is hidden. After more than 10 s hidden, a notice on return says for how long.

#### Protocol v1

Changes from v0 [code]; game data forwarding is unchanged:

- Connect `…/?room=CODE&mode=create|join`. Codes are case-insensitive.
- `mode=create` needs a new room, else close code 4002. `mode=join` needs an existing room, else 4003. No mode = join-or-create, as in stage A.
- A client text frame `{"t":"lock"}` marks the room started. Everyone gets `{"t":"locked"}`. Later joins are refused with 4004.
- New close codes: 4005 relay full; 4006 idle or room expired; 4007 sending too fast. 4000 and 4001 are unchanged.

#### Test results

Relay tests: 34 of 34 passed, the 15 stage A tests unchanged [obs].

Two headless Edge instances on one machine, all [obs]:

- Create gave a code, a link and "1 player connected".
- A made-up code gave "There is no room with that code…".
- Page 2 joined by the link and both showed "2 players connected".
- Both reached the Network lobby; the host chose New, the joiner "bob" joined, the host started.
- Both pages then said the room is closed. A Node script joining with `mode=join` was closed with 4004.
- The match ran about 7 minutes with orders on both sides: no out-of-sync box, no waiting dialog, 0 console errors. Both screens kept changing (17 and 18 pixel changes in 6 s).
- Hidden 15 s: the title changed, the notice said "hidden for 15 seconds", and the match continued.
- Skirmish with no room started and ran.
- With `"multiplayer": "off"` the panel was hidden and Skirmish started.
- First run failed one check: with the game running, typing in `mp-code` showed nothing, because the engine takes the keyboard. Fixed in `3325117` by stopping key events on `mp-code` and `mp-link` from reaching the game (4 lines). Re-test: typed characters appeared, Enter gave the no-room message, and Escape on the canvas still opened the game's Options menu.
- NOT seen (same as stage A): one player's units on the other player's screen.
- Not run: visible windows, two real machines, more than 2 players, a remote relay, the README's hosting steps, clang-format on the C++ file.

#### Open items

- The owner's own test of the new flow.
- Choose a host and deploy the relay with `wss://` (the encrypted WebSocket, needed on https pages).
- If the connection drops during a match, the game itself is not told; only the page shows it [code].
- A player who drops out of a started match cannot rejoin, because the room is locked. Rejoin was outside stage B.
- The panel sits below the game and needs scrolling on a small window. Layout is the owner's call.
- Hidden for more than 5 minutes, and a hidden host: still not run.
- Latency through a remote relay not measured.
- Carried over from stage A: cross-screen visibility of the other player's units not confirmed; the yield's effect on frame rate not isolated; clang-format check not run on `common/wspudp_web.cpp`.

#### Hand-off

Code commits `e9beded`, `f20545d`, `6d1324c`, `3325117`, then the notes commit "Notes: session 9 multiplayer stage B"; nothing pushed. Tree clean after the notes commit. The site and data servers on ports 8000/8001 were left running (not started by this session's workers). No relay is running.

## Session 10: Multiplayer checks (16 Nov 2026)

**Result:** Create game failed only because the relay (the small server that passes messages between players) was not running; it was not a code bug. A new script, `scripts/start-local-mp.sh`, now starts all three local servers. With the relay up, a pair of screenshots taken at the same moment shows both players in one shared game, seeing the same units at the same map spots, which closes the "cross-screen visibility" item from sessions 9A and 9B. A 3-player match then ran for about 6 minutes with no out-of-sync box, no waiting dialog and no console errors. The owner's own test then passed with two real players and one computer player.

### Why Create game failed

- [obs] The owner pressed Create game and got "Could not connect to the multiplayer server. Check your connection and try again."
- [obs] Ports 8000 (site) and 8001 (data) were listening; nothing was on 8002, so the relay was not running.
- [obs] The page config was correct: `"multiplayer": "on"`, `relayUrl` empty (empty means "use the local relay").
- Not a code bug: session 9 ended with no relay running (see its hand-off).

### Start-up script

- Commit `cca8ba6` "Scripts: start local multiplayer servers": one new file, `scripts/start-local-mp.sh` (27 lines, executable). It was first committed as `b3d6332`; the conductor amended the message to restore the agreed co-author line.
- [obs] It started the relay on 8002 and skipped the site (8000) and data (8001) servers, which were already up. Logs go to `/tmp/vc-*.log`.
- [obs] It prints the relay's health check (a status address that answers "am I alive"): `{"ok":true,"rooms":0,"clients":0}`.
- [obs] Conductor's check: the commit holds only that file; tree clean.
- [obs] `mp-create` (the Create game button) then gave room 2CLFNL, the invite link and `data-state="ready"`.

### One shared game: the proof

- [obs] 2 players on "Keep off the Grass (Sm)", crates off. Each screenshot pair was taken at the same moment. The two views differ only by a 22-pixel scroll, checked against a wall corner and a gem field.
- [obs] `pairBA-B.png`: B's screen shows A's Construction Yard, tank and rifleman.
- [obs] `pairBA-A.png`: the same three at the same map spots on A's screen. A's yard was the only building; B's MCV would not deploy.
- [obs] The conductor opened both files and saw the same gold Construction Yard, tank and rifleman beside the same wall corner and gem field, with B's blue units also in view on both.
- [obs] Other direction: `r2-A7zoom.png` / `r2-B7zoom.png` show B's grenadier beside the wall corner, same spot on both screens.
- [obs] A first attempt (`s3-*.png`) was confusing: A's units vanished, then A got "Mission failed" and B a score screen.
- [inf] One side losing while the other sees the score screen is what a normal win/lose looks like in one shared game. Whether it was a desync (the two games drifting apart) or just combat was not checked.
- Shots are in `build-release/probe-tools/shots/`, which is git-ignored and not part of the repo.

### 3-player match

- [obs] 3 pages (ports 9333/9334/9335), room VJG8VQ, about 6 minutes, 5 rounds of move orders from every player.
- [obs] On every page: no out-of-sync box, no waiting or reconnect dialog, 0 console errors (only missing-favicon 404s, which are harmless).
- [obs] Each panel read "3 players connected. The game has started and the room is closed to new players."
- End shots: `m3-end-9333.png`, `m3-end-9334.png`, `m3-end-9335.png`.
- Frame rate was not measured: the frame counter address in the rig is stale for this build.

### The owner's own test (16 Nov 2026)

Reported by the owner after the relay was started; not seen by a worker.

- Two real players (Russia and Ukraine) plus one computer-controlled player (an Allied side) in one match, using the Create game / invite link flow.
- The game ran well. Movements were tracked on both screens and units interacted correctly.
- This is the first match with a computer player in it, and the first cross-screen check made in real, visible browser windows.
- Not stated by the owner: which map, how long the match ran, and whether the two windows were on one machine or two.

### Not run / not proven

- 4 players (skipped to save budget).
- Frame rate in multiplayer.
- Two real machines, a remote relay. (Visible windows: covered by the owner's own test.)
- Whether the first 2-player attempt was a desync.

### Open items

- Done (16 Nov 2026): the owner's own two-window test of the Create/Join flow passed; see "The owner's own test" above.
- First 2-player attempt ended early; cause not established.
- B's MCV would not deploy in the second attempt; cause not established (may be the test's click, or blocked ground).
- Choose a host and deploy the relay with `wss://` (the encrypted WebSocket, needed on https pages).
- If the connection drops during a match, the game itself is not told; only the page shows it [code].
- A player who drops out of a started match cannot rejoin, because the room is locked.
- The panel sits below the game and needs scrolling on a small window. Layout is the owner's call.
- Hidden for more than 5 minutes, and a hidden host: still not run.
- Latency through a remote relay not measured.
- Carried over from stage A: the yield's effect on frame rate not isolated; clang-format check not run on `common/wspudp_web.cpp`.
- Done: cross-screen visibility of the other player's units (see "One shared game: the proof").

### Rig notes

- `d3.sh` saves screenshots to `shots/`; `mpstart2.sh` / `mp3.sh` start 2- and 3-player matches.
- Arrow keys don't scroll the map; screen-edge mouse scrolling does, very fast.
- In `drive2.js`, `key=` digits don't type.
- The frame counter address (wasm 405664) is stale for this build.

### Hand-off

Commits `cca8ba6`, then the notes commits "Notes: session 10 multiplayer checks" and "Notes: session 10 owner's test passed"; nothing pushed. The relay (8002), site (8000) and data (8001) servers were left running for the owner's two-window test. The headless Edge instances were closed.
