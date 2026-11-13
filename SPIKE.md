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

### Open items

1. The higher-resolution ticket (above).
2. clang-format 14 not run on any changed file, including `common/video_sdl2.cpp` (it may reformat the `EM_ASM` block).
3. Full Tiberian Dawn build and the CI presets not run.
4. Still open from 4a: whether native music was heard in the skirmish itself or only at the menu; the leftover folders `~/.config/vanilla-conquer/vanillatools/`, `~/ra-data/allied-extract`, `~/ra-data/skirmish-min-build`, `~/ra-data/smoke-min`, `~/ra-data/smoke-full`.
5. If the crash returns: the rigged-crate reproduction from the 4a hand-off is still available as a follow-up.

### Hand-off (end of session 5)

State (checked by the conductor): `build-web/` holds the current build with the normal `skirmish-web` data; nothing listening on ports 8000-8009. Files changed this session: `common/video_sdl2.cpp`, `redalert/drive.cpp`, `redalert/theme.cpp`, `tiberiandawn/theme.cpp`, `SPIKE.md`. These were committed at the end of the session (owner's choice: "Worker commits"); not pushed. As before, `build-web/` must never be committed, uploaded or deployed while `vanillara.data` is in it.

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

1. Higher-resolution ticket: read-only scoping pass first.
2. clang-format 14 check on the changed files; full Tiberian Dawn build and CI presets.
3. The 4a leftovers: the native music question and the leftover folders.

To play the current build in the browser:

```sh
# Serve the build-web folder on this machine only, at port 8000
python3 -m http.server 8000 --bind 127.0.0.1 --directory build-web
```

Then open http://localhost:8000/vanillara.html.
